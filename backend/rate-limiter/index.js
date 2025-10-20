const AWS = require('aws-sdk');
const crypto = require('crypto');

const dynamodb = new AWS.DynamoDB.DocumentClient();

/**
 * IP-Based Rate Limiting for Anonymous Users
 *
 * This Lambda function provides intelligent rate limiting to prevent abuse
 * while allowing legitimate anonymous users to use the service.
 *
 * Features:
 * - IP-based tracking with rolling time windows
 * - Progressive rate limiting (warnings before blocks)
 * - Automatic cleanup of old records
 * - Geographic analysis for abuse detection
 * - Configurable limits per tier
 */

const RATE_LIMITS = {
  anonymous: {
    urls_per_hour: 10,
    urls_per_day: 50,
    qr_per_hour: 5,
    qr_per_day: 20,
    warning_threshold: 0.8 // Warn at 80% of limit
  },
  authenticated: {
    free: {
      urls_per_hour: 50,
      urls_per_day: 100,
      qr_per_hour: 10,
      qr_per_day: 3
    },
    starter: {
      urls_per_hour: 200,
      urls_per_day: 1000,
      qr_per_hour: 50,
      qr_per_day: 50
    },
    pro: {
      urls_per_hour: 1000,
      urls_per_day: 10000,
      qr_per_hour: 500,
      qr_per_day: 500
    },
    business: {
      urls_per_hour: 10000,
      urls_per_day: 100000,
      qr_per_hour: 5000,
      qr_per_day: 5000
    }
  }
};

exports.handler = async (event) => {
  console.log('Rate Limiter Event:', JSON.stringify(event, null, 2));

  try {
    const method = event.httpMethod;
    const path = event.resource;

    // CORS headers
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Content-Type': 'application/json'
    };

    if (method === 'OPTIONS') {
      return { statusCode: 200, headers, body: '' };
    }

    // Route to appropriate handler
    if (path === '/rate-limit/check' && method === 'POST') {
      return await checkRateLimit(event, headers);
    } else if (path === '/rate-limit/record' && method === 'POST') {
      return await recordAction(event, headers);
    } else if (path === '/rate-limit/status' && method === 'GET') {
      return await getRateLimitStatus(event, headers);
    }

    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Not found' })
    };

  } catch (error) {
    console.error('Rate Limiter Error:', error);
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

/**
 * Check if an action is allowed based on rate limits
 */
async function checkRateLimit(event, headers) {
  const body = JSON.parse(event.body || '{}');
  const { actionType, userId } = body; // actionType: 'url' or 'qr'

  const sourceIp = event.requestContext.identity.sourceIp;
  const userAgent = event.headers['User-Agent'] || 'Unknown';
  const country = event.headers['CloudFront-Viewer-Country'] || 'Unknown';

  // If authenticated user, use user-based limits
  if (userId && userId !== 'anonymous') {
    return checkAuthenticatedUserLimit(userId, actionType, headers);
  }

  // For anonymous users, use IP-based limits
  const ipHash = hashIP(sourceIp);
  const now = Date.now();
  const oneHourAgo = now - (60 * 60 * 1000);
  const oneDayAgo = now - (24 * 60 * 60 * 1000);

  // Get recent actions from this IP
  const recentActions = await getRecentActions(ipHash, oneDayAgo);

  // Count actions in different time windows
  const hourActions = recentActions.filter(a =>
    a.timestamp > oneHourAgo && a.actionType === actionType
  ).length;

  const dayActions = recentActions.filter(a =>
    a.actionType === actionType
  ).length;

  // Check against limits
  const limits = RATE_LIMITS.anonymous;
  const hourLimit = actionType === 'url' ? limits.urls_per_hour : limits.qr_per_hour;
  const dayLimit = actionType === 'url' ? limits.urls_per_day : limits.qr_per_day;

  const hourExceeded = hourActions >= hourLimit;
  const dayExceeded = dayActions >= dayLimit;

  // Check for warning threshold
  const hourWarning = hourActions >= (hourLimit * limits.warning_threshold);
  const dayWarning = dayActions >= (dayLimit * limits.warning_threshold);

  // Detect suspicious patterns
  const suspiciousActivity = await detectSuspiciousActivity(recentActions, userAgent, country);

  if (hourExceeded || dayExceeded) {
    // Log abuse attempt
    await logAbuseAttempt(sourceIp, ipHash, actionType, {
      hourActions,
      dayActions,
      userAgent,
      country,
      suspicious: suspiciousActivity
    });

    return {
      statusCode: 429,
      headers,
      body: JSON.stringify({
        allowed: false,
        error: 'Rate limit exceeded',
        message: hourExceeded
          ? `You have reached the hourly limit of ${hourLimit} ${actionType}s. Please try again in ${Math.ceil((oneHourAgo + 3600000 - now) / 60000)} minutes.`
          : `You have reached the daily limit of ${dayLimit} ${actionType}s. Please sign in for higher limits or try again tomorrow.`,
        limits: {
          hourly: { current: hourActions, limit: hourLimit },
          daily: { current: dayActions, limit: dayLimit }
        },
        suggestion: 'Sign in to get higher limits and access to advanced features',
        upgradeUrl: 'https://snapiturl.com/?upgrade=true'
      })
    };
  }

  // Return success with usage info
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      allowed: true,
      ipHash,
      usage: {
        hourly: { current: hourActions, limit: hourLimit, remaining: hourLimit - hourActions },
        daily: { current: dayActions, limit: dayLimit, remaining: dayLimit - dayActions }
      },
      warning: hourWarning || dayWarning ? {
        message: 'You are approaching your rate limit. Sign in for unlimited access.',
        upgradeUrl: 'https://snapiturl.com/?upgrade=true'
      } : null,
      suspicious: suspiciousActivity
    })
  };
}

/**
 * Record an action for rate limiting
 */
async function recordAction(event, headers) {
  const body = JSON.parse(event.body || '{}');
  const { actionType, userId, metadata } = body;

  const sourceIp = event.requestContext.identity.sourceIp;
  const ipHash = hashIP(sourceIp);
  const now = Date.now();
  const ttl = Math.floor(now / 1000) + (30 * 24 * 60 * 60); // 30 days TTL

  const record = {
    ipHash,
    timestamp: now,
    actionType,
    userId: userId || 'anonymous',
    metadata: metadata || {},
    userAgent: event.headers['User-Agent'] || 'Unknown',
    country: event.headers['CloudFront-Viewer-Country'] || 'Unknown',
    ttl
  };

  await dynamodb.put({
    TableName: 'snapitqr-rate-limits',
    Item: record
  }).promise();

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      message: 'Action recorded'
    })
  };
}

/**
 * Get rate limit status for an IP or user
 */
async function getRateLimitStatus(event, headers) {
  const sourceIp = event.requestContext.identity.sourceIp;
  const ipHash = hashIP(sourceIp);
  const userId = event.queryStringParameters?.userId;

  const now = Date.now();
  const oneDayAgo = now - (24 * 60 * 60 * 1000);

  const recentActions = await getRecentActions(ipHash, oneDayAgo);

  const urlActions = recentActions.filter(a => a.actionType === 'url').length;
  const qrActions = recentActions.filter(a => a.actionType === 'qr').length;

  const limits = RATE_LIMITS.anonymous;

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ipHash,
      urls: {
        daily: { current: urlActions, limit: limits.urls_per_day, remaining: limits.urls_per_day - urlActions }
      },
      qr: {
        daily: { current: qrActions, limit: limits.qr_per_day, remaining: limits.qr_per_day - qrActions }
      },
      isAnonymous: !userId || userId === 'anonymous'
    })
  };
}

/**
 * Check authenticated user limits
 */
async function checkAuthenticatedUserLimit(userId, actionType, headers) {
  // Get user from database
  const user = await dynamodb.get({
    TableName: 'snapitqr-users',
    Key: { userId }
  }).promise();

  if (!user.Item) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'User not found' })
    };
  }

  const tier = user.Item.tier || 'free';
  const limits = RATE_LIMITS.authenticated[tier];

  // For authenticated users, check total usage against monthly limits
  // This is handled by the main Lambda, so we just return allowed
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      allowed: true,
      tier,
      message: 'Authenticated users have higher limits'
    })
  };
}

/**
 * Get recent actions for an IP
 */
async function getRecentActions(ipHash, since) {
  const result = await dynamodb.query({
    TableName: 'snapitqr-rate-limits',
    IndexName: 'ipHash-timestamp-index',
    KeyConditionExpression: 'ipHash = :ipHash AND #ts > :since',
    ExpressionAttributeNames: {
      '#ts': 'timestamp'
    },
    ExpressionAttributeValues: {
      ':ipHash': ipHash,
      ':since': since
    }
  }).promise();

  return result.Items || [];
}

/**
 * Detect suspicious activity patterns
 */
async function detectSuspiciousActivity(actions, userAgent, country) {
  if (actions.length === 0) return false;

  // Check for rapid-fire requests (more than 5 in 1 minute)
  const oneMinuteAgo = Date.now() - 60000;
  const recentActions = actions.filter(a => a.timestamp > oneMinuteAgo);
  if (recentActions.length > 5) {
    return 'rapid_requests';
  }

  // Check for bot-like user agents
  const botPatterns = ['bot', 'crawler', 'spider', 'scraper', 'curl', 'wget', 'python-requests'];
  const lowerUA = userAgent.toLowerCase();
  if (botPatterns.some(pattern => lowerUA.includes(pattern))) {
    return 'bot_user_agent';
  }

  // Check for high-risk countries (if applicable)
  // This is optional and should be configured per use case

  return false;
}

/**
 * Log abuse attempt for analysis
 */
async function logAbuseAttempt(sourceIp, ipHash, actionType, metadata) {
  const now = Date.now();
  const ttl = Math.floor(now / 1000) + (90 * 24 * 60 * 60); // 90 days TTL

  await dynamodb.put({
    TableName: 'snapitqr-abuse-log',
    Item: {
      ipHash,
      timestamp: now,
      actionType,
      sourceIp, // Store actual IP for admin review
      metadata,
      ttl
    }
  }).promise();

  console.log('Abuse attempt logged:', { ipHash, actionType, metadata });
}

/**
 * Hash IP address for privacy
 */
function hashIP(ip) {
  // Use SHA-256 with salt for privacy
  const salt = process.env.IP_HASH_SALT || 'snapitqr-default-salt-change-in-production';
  return crypto.createHash('sha256').update(ip + salt).digest('hex');
}
