const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');
const https = require('https');
const jwt = require('jsonwebtoken');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const ssm = new AWS.SSM();

// JWT secret will be loaded from SSM Parameter Store
let JWT_SECRET;
let GOOGLE_CLIENT_ID;

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  try {
    // Load secrets from SSM if not cached
    if (!JWT_SECRET) {
      JWT_SECRET = await getParameter('/snapitqr/jwt-secret');
    }
    if (!GOOGLE_CLIENT_ID) {
      GOOGLE_CLIENT_ID = await getParameter('/snapitqr/google-client-id');
    }

    const path = event.resource;
    const method = event.httpMethod;

    // CORS headers
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Content-Type': 'application/json'
    };

    // Handle OPTIONS for CORS
    if (method === 'OPTIONS') {
      return { statusCode: 200, headers, body: '' };
    }

    // Route to appropriate handler
    if (path === '/auth/google' && method === 'POST') {
      return await handleGoogleAuth(event, headers);
    } else if (path === '/auth/me' && method === 'GET') {
      return await getCurrentUser(event, headers);
    } else if (path === '/auth/refresh' && method === 'POST') {
      return await refreshToken(event, headers);
    }

    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Not found' })
    };

  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        error: 'Internal server error',
        message: error.message
      })
    };
  }
};

async function handleGoogleAuth(event, headers) {
  const body = JSON.parse(event.body || '{}');
  const { idToken } = body;

  if (!idToken) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'ID token is required' })
    };
  }

  // Verify Google ID token
  const googleUser = await verifyGoogleToken(idToken);

  if (!googleUser) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: 'Invalid Google token' })
    };
  }

  // Check if user exists
  const existingUser = await dynamodb.query({
    TableName: 'snapitqr-users',
    IndexName: 'email-index',
    KeyConditionExpression: 'email = :email',
    ExpressionAttributeValues: {
      ':email': googleUser.email
    }
  }).promise();

  let user;

  if (existingUser.Items && existingUser.Items.length > 0) {
    // User exists, update last login
    user = existingUser.Items[0];
    await dynamodb.update({
      TableName: 'snapitqr-users',
      Key: { userId: user.userId },
      UpdateExpression: 'SET lastLoginAt = :lastLoginAt, googleId = :googleId',
      ExpressionAttributeValues: {
        ':lastLoginAt': new Date().toISOString(),
        ':googleId': googleUser.sub
      }
    }).promise();
  } else {
    // Create new user
    const userId = uuidv4();
    user = {
      userId,
      email: googleUser.email,
      name: googleUser.name,
      picture: googleUser.picture,
      googleId: googleUser.sub,
      tier: 'free',
      usage: {
        staticQRs: 0,
        dynamicQRs: 0,
        shortURLs: 0,
        apiCalls: 0
      },
      usageLimits: {
        staticQRs: Infinity,
        dynamicQRs: 3,
        shortURLs: 100,
        apiCalls: 0
      },
      createdAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
      status: 'active'
    };

    await dynamodb.put({
      TableName: 'snapitqr-users',
      Item: user
    }).promise();

    // Track analytics event
    await trackAnalyticsEvent({
      eventType: 'user_signup',
      userId,
      metadata: {
        provider: 'google',
        email: googleUser.email
      }
    });
  }

  // Generate JWT token
  const token = jwt.sign(
    {
      userId: user.userId,
      email: user.email,
      tier: user.tier,
      stripeCustomerId: user.stripeCustomerId
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  // Track login event
  await trackAnalyticsEvent({
    eventType: 'user_login',
    userId: user.userId,
    metadata: {
      provider: 'google'
    }
  });

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      token,
      user: {
        userId: user.userId,
        email: user.email,
        name: user.name,
        picture: user.picture,
        tier: user.tier,
        usage: user.usage,
        usageLimits: user.usageLimits
      }
    })
  };
}

async function getCurrentUser(event, headers) {
  const authHeader = event.headers.Authorization || event.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: 'No token provided' })
    };
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Get user from database
    const result = await dynamodb.get({
      TableName: 'snapitqr-users',
      Key: { userId: decoded.userId }
    }).promise();

    if (!result.Item) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'User not found' })
      };
    }

    const user = result.Item;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        user: {
          userId: user.userId,
          email: user.email,
          name: user.name,
          picture: user.picture,
          tier: user.tier,
          usage: user.usage,
          usageLimits: user.usageLimits,
          stripeCustomerId: user.stripeCustomerId,
          subscriptionStatus: user.subscriptionStatus
        }
      })
    };
  } catch (error) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: 'Invalid token' })
    };
  }
}

async function refreshToken(event, headers) {
  const authHeader = event.headers.Authorization || event.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: 'No token provided' })
    };
  }

  const token = authHeader.substring(7);

  try {
    // Verify old token (even if expired)
    const decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });

    // Get user from database
    const result = await dynamodb.get({
      TableName: 'snapitqr-users',
      Key: { userId: decoded.userId }
    }).promise();

    if (!result.Item) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'User not found' })
      };
    }

    const user = result.Item;

    // Generate new token
    const newToken = jwt.sign(
      {
        userId: user.userId,
        email: user.email,
        tier: user.tier,
        stripeCustomerId: user.stripeCustomerId
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        token: newToken
      })
    };
  } catch (error) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: 'Invalid token' })
    };
  }
}

async function verifyGoogleToken(idToken) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'oauth2.googleapis.com',
      path: '/tokeninfo?id_token=' + idToken,
      method: 'GET'
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);

          // Verify audience matches our client ID
          if (parsed.aud !== GOOGLE_CLIENT_ID) {
            console.error('Invalid audience:', parsed.aud);
            resolve(null);
            return;
          }

          // Verify email is verified
          if (parsed.email_verified !== 'true') {
            console.error('Email not verified');
            resolve(null);
            return;
          }

          resolve({
            sub: parsed.sub,
            email: parsed.email,
            name: parsed.name,
            picture: parsed.picture
          });
        } catch (error) {
          console.error('Error parsing Google response:', error);
          resolve(null);
        }
      });
    });

    req.on('error', (error) => {
      console.error('Error verifying Google token:', error);
      resolve(null);
    });

    req.end();
  });
}

async function getParameter(name) {
  const result = await ssm.getParameter({
    Name: name,
    WithDecryption: true
  }).promise();

  return result.Parameter.Value;
}

async function trackAnalyticsEvent(event) {
  const eventId = uuidv4();
  const now = new Date();
  const ttl = Math.floor(now.getTime() / 1000) + (365 * 24 * 60 * 60); // 1 year TTL

  await dynamodb.put({
    TableName: 'snapitqr-analytics',
    Item: {
      eventId,
      ...event,
      timestamp: now.toISOString(),
      ttl
    }
  }).promise();
}
