const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const rateLimiter = require('./rate-limiter');

const dynamodb = new AWS.DynamoDB.DocumentClient();

const TIER_LIMITS = {
  free: {
    shortURLs: 10
  },
  core: {
    shortURLs: 1000
  },
  growth: {
    shortURLs: 5000
  },
  business: {
    shortURLs: Infinity
  }
};

// Custom short code characters (URL-safe)
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

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
    if (path === '/url/shorten' && method === 'POST') {
      return await shortenURL(event, userId, userTier, headers);
    } else if ((path === '/url/list' || path === '/short-urls') && method === 'GET') {
      return await listURLs(event, userId, headers);
    } else if ((path.startsWith('/url/') || path.startsWith('/short-urls/')) && method === 'GET') {
      return await getURL(event, headers);
    } else if ((path.startsWith('/url/') || path.startsWith('/short-urls/')) && method === 'PUT') {
      return await updateURL(event, userId, headers);
    } else if ((path.startsWith('/url/') || path.startsWith('/short-urls/')) && method === 'DELETE') {
      return await deleteURL(event, userId, headers);
    } else if (path === '/r/{shortCode}' && method === 'GET') {
      return await redirectURL(event, headers);
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

async function shortenURL(event, userId, userTier, headers) {
  const body = JSON.parse(event.body || '{}');
  const { url, customAlias, title, expiresAt, password } = body;

  if (!url) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'URL is required' })
    };
  }

  // Validate URL format
  try {
    new URL(url);
  } catch (e) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid URL format' })
    };
  }

  // For anonymous users, check IP-based rate limits
  if (!userId || userId === 'anonymous') {
    const sourceIp = event.requestContext.identity.sourceIp;
    const userAgent = event.headers?.['User-Agent'] || 'Unknown';
    const country = event.headers?.['CloudFront-Viewer-Country'] || 'Unknown';

    const rateCheck = await rateLimiter.checkRateLimit(sourceIp, 'url', userAgent, country);

    if (!rateCheck.allowed) {
      return {
        statusCode: 429,
        headers,
        body: JSON.stringify({
          error: rateCheck.error,
          message: rateCheck.message,
          limits: rateCheck.limits,
          suggestion: rateCheck.suggestion,
          retryAfter: 3600 // Suggest retry after 1 hour
        })
      };
    }

    // Add usage info to response headers for transparency
    headers['X-Rate-Limit-Hourly-Limit'] = rateCheck.usage.hourly.limit;
    headers['X-Rate-Limit-Hourly-Remaining'] = rateCheck.usage.hourly.remaining;
    headers['X-Rate-Limit-Daily-Limit'] = rateCheck.usage.daily.limit;
    headers['X-Rate-Limit-Daily-Remaining'] = rateCheck.usage.daily.remaining;
  }

  // For authenticated users, check tier-based usage limits
  if (userId && userId !== 'anonymous') {
    const usage = await checkUsageLimit(userId, 'shortURLs', userTier);
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

  // Generate or validate custom alias
  let shortCode;
  if (customAlias) {
    // Check if custom alias is available
    const existing = await dynamodb.get({
      TableName: 'snapitqr-shorturls',
      Key: { shortCode: customAlias }
    }).promise();

    if (existing.Item) {
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({ error: 'Custom alias already taken' })
      };
    }

    shortCode = customAlias;
  } else {
    // Generate random short code
    shortCode = await generateShortCode();
  }

  // Hash password if provided
  let passwordHash;
  if (password) {
    passwordHash = crypto.createHash('sha256').update(password).digest('hex');
  }

  // Create URL record
  const urlId = uuidv4();
  const urlRecord = {
    shortCode,
    urlId,
    userId: userId || 'anonymous',
    originalUrl: url,
    title: title || url,
    clicks: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'active',
    expiresAt: expiresAt || null,
    passwordHash: passwordHash || null
  };

  await dynamodb.put({
    TableName: 'snapitqr-shorturls',
    Item: urlRecord
  }).promise();

  // Increment usage
  if (userId) {
    await incrementUsage(userId, 'shortURLs');
  }

  // Track analytics event
  await trackAnalyticsEvent({
    eventType: 'url_created',
    urlId,
    shortCode,
    userId: userId || 'anonymous',
    metadata: { tier: userTier, hasCustomAlias: !!customAlias }
  });

  // Record action for rate limiting (async, don't wait)
  if (!userId || userId === 'anonymous') {
    const sourceIp = event.requestContext.identity.sourceIp;
    rateLimiter.recordAction(sourceIp, 'url', userId || 'anonymous', {
      shortCode,
      urlId,
      domain: body.domain || 'snapiturl.com'
    }).catch(err => console.error('Failed to record rate limit action:', err));
  }

  // Determine which domain to use based on request
  // Frontend can pass preferred domain in body
  const preferredDomain = body.domain || 'snapiturl.com';
  const shortUrl = `https://api.${preferredDomain}/r/${shortCode}`;

  return {
    statusCode: 201,
    headers,
    body: JSON.stringify({
      success: true,
      urlId,
      shortCode,
      shortUrl,
      originalUrl: url,
      domain: preferredDomain,
      message: 'URL shortened successfully'
    })
  };
}

async function listURLs(event, userId, headers) {
  if (!userId) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: 'Authentication required' })
    };
  }

  const params = {
    TableName: 'snapitqr-shorturls',
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
      urls: result.Items,
      count: result.Count
    })
  };
}

async function getURL(event, headers) {
  const shortCode = event.pathParameters.shortCode;

  const result = await dynamodb.get({
    TableName: 'snapitqr-shorturls',
    Key: { shortCode }
  }).promise();

  if (!result.Item) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Short URL not found' })
    };
  }

  // Don't expose password hash
  const item = { ...result.Item };
  delete item.passwordHash;

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      url: item
    })
  };
}

async function updateURL(event, userId, headers) {
  if (!userId) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: 'Authentication required' })
    };
  }

  const shortCode = event.pathParameters.shortCode;
  const body = JSON.parse(event.body || '{}');

  // Get existing URL
  const existing = await dynamodb.get({
    TableName: 'snapitqr-shorturls',
    Key: { shortCode }
  }).promise();

  if (!existing.Item) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Short URL not found' })
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

  // Update fields
  const updateExpression = [];
  const expressionAttributeValues = {};
  const expressionAttributeNames = {};

  if (body.originalUrl) {
    updateExpression.push('#originalUrl = :originalUrl');
    expressionAttributeNames['#originalUrl'] = 'originalUrl';
    expressionAttributeValues[':originalUrl'] = body.originalUrl;
  }

  if (body.title) {
    updateExpression.push('#title = :title');
    expressionAttributeNames['#title'] = 'title';
    expressionAttributeValues[':title'] = body.title;
  }

  if (body.status) {
    updateExpression.push('#status = :status');
    expressionAttributeNames['#status'] = 'status';
    expressionAttributeValues[':status'] = body.status;
  }

  if (body.expiresAt !== undefined) {
    updateExpression.push('expiresAt = :expiresAt');
    expressionAttributeValues[':expiresAt'] = body.expiresAt;
  }

  if (body.password !== undefined) {
    if (body.password) {
      const passwordHash = crypto.createHash('sha256').update(body.password).digest('hex');
      updateExpression.push('passwordHash = :passwordHash');
      expressionAttributeValues[':passwordHash'] = passwordHash;
    } else {
      updateExpression.push('passwordHash = :passwordHash');
      expressionAttributeValues[':passwordHash'] = null;
    }
  }

  updateExpression.push('updatedAt = :updatedAt');
  expressionAttributeValues[':updatedAt'] = new Date().toISOString();

  if (updateExpression.length === 1) { // Only updatedAt
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'No fields to update' })
    };
  }

  await dynamodb.update({
    TableName: 'snapitqr-shorturls',
    Key: { shortCode },
    UpdateExpression: 'SET ' + updateExpression.join(', '),
    ExpressionAttributeNames: Object.keys(expressionAttributeNames).length > 0 ? expressionAttributeNames : undefined,
    ExpressionAttributeValues: expressionAttributeValues
  }).promise();

  // Track analytics event
  await trackAnalyticsEvent({
    eventType: 'url_updated',
    shortCode,
    userId,
    metadata: { changes: Object.keys(body) }
  });

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      message: 'Short URL updated successfully'
    })
  };
}

async function deleteURL(event, userId, headers) {
  if (!userId) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: 'Authentication required' })
    };
  }

  const shortCode = event.pathParameters.shortCode;

  // Get existing URL
  const existing = await dynamodb.get({
    TableName: 'snapitqr-shorturls',
    Key: { shortCode }
  }).promise();

  if (!existing.Item) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Short URL not found' })
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
    TableName: 'snapitqr-shorturls',
    Key: { shortCode }
  }).promise();

  // Decrement usage
  await decrementUsage(userId, 'shortURLs');

  // Track analytics event
  await trackAnalyticsEvent({
    eventType: 'url_deleted',
    shortCode,
    userId,
    metadata: {}
  });

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      message: 'Short URL deleted successfully'
    })
  };
}

async function redirectURL(event, headers) {
  const shortCode = event.pathParameters.shortCode;

  // Get URL from DynamoDB
  const result = await dynamodb.get({
    TableName: 'snapitqr-shorturls',
    Key: { shortCode }
  }).promise();

  if (!result.Item) {
    return {
      statusCode: 404,
      headers: {
        'Content-Type': 'text/html'
      },
      body: '<html><body><h1>404 - Short URL not found</h1></body></html>'
    };
  }

  const urlRecord = result.Item;

  // Check if expired
  if (urlRecord.expiresAt && new Date(urlRecord.expiresAt) < new Date()) {
    return {
      statusCode: 410,
      headers: {
        'Content-Type': 'text/html'
      },
      body: '<html><body><h1>410 - This link has expired</h1></body></html>'
    };
  }

  // Check if inactive
  if (urlRecord.status !== 'active') {
    return {
      statusCode: 410,
      headers: {
        'Content-Type': 'text/html'
      },
      body: '<html><body><h1>410 - This link is no longer active</h1></body></html>'
    };
  }

  // Check password if required
  if (urlRecord.passwordHash) {
    const providedPassword = event.queryStringParameters?.password;
    if (!providedPassword) {
      return {
        statusCode: 401,
        headers: {
          'Content-Type': 'text/html'
        },
        body: '<html><body><h1>401 - Password required</h1><p>This link is password protected</p></body></html>'
      };
    }

    const passwordHash = crypto.createHash('sha256').update(providedPassword).digest('hex');
    if (passwordHash !== urlRecord.passwordHash) {
      return {
        statusCode: 403,
        headers: {
          'Content-Type': 'text/html'
        },
        body: '<html><body><h1>403 - Invalid password</h1></body></html>'
      };
    }
  }

  // Increment click count
  await dynamodb.update({
    TableName: 'snapitqr-shorturls',
    Key: { shortCode },
    UpdateExpression: 'ADD clicks :inc',
    ExpressionAttributeValues: {
      ':inc': 1
    }
  }).promise();

  // Track analytics event
  const userAgent = event.headers?.['User-Agent'] || 'Unknown';
  const sourceIp = event.requestContext.identity.sourceIp;
  const referer = event.headers?.['Referer'] || event.headers?.['referer'] || 'Direct';

  await trackAnalyticsEvent({
    eventType: 'url_clicked',
    shortCode,
    urlId: urlRecord.urlId,
    userId: urlRecord.userId,
    metadata: {
      userAgent,
      sourceIp,
      referer,
      country: event.headers?.['CloudFront-Viewer-Country'] || 'Unknown'
    }
  });

  // Redirect to original URL
  return {
    statusCode: 302,
    headers: {
      'Location': urlRecord.originalUrl,
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    },
    body: ''
  };
}

async function generateShortCode() {
  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
    // Generate 6-character short code
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += CHARS[Math.floor(Math.random() * CHARS.length)];
    }

    // Check if it exists
    const existing = await dynamodb.get({
      TableName: 'snapitqr-shorturls',
      Key: { shortCode: code }
    }).promise();

    if (!existing.Item) {
      return code;
    }

    attempts++;
  }

  // If we couldn't generate a unique code, use UUID
  return uuidv4().substring(0, 8);
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
