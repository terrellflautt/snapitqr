const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const ssm = new AWS.SSM();

let JWT_SECRET;

// Rate limit windows and thresholds
const RATE_LIMITS = {
  free: {
    requestsPerMinute: 50,
    requestsPerMonth: 50000
  },
  starter: {
    requestsPerMinute: 200,
    requestsPerMonth: 200000
  },
  pro: {
    requestsPerMinute: 500,
    requestsPerMonth: 1000000
  },
  business: {
    requestsPerMinute: 2000,
    requestsPerMonth: Infinity
  }
};

// Abuse tracking thresholds
const ABUSE_THRESHOLDS = {
  warningCount: 3,        // Warnings before penalty
  penaltyDuration: 3600,  // 1 hour penalty in seconds
  banThreshold: 10        // Warnings before permanent ban
};

exports.handler = async (event) => {
  console.log('Authorizer event:', JSON.stringify(event, null, 2));

  try {
    // Load JWT secret if not cached
    if (!JWT_SECRET) {
      JWT_SECRET = await getParameter('/snapitqr/jwt-secret');
    }

    const token = event.authorizationToken?.replace('Bearer ', '');
    const methodArn = event.methodArn;

    let userId = 'anonymous';
    let tier = 'free';
    let email = null;

    // Try to verify token if present
    if (token && token !== 'null' && token !== 'undefined') {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        userId = decoded.userId;
        tier = decoded.tier || 'free';
        email = decoded.email;
      } catch (err) {
        console.log('Token verification failed:', err.message);
        // Continue as anonymous
      }
    }

    // Check rate limits
    const rateLimit = await checkRateLimit(userId, tier);

    if (!rateLimit.allowed) {
      console.log('Rate limit exceeded for user:', userId);
      return generatePolicy('user', 'Deny', methodArn, {
        error: 'Rate limit exceeded',
        message: rateLimit.message,
        retryAfter: rateLimit.retryAfter
      });
    }

    // Check for abuse/ban
    const abuseCheck = await checkAbuse(userId);

    if (!abuseCheck.allowed) {
      console.log('User banned or penalized:', userId);
      return generatePolicy('user', 'Deny', methodArn, {
        error: 'Access denied',
        message: abuseCheck.message,
        banUntil: abuseCheck.banUntil
      });
    }

    // Allow the request
    return generatePolicy(userId, 'Allow', methodArn, {
      userId,
      tier,
      email,
      requestsRemaining: rateLimit.remaining
    });

  } catch (error) {
    console.error('Authorizer error:', error);
    // Deny on error
    return generatePolicy('user', 'Deny', event.methodArn, {
      error: 'Authorization failed'
    });
  }
};

async function checkRateLimit(userId, tier) {
  const limits = RATE_LIMITS[tier] || RATE_LIMITS.free;
  const now = Date.now();
  const minuteKey = `${userId}:minute:${Math.floor(now / 60000)}`;
  const monthKey = `${userId}:month:${new Date().getFullYear()}-${new Date().getMonth() + 1}`;

  // Check minute rate limit
  const minuteRecord = await dynamodb.get({
    TableName: 'snapitqr-ratelimits',
    Key: { limitKey: minuteKey }
  }).promise();

  const minuteCount = minuteRecord.Item?.count || 0;

  if (minuteCount >= limits.requestsPerMinute) {
    return {
      allowed: false,
      message: `Rate limit exceeded: ${limits.requestsPerMinute} requests per minute`,
      retryAfter: 60 - (Math.floor(now / 1000) % 60)
    };
  }

  // Check monthly rate limit
  if (limits.requestsPerMonth !== Infinity) {
    const monthRecord = await dynamodb.get({
      TableName: 'snapitqr-ratelimits',
      Key: { limitKey: monthKey }
    }).promise();

    const monthCount = monthRecord.Item?.count || 0;

    if (monthCount >= limits.requestsPerMonth) {
      return {
        allowed: false,
        message: `Monthly rate limit exceeded: ${limits.requestsPerMonth} requests per month`,
        retryAfter: null
      };
    }
  }

  // Increment counters
  const ttlMinute = Math.floor(now / 1000) + 120; // 2 minutes TTL
  const ttlMonth = Math.floor(new Date(new Date().getFullYear(), new Date().getMonth() + 2, 1).getTime() / 1000); // End of next month

  await dynamodb.put({
    TableName: 'snapitqr-ratelimits',
    Item: {
      limitKey: minuteKey,
      userId,
      tier,
      count: minuteCount + 1,
      ttl: ttlMinute
    }
  }).promise();

  await dynamodb.update({
    TableName: 'snapitqr-ratelimits',
    Key: { limitKey: monthKey },
    UpdateExpression: 'ADD #count :inc SET userId = :userId, tier = :tier, #ttl = :ttl',
    ExpressionAttributeNames: {
      '#count': 'count',
      '#ttl': 'ttl'
    },
    ExpressionAttributeValues: {
      ':inc': 1,
      ':userId': userId,
      ':tier': tier,
      ':ttl': ttlMonth
    }
  }).promise();

  return {
    allowed: true,
    remaining: limits.requestsPerMinute - minuteCount - 1
  };
}

async function checkAbuse(userId) {
  // Get user abuse record
  const result = await dynamodb.get({
    TableName: 'snapitqr-ratelimits',
    Key: { limitKey: `abuse:${userId}` }
  }).promise();

  if (!result.Item) {
    return { allowed: true };
  }

  const abuseRecord = result.Item;
  const now = Math.floor(Date.now() / 1000);

  // Check if permanently banned
  if (abuseRecord.banned) {
    return {
      allowed: false,
      message: 'Your account has been permanently banned due to abuse',
      banUntil: null
    };
  }

  // Check if in penalty period
  if (abuseRecord.penaltyUntil && abuseRecord.penaltyUntil > now) {
    return {
      allowed: false,
      message: 'Your account is temporarily restricted due to abuse',
      banUntil: new Date(abuseRecord.penaltyUntil * 1000).toISOString()
    };
  }

  return { allowed: true };
}

async function recordAbuse(userId, reason) {
  const now = Math.floor(Date.now() / 1000);
  const limitKey = `abuse:${userId}`;

  // Get existing abuse record
  const result = await dynamodb.get({
    TableName: 'snapitqr-ratelimits',
    Key: { limitKey }
  }).promise();

  const warningCount = (result.Item?.warningCount || 0) + 1;
  const banned = warningCount >= ABUSE_THRESHOLDS.banThreshold;
  const penaltyUntil = banned ? null : now + ABUSE_THRESHOLDS.penaltyDuration;

  // Update abuse record
  await dynamodb.put({
    TableName: 'snapitqr-ratelimits',
    Item: {
      limitKey,
      userId,
      warningCount,
      banned,
      penaltyUntil,
      lastAbuse: now,
      reason,
      ttl: banned ? null : now + (365 * 24 * 60 * 60) // 1 year TTL unless banned
    }
  }).promise();

  console.log(`Abuse recorded for user ${userId}: ${warningCount} warnings, banned: ${banned}`);
}

function generatePolicy(principalId, effect, resource, context) {
  const authResponse = {
    principalId
  };

  if (effect && resource) {
    authResponse.policyDocument = {
      Version: '2012-10-17',
      Statement: [
        {
          Action: 'execute-api:Invoke',
          Effect: effect,
          Resource: resource
        }
      ]
    };
  }

  // Add context data (will be available in Lambda via event.requestContext.authorizer)
  if (context) {
    authResponse.context = {};
    for (const [key, value] of Object.entries(context)) {
      // Context values must be strings, numbers, or booleans
      authResponse.context[key] = String(value);
    }
  }

  return authResponse;
}

async function getParameter(name) {
  const result = await ssm.getParameter({
    Name: name,
    WithDecryption: true
  }).promise();

  return result.Parameter.Value;
}
