const AWS = require('aws-sdk');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const rateLimiter = require('./rate-limiter');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();

const TIER_LIMITS = {
  free: {
    dynamicQRs: 10,
    staticQRs: Infinity
  },
  core: {
    dynamicQRs: 1000,
    staticQRs: Infinity
  },
  growth: {
    dynamicQRs: 5000,
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
    const userId = event.requestContext.authorizer?.userId;
    const userTier = event.requestContext.authorizer?.tier || 'free';

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
    if ((path === '/qr/generate' || path === '/generate') && method === 'POST') {
      return await generateQRCode(event, userId, userTier, headers);
    } else if ((path === '/qr/list' || path === '/qr-codes') && method === 'GET') {
      return await listQRCodes(event, userId, headers);
    } else if (path.startsWith('/qr/') && method === 'GET') {
      return await getQRCode(event, headers);
    } else if (path.startsWith('/qr/') && method === 'PUT') {
      return await updateQRCode(event, userId, headers);
    } else if (path.startsWith('/qr/') && method === 'DELETE') {
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
    qrContent = `https://snapitqr.com/r/${qrId}`;
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

  const result = await dynamodb.get({
    TableName: 'snapitqr-qrcodes',
    Key: { qrId }
  }).promise();

  if (!result.Item) {
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
      qrCode: result.Item
    })
  };
}

async function updateQRCode(event, userId, headers) {
  if (!userId) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: 'Authentication required' })
    };
  }

  const qrId = event.pathParameters.id;
  const body = JSON.parse(event.body || '{}');

  // Get existing QR code
  const existing = await dynamodb.get({
    TableName: 'snapitqr-qrcodes',
    Key: { qrId }
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

  // Only dynamic QR codes can be updated
  if (existing.Item.type !== 'dynamic') {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Only dynamic QR codes can be updated' })
    };
  }

  // Update the content
  const updateExpression = [];
  const expressionAttributeValues = {};
  const expressionAttributeNames = {};

  if (body.content) {
    updateExpression.push('#content = :content');
    expressionAttributeNames['#content'] = 'content';
    expressionAttributeValues[':content'] = body.content;
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

  await dynamodb.update({
    TableName: 'snapitqr-qrcodes',
    Key: { qrId },
    UpdateExpression: 'SET ' + updateExpression.join(', '),
    ExpressionAttributeNames: Object.keys(expressionAttributeNames).length > 0 ? expressionAttributeNames : undefined,
    ExpressionAttributeValues: expressionAttributeValues
  }).promise();

  // Track analytics event
  await trackAnalyticsEvent({
    eventType: 'qr_updated',
    qrId,
    userId,
    metadata: { changes: Object.keys(body) }
  });

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      message: 'QR code updated successfully'
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

  // Get existing QR code
  const existing = await dynamodb.get({
    TableName: 'snapitqr-qrcodes',
    Key: { qrId }
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

  // Delete from DynamoDB
  await dynamodb.delete({
    TableName: 'snapitqr-qrcodes',
    Key: { qrId }
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
    UpdateExpression: 'ADD usage.#resource :inc',
    ExpressionAttributeNames: {
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
    UpdateExpression: 'ADD usage.#resource :dec',
    ExpressionAttributeNames: {
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
