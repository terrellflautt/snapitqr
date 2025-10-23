const AWS = require('aws-sdk');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const rateLimiter = require('./rate-limiter');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();
const JWT_SECRET = process.env.JWT_SECRET;

const TIER_LIMITS = {
  free: {
    dynamicQRs: 1,
    staticQRs: Infinity
  },
  core: {
    dynamicQRs: 50,
    staticQRs: Infinity
  },
  growth: {
    dynamicQRs: 500,
    staticQRs: Infinity
  },
  business: {
    dynamicQRs: Infinity,
    staticQRs: Infinity
  }
};

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  try {
    const path = event.resource;
    const method = event.httpMethod;
    let userId = event.requestContext.authorizer?.userId;
    let userTier = event.requestContext.authorizer?.tier || 'free';

    // If no authorizer context, try to decode JWT from Authorization header
    if (!userId) {
      const authHeader = event.headers?.Authorization || event.headers?.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          const token = authHeader.substring(7);
          const decoded = jwt.verify(token, JWT_SECRET);
          userId = decoded.userId || decoded.sub;
          userTier = decoded.tier || 'free';
        } catch (jwtError) {
          console.log('JWT verification failed:', jwtError.message);
          // userId remains undefined - will be treated as anonymous
        }
      }
    }

    // CORS headers
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Content-Type': 'application/json'
    };

    // Handle OPTIONS for CORS
    if (method === 'OPTIONS') {
      return { statusCode: 200, headers, body: '' };
    }

    // Route to appropriate handler
    const resource = event.resource || path;
    const pathParams = event.pathParameters || {};

    // Redirect handler for dynamic QR codes (no auth required)
    if ((resource === '/r/{id}' || path.startsWith('/r/')) && pathParams.id && method === 'GET') {
      return await redirectQRCode(event);
    }

    if ((path === '/qr/generate' || path === '/generate' || path === '/qr-codes' || resource === '/qr-codes') && method === 'POST') {
      return await generateQRCode(event, userId, userTier, headers);
    } else if ((path === '/qr/list' || path === '/qr-codes' || resource === '/qr-codes') && method === 'GET') {
      return await listQRCodes(event, userId, headers);
    } else if ((resource === '/qr/{id}' || resource === '/qr-codes/{id}') && pathParams.id && method === 'GET') {
      return await getQRCode(event, headers);
    } else if ((resource === '/qr/{id}' || resource === '/qr-codes/{id}') && pathParams.id && method === 'PUT') {
      return await updateQRCode(event, userId, userTier, headers);
    } else if ((resource === '/qr/{id}' || resource === '/qr-codes/{id}') && pathParams.id && method === 'DELETE') {
      return await deleteQRCode(event, userId, headers);
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

async function generateQRCode(event, userId, userTier, headers) {
  const body = JSON.parse(event.body || '{}');
  const { content, type, customization, name } = body;

  if (!content) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Content is required' })
    };
  }

  const qrType = type || 'static';

  // For anonymous users, check IP-based rate limits
  if (!userId || userId === 'anonymous') {
    const sourceIp = event.requestContext.identity.sourceIp;
    const userAgent = event.headers?.['User-Agent'] || 'Unknown';
    const country = event.headers?.['CloudFront-Viewer-Country'] || 'Unknown';

    const rateCheck = await rateLimiter.checkRateLimit(sourceIp, 'qr', userAgent, country);

    if (!rateCheck.allowed) {
      return {
        statusCode: 429,
        headers,
        body: JSON.stringify({
          error: rateCheck.error,
          message: rateCheck.message,
          limits: rateCheck.limits,
          suggestion: rateCheck.suggestion,
          retryAfter: 3600
        })
      };
    }

    // Add usage info to response headers
    headers['X-Rate-Limit-Hourly-Limit'] = rateCheck.usage.hourly.limit;
    headers['X-Rate-Limit-Hourly-Remaining'] = rateCheck.usage.hourly.remaining;
    headers['X-Rate-Limit-Daily-Limit'] = rateCheck.usage.daily.limit;
    headers['X-Rate-Limit-Daily-Remaining'] = rateCheck.usage.daily.remaining;
  }

  // For authenticated users with dynamic QR codes, check tier-based usage limits
  if (qrType === 'dynamic' && userId && userId !== 'anonymous') {
    const usage = await checkUsageLimit(userId, 'dynamicQRs', userTier);
    if (!usage.allowed) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error: usage.message,
          usage: usage.current,
          limit: usage.limit,
          upgradeRequired: true
        })
      };
    }
  }

  // Generate QR code
  const qrId = uuidv4();
  const options = {
    errorCorrectionLevel: customization?.errorCorrection || 'M',
    type: 'image/png',
    width: customization?.size || 300,
    margin: customization?.margin || 4,
    color: {
      dark: customization?.foregroundColor || '#000000',
      light: customization?.backgroundColor || '#FFFFFF'
    }
  };

  let qrContent = content;

  // For dynamic QR codes, create a redirect URL
  if (qrType === 'dynamic') {
    qrContent = `https://api.snapitqr.com/r/${qrId}`;
  }

  // Generate QR code image
  const qrBuffer = await QRCode.toBuffer(qrContent, options);

  // Upload to S3
  const s3Key = `qr-codes/${qrId}.png`;
  await s3.putObject({
    Bucket: process.env.S3_BUCKET || 'snapitqr-assets',
    Key: s3Key,
    Body: qrBuffer,
    ContentType: 'image/png'
  }).promise();

  const qrUrl = `https://${process.env.S3_BUCKET || 'snapitqr-assets'}.s3.amazonaws.com/${s3Key}`;

  // Save to DynamoDB
  const now = Date.now();
  const qrRecord = {
    qrId,
    userId: userId || 'anonymous',
    type: qrType,
    content: qrType === 'dynamic' ? content : qrContent,
    redirectUrl: qrType === 'dynamic' ? qrContent : undefined,
    name: name || `QR Code ${new Date().toISOString()}`,
    qrUrl,
    customization: customization || {},
    createdAt: now,
    updatedAt: now,
    scans: 0,
    status: 'active'
  };

  await dynamodb.put({
    TableName: 'snapitqr-qrcodes',
    Item: qrRecord
  }).promise();

  // Increment usage for dynamic QR codes
  if (qrType === 'dynamic' && userId) {
    await incrementUsage(userId, 'dynamicQRs');
  }

  // Track analytics event
  await trackAnalyticsEvent({
    eventType: 'qr_created',
    qrId,
    userId: userId || 'anonymous',
    metadata: { type: qrType, tier: userTier }
  });

  // Record action for rate limiting (async, don't wait)
  if (!userId || userId === 'anonymous') {
    const sourceIp = event.requestContext.identity.sourceIp;
    rateLimiter.recordAction(sourceIp, 'qr', userId || 'anonymous', {
      qrId,
      type: qrType
    }).catch(err => console.error('Failed to record rate limit action:', err));
  }

  return {
    statusCode: 201,
    headers,
    body: JSON.stringify({
      success: true,
      qrId,
      qrUrl,
      type: qrType,
      redirectUrl: qrType === 'dynamic' ? qrContent : undefined,
      message: qrType === 'static'
        ? 'Static QR code generated successfully'
        : 'Dynamic QR code generated successfully'
    })
  };
}

async function listQRCodes(event, userId, headers) {
  if (!userId) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: 'Authentication required' })
    };
  }

  const params = {
    TableName: 'snapitqr-qrcodes',
    IndexName: 'userId-createdAt-index',
    KeyConditionExpression: 'userId = :userId',
    ExpressionAttributeValues: {
      ':userId': userId
    },
    ScanIndexForward: false // Most recent first
  };

  const result = await dynamodb.query(params).promise();

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      qrCodes: result.Items,
      count: result.Count
    })
  };
}

async function getQRCode(event, headers) {
  const qrId = event.pathParameters.id;

  // Table has composite key (qrId + userId), so we need to scan for public access
  const result = await dynamodb.scan({
    TableName: 'snapitqr-qrcodes',
    FilterExpression: 'qrId = :qrId',
    ExpressionAttributeValues: {
      ':qrId': qrId
    },
    Limit: 1
  }).promise();

  const item = result.Items && result.Items.length > 0 ? result.Items[0] : null;

  if (!item) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'QR code not found' })
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      qrCode: item
    })
  };
}

async function updateQRCode(event, userId, userTier, headers) {
  if (!userId || userId === 'anonymous') {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: 'Authentication required to edit QR codes' })
    };
  }

  const qrId = event.pathParameters.id;
  const body = JSON.parse(event.body || '{}');

  // Try to get QR code with current userId first
  let existing = await dynamodb.get({
    TableName: 'snapitqr-qrcodes',
    Key: { qrId, userId }
  }).promise();

  // If not found, check if it exists with anonymous userId (for migration)
  if (!existing.Item) {
    const anonymousCheck = await dynamodb.get({
      TableName: 'snapitqr-qrcodes',
      Key: { qrId, userId: 'anonymous' }
    }).promise();

    if (anonymousCheck.Item) {
      // Migrate anonymous QR code to current user
      await dynamodb.delete({
        TableName: 'snapitqr-qrcodes',
        Key: { qrId, userId: 'anonymous' }
      }).promise();

      anonymousCheck.Item.userId = userId;

      await dynamodb.put({
        TableName: 'snapitqr-qrcodes',
        Item: anonymousCheck.Item
      }).promise();

      existing.Item = anonymousCheck.Item;
    }
  }

  if (!existing.Item) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'QR code not found' })
    };
  }

  // Check ownership (should always match after migration above)
  if (existing.Item.userId !== userId) {
    return {
      statusCode: 403,
      headers,
      body: JSON.stringify({ error: 'Access denied' })
    };
  }

  const isConvertingToDynamic = existing.Item.type === 'static' && body.content;
  const isEditingDynamic = existing.Item.type === 'dynamic' && body.content;

  // If converting static to dynamic, check usage limits
  if (isConvertingToDynamic) {
    const usage = await checkUsageLimit(userId, 'dynamicQRs', userTier || 'free');
    if (!usage.allowed) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error: usage.message,
          usage: usage.current,
          limit: usage.limit,
          upgradeRequired: true,
          upgradeUrl: 'https://snapitqr.com/#pricing'
        })
      };
    }
  }

  // For free tier, enforce once-per-day edit limit on dynamic QR codes
  if (isEditingDynamic && userTier === 'free') {
    const lastEditedAt = existing.Item.lastEditedAt || existing.Item.updatedAt || existing.Item.createdAt;
    const now = Date.now();
    const hoursSinceLastEdit = (now - lastEditedAt) / (1000 * 60 * 60);

    if (hoursSinceLastEdit < 24) {
      const hoursRemaining = Math.ceil(24 - hoursSinceLastEdit);
      return {
        statusCode: 429,
        headers,
        body: JSON.stringify({
          error: `Free tier allows editing dynamic QR codes once per day. Please wait ${hoursRemaining} hour(s) or upgrade for unlimited edits.`,
          hoursRemaining,
          upgradeRequired: true,
          upgradeUrl: 'https://snapitqr.com/#pricing'
        })
      };
    }
  }

  // Update the content
  const updateExpression = [];
  const expressionAttributeValues = {};
  const expressionAttributeNames = {};

  if (body.content) {
    updateExpression.push('#content = :content');
    expressionAttributeNames['#content'] = 'content';
    expressionAttributeValues[':content'] = body.content;

    // If converting to dynamic, create redirect URL and update type
    if (isConvertingToDynamic) {
      const redirectUrl = `https://api.snapitqr.com/r/${qrId}`;
      updateExpression.push('redirectUrl = :redirectUrl');
      expressionAttributeValues[':redirectUrl'] = redirectUrl;
      updateExpression.push('#type = :type');
      expressionAttributeNames['#type'] = 'type';
      expressionAttributeValues[':type'] = 'dynamic';
    }
  }

  if (body.name) {
    updateExpression.push('#name = :name');
    expressionAttributeNames['#name'] = 'name';
    expressionAttributeValues[':name'] = body.name;
  }

  if (body.status) {
    updateExpression.push('#status = :status');
    expressionAttributeNames['#status'] = 'status';
    expressionAttributeValues[':status'] = body.status;
  }

  if (body.customization) {
    updateExpression.push('customization = :customization');
    expressionAttributeValues[':customization'] = body.customization;
  }

  updateExpression.push('updatedAt = :updatedAt');
  expressionAttributeValues[':updatedAt'] = Date.now();

  // Track lastEditedAt for rate limiting (only when content changes)
  if (body.content) {
    updateExpression.push('lastEditedAt = :lastEditedAt');
    expressionAttributeValues[':lastEditedAt'] = Date.now();
  }

  await dynamodb.update({
    TableName: 'snapitqr-qrcodes',
    Key: { qrId, userId },
    UpdateExpression: 'SET ' + updateExpression.join(', '),
    ExpressionAttributeNames: Object.keys(expressionAttributeNames).length > 0 ? expressionAttributeNames : undefined,
    ExpressionAttributeValues: expressionAttributeValues
  }).promise();

  // Increment usage count if converting to dynamic
  if (isConvertingToDynamic) {
    await incrementUsage(userId, 'dynamicQRs');
  }

  // Track analytics event
  await trackAnalyticsEvent({
    eventType: isConvertingToDynamic ? 'qr_converted_to_dynamic' : 'qr_updated',
    qrId,
    userId,
    metadata: { changes: Object.keys(body), wasStatic: isConvertingToDynamic }
  });

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      message: isConvertingToDynamic
        ? 'QR code converted to dynamic successfully'
        : 'QR code updated successfully',
      convertedToDynamic: isConvertingToDynamic
    })
  };
}

async function deleteQRCode(event, userId, headers) {
  if (!userId) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: 'Authentication required' })
    };
  }

  const qrId = event.pathParameters.id;

  // Get existing QR code (table has composite key: qrId + userId)
  const existing = await dynamodb.get({
    TableName: 'snapitqr-qrcodes',
    Key: { qrId, userId }
  }).promise();

  if (!existing.Item) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'QR code not found' })
    };
  }

  // Check ownership
  if (existing.Item.userId !== userId) {
    return {
      statusCode: 403,
      headers,
      body: JSON.stringify({ error: 'Access denied' })
    };
  }

  // Delete from DynamoDB (composite key: qrId + userId)
  await dynamodb.delete({
    TableName: 'snapitqr-qrcodes',
    Key: { qrId, userId }
  }).promise();

  // Decrement usage for dynamic QR codes
  if (existing.Item.type === 'dynamic') {
    await decrementUsage(userId, 'dynamicQRs');
  }

  // Track analytics event
  await trackAnalyticsEvent({
    eventType: 'qr_deleted',
    qrId,
    userId,
    metadata: { type: existing.Item.type }
  });

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      message: 'QR code deleted successfully'
    })
  };
}

async function redirectQRCode(event) {
  const qrId = event.pathParameters.id;

  try {
    // Scan DynamoDB for this qrId across all users
    const result = await dynamodb.scan({
      TableName: 'snapitqr-qrcodes',
      FilterExpression: 'qrId = :qrId',
      ExpressionAttributeValues: {
        ':qrId': qrId
      },
      Limit: 1
    }).promise();

    if (!result.Items || result.Items.length === 0) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'text/html' },
        body: '<!DOCTYPE html><html><head><title>QR Code Not Found</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;text-align:center;padding:20px}h1{font-size:3rem;margin:0 0 1rem 0}p{font-size:1.25rem;opacity:.9}a{color:#fff}</style></head><body><div><h1>404</h1><p>This QR code does not exist or has been deleted.</p><p><a href="https://snapitqr.com">Create your own at SnapIT QR</a></p></div></body></html>'
      };
    }

    const qrCode = result.Items[0];

    if (qrCode.status !== 'active') {
      return {
        statusCode: 410,
        headers: { 'Content-Type': 'text/html' },
        body: '<!DOCTYPE html><html><head><title>QR Code Disabled</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;text-align:center;padding:20px}h1{font-size:3rem;margin:0 0 1rem 0}p{font-size:1.25rem;opacity:.9}</style></head><body><div><h1>Disabled</h1><p>This QR code has been disabled by its owner.</p></div></body></html>'
      };
    }

    // Increment scan count
    await dynamodb.update({
      TableName: 'snapitqr-qrcodes',
      Key: { qrId: qrCode.qrId, userId: qrCode.userId },
      UpdateExpression: 'ADD scans :inc',
      ExpressionAttributeValues: { ':inc': 1 }
    }).promise();

    // Track analytics
    await trackAnalyticsEvent({
      eventType: 'qr_scanned',
      qrId,
      userId: qrCode.userId,
      metadata: {
        destination: qrCode.content,
        userAgent: event.headers?.['User-Agent'],
        country: event.headers?.['CloudFront-Viewer-Country']
      }
    });

    // Redirect to destination
    return {
      statusCode: 302,
      headers: {
        'Location': qrCode.content,
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      },
      body: ''
    };

  } catch (error) {
    console.error('Redirect error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/html' },
      body: '<!DOCTYPE html><html><head><title>Error</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;text-align:center;padding:20px}h1{font-size:3rem;margin:0 0 1rem 0}p{font-size:1.25rem;opacity:.9}</style></head><body><div><h1>Error</h1><p>An error occurred while processing this QR code.</p></div></body></html>'
    };
  }
}

async function checkUsageLimit(userId, resource, tier) {
  const user = await dynamodb.get({
    TableName: 'snapitqr-users',
    Key: { userId }
  }).promise();

  if (!user.Item) {
    return { allowed: false, message: 'User not found' };
  }

  const currentUsage = user.Item.usage?.[resource] || 0;
  const limit = TIER_LIMITS[tier]?.[resource] || 0;

  if (limit === Infinity) {
    return { allowed: true };
  }

  if (currentUsage >= limit) {
    return {
      allowed: false,
      message: `You've reached your ${resource} limit of ${limit}. Upgrade to get more!`,
      current: currentUsage,
      limit
    };
  }

  return { allowed: true, current: currentUsage, limit };
}

async function incrementUsage(userId, resource) {
  await dynamodb.update({
    TableName: 'snapitqr-users',
    Key: { userId },
    UpdateExpression: 'ADD #usage.#resource :inc',
    ExpressionAttributeNames: {
      '#usage': 'usage',
      '#resource': resource
    },
    ExpressionAttributeValues: {
      ':inc': 1
    }
  }).promise();
}

async function decrementUsage(userId, resource) {
  await dynamodb.update({
    TableName: 'snapitqr-users',
    Key: { userId },
    UpdateExpression: 'ADD #usage.#resource :dec',
    ExpressionAttributeNames: {
      '#usage': 'usage',
      '#resource': resource
    },
    ExpressionAttributeValues: {
      ':dec': -1
    }
  }).promise();
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
