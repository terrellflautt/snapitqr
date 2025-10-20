const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient();

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  try {
    const path = event.resource;
    const method = event.httpMethod;
    const userId = event.requestContext.authorizer?.userId;

    // CORS headers
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
      'Content-Type': 'application/json'
    };

    // Handle OPTIONS for CORS
    if (method === 'OPTIONS') {
      return { statusCode: 200, headers, body: '' };
    }

    if (!userId) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Unauthorized' })
      };
    }

    // Route to appropriate handler
    if (path === '/user/usage' && method === 'GET') {
      return await getUserUsage(userId, headers);
    } else if (path === '/user/profile' && method === 'GET') {
      return await getUserProfile(userId, headers);
    } else if (path === '/user/profile' && method === 'PUT') {
      return await updateUserProfile(event, userId, headers);
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

async function getUserUsage(userId, headers) {
  const result = await dynamodb.get({
    TableName: 'snapitqr-users',
    Key: { userId }
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
      usage: user.usage || {},
      usageLimits: user.usageLimits || {},
      tier: user.tier || 'free',
      subscriptionStatus: user.subscriptionStatus
    })
  };
}

async function getUserProfile(userId, headers) {
  const result = await dynamodb.get({
    TableName: 'snapitqr-users',
    Key: { userId }
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
        subscriptionStatus: user.subscriptionStatus,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt
      }
    })
  };
}

async function updateUserProfile(event, userId, headers) {
  const body = JSON.parse(event.body || '{}');
  const { name, preferences } = body;

  const updateExpression = [];
  const expressionAttributeValues = {};

  if (name) {
    updateExpression.push('name = :name');
    expressionAttributeValues[':name'] = name;
  }

  if (preferences) {
    updateExpression.push('preferences = :preferences');
    expressionAttributeValues[':preferences'] = preferences;
  }

  if (updateExpression.length === 0) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'No fields to update' })
    };
  }

  await dynamodb.update({
    TableName: 'snapitqr-users',
    Key: { userId },
    UpdateExpression: `SET ${updateExpression.join(', ')}`,
    ExpressionAttributeValues: expressionAttributeValues
  }).promise();

  // Get updated user
  const result = await dynamodb.get({
    TableName: 'snapitqr-users',
    Key: { userId }
  }).promise();

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      user: result.Item
    })
  };
}
