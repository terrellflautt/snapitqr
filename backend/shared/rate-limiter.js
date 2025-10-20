/**
 * Shared Rate Limiting Module
 *
 * High-performance IP-based rate limiting with intelligent abuse detection
 * This module is imported directly by Lambda functions for zero-latency checking
 *
 * Features:
 * - Rolling time windows (hourly + daily limits)
 * - Progressive warnings before blocks
 * - Automatic abuse logging
 * - Privacy-preserving IP hashing
 * - Graceful degradation (allows access if DynamoDB fails)
 */

const AWS = require('aws-sdk');
const crypto = require('crypto');

const dynamodb = new AWS.DynamoDB.DocumentClient();

const RATE_LIMITS = {
  anonymous: {
    urls_per_hour: 10,
    urls_per_day: 50,
    qr_per_hour: 5,
    qr_per_day: 20,
    warning_threshold: 0.8 // Warn at 80% of limit
  }
};

/**
 * Check if an action is allowed for an IP address
 * Returns { allowed: boolean, usage: object, warning: object|null }
 */
async function checkRateLimit(sourceIp, actionType, userAgent, country) {
  try {
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

    if (hourExceeded || dayExceeded) {
      // Log abuse attempt
      await logAbuseAttempt(sourceIp, ipHash, actionType, {
        hourActions,
        dayActions,
        userAgent,
        country
      }).catch(err => console.error('Failed to log abuse:', err));

      const resetMinutes = Math.ceil((oneHourAgo + 3600000 - now) / 60000);

      return {
        allowed: false,
        error: 'Rate limit exceeded',
        message: hourExceeded
          ? `You have reached the hourly limit of ${hourLimit} ${actionType}s. Please try again in ${resetMinutes} minutes or sign in for higher limits.`
          : `You have reached the daily limit of ${dayLimit} ${actionType}s. Please sign in for higher limits or try again tomorrow.`,
        limits: {
          hourly: { current: hourActions, limit: hourLimit },
          daily: { current: dayActions, limit: dayLimit }
        },
        suggestion: 'Sign in to get unlimited access and advanced features'
      };
    }

    // Check for warning threshold
    const hourWarning = hourActions >= (hourLimit * limits.warning_threshold);
    const dayWarning = dayActions >= (dayLimit * limits.warning_threshold);

    return {
      allowed: true,
      ipHash,
      usage: {
        hourly: {
          current: hourActions,
          limit: hourLimit,
          remaining: hourLimit - hourActions
        },
        daily: {
          current: dayActions,
          limit: dayLimit,
          remaining: dayLimit - dayActions
        }
      },
      warning: (hourWarning || dayWarning) ? {
        message: 'You are approaching your rate limit. Sign in for unlimited access.',
        percentUsed: Math.max(
          Math.round((hourActions / hourLimit) * 100),
          Math.round((dayActions / dayLimit) * 100)
        )
      } : null
    };

  } catch (error) {
    console.error('Rate limit check error:', error);
    // Graceful degradation: Allow request if rate limiting fails
    // This prevents DynamoDB issues from breaking the entire service
    return {
      allowed: true,
      degraded: true,
      error: 'Rate limiting temporarily unavailable',
      usage: {
        hourly: { current: 0, limit: RATE_LIMITS.anonymous.urls_per_hour, remaining: RATE_LIMITS.anonymous.urls_per_hour },
        daily: { current: 0, limit: RATE_LIMITS.anonymous.urls_per_day, remaining: RATE_LIMITS.anonymous.urls_per_day }
      }
    };
  }
}

/**
 * Record an action after it has been completed
 */
async function recordAction(sourceIp, actionType, userId, metadata) {
  try {
    const ipHash = hashIP(sourceIp);
    const now = Date.now();
    const ttl = Math.floor(now / 1000) + (30 * 24 * 60 * 60); // 30 days TTL

    // Use composite key to allow multiple records per IP per timestamp
    const recordId = `${ipHash}#${now}#${Math.random().toString(36).substr(2, 9)}`;

    const record = {
      ipHash,
      timestamp: now,
      recordId,
      actionType,
      userId: userId || 'anonymous',
      metadata: metadata || {},
      ttl
    };

    await dynamodb.put({
      TableName: 'snapitqr-rate-limits',
      Item: record
    }).promise();

    return { success: true };

  } catch (error) {
    console.error('Failed to record action:', error);
    // Don't fail the request if we can't record it
    return { success: false, error: error.message };
  }
}

/**
 * Get recent actions for an IP
 */
async function getRecentActions(ipHash, since) {
  const result = await dynamodb.query({
    TableName: 'snapitqr-rate-limits',
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
 * Log abuse attempt for monitoring and analysis
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
      sourceIp, // Store actual IP for admin review (encrypted in transit)
      metadata,
      ttl
    }
  }).promise();

  console.log('⚠️ Rate limit exceeded:', { ipHash, actionType, metadata });
}

/**
 * Hash IP address for privacy (GDPR compliant)
 */
function hashIP(ip) {
  const salt = process.env.IP_HASH_SALT || 'snapitqr-default-salt-CHANGE-IN-PRODUCTION';
  return crypto.createHash('sha256').update(ip + salt).digest('hex').substr(0, 16);
}

/**
 * Check if IP is from a known bot or suspicious source
 */
function isBot(userAgent) {
  if (!userAgent) return false;

  const botPatterns = [
    'bot', 'crawler', 'spider', 'scraper', 'curl', 'wget',
    'python-requests', 'axios', 'java', 'go-http-client'
  ];

  const lowerUA = userAgent.toLowerCase();
  return botPatterns.some(pattern => lowerUA.includes(pattern));
}

module.exports = {
  checkRateLimit,
  recordAction,
  isBot,
  RATE_LIMITS
};
