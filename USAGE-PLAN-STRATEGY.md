# Usage Plan & Rate Limiting Strategy

**Date:** October 12, 2025
**Status:** Production Implementation Guide

---

## Overview

SnapIT Platform needs rate limiting and usage enforcement for three categories:

1. **Anonymous Users** (no auth) - Free tier
2. **Authenticated Free Users** (with auth) - Free tier
3. **Paid Users** (Stripe subscription) - Starter/Pro/Business tiers

---

## Recommended Approach: Hybrid System

Use **both** API Gateway Usage Plans AND Lambda enforcement:

### API Gateway Usage Plans
- **Purpose:** Rate limiting (requests per second/day)
- **Benefit:** Protects backend from abuse
- **Limitation:** Can't distinguish user tiers easily

### Lambda Enforcement
- **Purpose:** Feature limits (URL count, QR codes)
- **Benefit:** Granular control per user
- **Current:** Already implemented in `url-operations/index.js`

---

## Implementation Strategy

### 1. API Gateway Usage Plans (Rate Limiting)

Create 4 usage plans with API keys:

#### Plan 1: Anonymous Access (No API Key)
- **Rate:** 10 requests/second
- **Quota:** 1000 requests/day
- **Burst:** 20
- **Cost:** Free
- **Access:** Anyone without auth token

```bash
aws apigateway create-usage-plan \
  --name "snapitqr-anonymous-plan" \
  --throttle rateLimit=10,burstLimit=20 \
  --quota limit=1000,period=DAY
```

#### Plan 2: Free Tier (API Key Optional)
- **Rate:** 20 requests/second
- **Quota:** 10,000 requests/day
- **Burst:** 50
- **Cost:** Free
- **Access:** Authenticated users on free tier

```bash
aws apigateway create-usage-plan \
  --name "snapitqr-free-tier" \
  --throttle rateLimit=20,burstLimit=50 \
  --quota limit=10000,period=DAY
```

#### Plan 3: Paid Starter/Pro
- **Rate:** 50 requests/second
- **Quota:** 100,000 requests/day
- **Burst:** 100
- **Cost:** $9-29/month
- **Access:** Paid subscribers

```bash
aws apigateway create-usage-plan \
  --name "snapitqr-pro-tier" \
  --throttle rateLimit=50,burstLimit=100 \
  --quota limit=100000,period=DAY
```

#### Plan 4: Business/Enterprise
- **Rate:** 100 requests/second
- **Quota:** Unlimited
- **Burst:** 200
- **Cost:** $99+/month
- **Access:** Business subscribers

```bash
aws apigateway create-usage-plan \
  --name "snapitqr-business-tier" \
  --throttle rateLimit=100,burstLimit=200 \
  --quota limit=999999999,period=DAY
```

### 2. Lambda Enforcement (Feature Limits)

**Already implemented in `backend/url-operations/index.js` lines 7-20:**

```javascript
const TIER_LIMITS = {
  free: {
    shortURLs: 100,
    qrCodes: 100,
    dynamicQR: 3
  },
  starter: {
    shortURLs: 1000,
    qrCodes: 1000,
    dynamicQR: 50
  },
  pro: {
    shortURLs: 10000,
    qrCodes: 10000,
    dynamicQR: 500
  },
  business: {
    shortURLs: 100000,
    qrCodes: 100000,
    dynamicQR: 5000
  }
};
```

**Enhanced with anonymous limits:**

```javascript
const TIER_LIMITS = {
  anonymous: {
    shortURLs: 5,           // Very limited
    qrCodes: 5,
    ratePerMinute: 10,      // Max 10 URLs per minute
    requiresCaptcha: true   // Prevent bot abuse
  },
  free: {
    shortURLs: 100,
    qrCodes: 100,
    dynamicQR: 3,
    customAliases: 10,
    passwordProtection: true,
    expirationDates: true,
    analytics: 'basic'
  },
  starter: {
    shortURLs: 1000,
    qrCodes: 1000,
    dynamicQR: 50,
    customAliases: 100,
    passwordProtection: true,
    expirationDates: true,
    analytics: 'advanced',
    customDomains: 1
  },
  pro: {
    shortURLs: 10000,
    qrCodes: 10000,
    dynamicQR: 500,
    customAliases: 1000,
    passwordProtection: true,
    expirationDates: true,
    analytics: 'advanced',
    customDomains: 5,
    bulkOperations: true
  },
  business: {
    shortURLs: 100000,
    qrCodes: 100000,
    dynamicQR: 5000,
    customAliases: 'unlimited',
    passwordProtection: true,
    expirationDates: true,
    analytics: 'enterprise',
    customDomains: 'unlimited',
    bulkOperations: true,
    apiAccess: true,
    webhooks: true,
    sso: true
  }
};
```

---

## How It Works Together

### Request Flow

```
1. User makes request to API Gateway
         ↓
2. API Gateway checks rate limit (usage plan)
   - Anonymous: 10 req/sec, 1000/day
   - Free: 20 req/sec, 10K/day
   - Pro: 50 req/sec, 100K/day
   - Business: 100 req/sec, unlimited
         ↓
3. If rate limit OK → Forward to Lambda
         ↓
4. Lambda checks feature limits
   - Anonymous: Max 5 URLs total
   - Free: Max 100 URLs total
   - Pro: Max 10K URLs total
   - Business: Max 100K URLs total
         ↓
5. If feature limit OK → Process request
```

### Example: Anonymous User

**Request 1-5:** Create URLs successfully
- API Gateway: ✅ (under rate limit)
- Lambda: ✅ (under 5 URL limit)

**Request 6:** Try to create 6th URL
- API Gateway: ✅ (under rate limit)
- Lambda: ❌ Returns 403 "Upgrade to continue"

**Request 1001 in same day:**
- API Gateway: ❌ Returns 429 "Rate limit exceeded"

### Example: Free User (Authenticated)

**Creates 100 URLs:**
- API Gateway: ✅ (higher rate limit)
- Lambda: ✅ (exactly at limit)

**Tries to create 101st URL:**
- API Gateway: ✅ (under rate limit)
- Lambda: ❌ Returns 403 "Upgrade to Pro"

### Example: Pro User

**Creates 5000 URLs:**
- API Gateway: ✅ (50 req/sec allowed)
- Lambda: ✅ (under 10K limit)

**Tries 51 requests in 1 second:**
- API Gateway: ❌ Returns 429 "Too many requests"

---

## Implementation Steps

### Step 1: Create Usage Plans

```bash
#!/bin/bash
# create-usage-plans.sh

# Get API and stage
API_ID="hvfj8o1yb0"
STAGE="production"

# Create Anonymous plan
aws apigateway create-usage-plan \
  --name "snapitqr-anonymous" \
  --description "Anonymous access - no auth required" \
  --throttle rateLimit=10,burstLimit=20 \
  --quota limit=1000,period=DAY \
  --api-stages apiId=$API_ID,stage=$STAGE

# Create Free plan
FREE_PLAN_ID=$(aws apigateway create-usage-plan \
  --name "snapitqr-free-tier-new" \
  --description "Free tier for authenticated users" \
  --throttle rateLimit=20,burstLimit=50 \
  --quota limit=10000,period=DAY \
  --api-stages apiId=$API_ID,stage=$STAGE \
  --query 'id' --output text)

# Create Pro plan
PRO_PLAN_ID=$(aws apigateway create-usage-plan \
  --name "snapitqr-pro-tier-new" \
  --description "Pro tier for paid subscribers" \
  --throttle rateLimit=50,burstLimit=100 \
  --quota limit=100000,period=DAY \
  --api-stages apiId=$API_ID,stage=$STAGE \
  --query 'id' --output text)

# Create Business plan
BUSINESS_PLAN_ID=$(aws apigateway create-usage-plan \
  --name "snapitqr-business-tier-new" \
  --description "Business tier for enterprise customers" \
  --throttle rateLimit=100,burstLimit=200 \
  --quota limit=999999999,period=DAY \
  --api-stages apiId=$API_ID,stage=$STAGE \
  --query 'id' --output text)

echo "Usage plans created:"
echo "Free: $FREE_PLAN_ID"
echo "Pro: $PRO_PLAN_ID"
echo "Business: $BUSINESS_PLAN_ID"
```

### Step 2: Assign Users to Plans

**When user subscribes via Stripe:**

```javascript
// In stripe-operations/index.js webhook handler

async function handleSubscriptionCreated(subscription) {
  const userId = subscription.metadata.userId;
  const tier = subscription.metadata.tier; // 'starter', 'pro', 'business'

  // Update user tier in DynamoDB
  await dynamodb.update({
    TableName: 'snapitqr-users',
    Key: { userId },
    UpdateExpression: 'SET tier = :tier, subscriptionId = :subId',
    ExpressionAttributeValues: {
      ':tier': tier,
      ':subId': subscription.id
    }
  }).promise();

  // Assign to API Gateway usage plan
  const usagePlanId = TIER_TO_PLAN_ID[tier];

  // Create API key for user if they don't have one
  let apiKey = await getOrCreateApiKey(userId);

  // Associate API key with usage plan
  await apigateway.createUsagePlanKey({
    usagePlanId: usagePlanId,
    keyId: apiKey.id,
    keyType: 'API_KEY'
  }).promise();
}
```

### Step 3: Update Lambda to Support Anonymous

**In url-operations/index.js:**

```javascript
async function shortenURL(event, userId, userTier, headers) {
  const body = JSON.parse(event.body || '{}');
  const { url, customAlias, title } = body;

  // Determine tier
  let tier = userTier || 'free';
  let effectiveUserId = userId;

  if (!userId) {
    tier = 'anonymous';
    effectiveUserId = 'anonymous-' + event.requestContext.identity.sourceIp;
  }

  // Check limits
  const usage = await checkUsageLimit(effectiveUserId, 'shortURLs', tier);
  if (!usage.allowed) {
    return {
      statusCode: 403,
      headers,
      body: JSON.stringify({
        error: usage.message,
        current: usage.current,
        limit: usage.limit,
        upgradeRequired: true,
        upgradeUrl: tier === 'anonymous'
          ? 'https://snapiturl.com/#signup'
          : 'https://snapiturl.com/#pricing'
      })
    };
  }

  // Create URL...
  const urlRecord = {
    shortCode,
    urlId: uuidv4(),
    userId: effectiveUserId,
    originalUrl: url,
    tier: tier,  // Track which tier created it
    // ...
  };

  await dynamodb.put({
    TableName: 'snapitqr-shorturls',
    Item: urlRecord
  }).promise();

  // Only increment if not anonymous
  if (userId) {
    await incrementUsage(userId, 'shortURLs');
  }

  return {
    statusCode: 201,
    headers,
    body: JSON.stringify({
      success: true,
      shortUrl: `https://api.snapiturl.com/r/${shortCode}`,
      message: tier === 'anonymous'
        ? 'Sign in to track analytics and create more URLs'
        : 'URL created successfully'
    })
  };
}
```

### Step 4: Enforce on Frontend

**In snapiturl.html, show appropriate messaging:**

```javascript
async function handleUpgradeRequired(error) {
  const tier = getCurrentUserTier(); // From localStorage or JWT

  let message = '';
  let ctaButton = '';

  if (tier === 'anonymous') {
    message = `You've reached the limit of 5 URLs for anonymous users. Sign in to get 100 free URLs with analytics!`;
    ctaButton = '<button onclick="signIn()">Sign In Free</button>';
  } else if (tier === 'free') {
    message = `You've used all 100 free URLs. Upgrade to Pro for 10,000 URLs + advanced features.`;
    ctaButton = '<button onclick="goToPricing()">View Plans</button>';
  } else if (tier === 'starter') {
    message = `You've reached your limit of 1,000 URLs. Upgrade to Pro for 10x more capacity.`;
    ctaButton = '<button onclick="goToPricing()">Upgrade to Pro</button>';
  }

  showModal(message, ctaButton);
}
```

---

## Best Practices

### 1. Use IAM Auth for API Gateway (Optional)

**Why:** More secure than API keys
**When:** For high-value enterprise customers
**How:**

```javascript
// Frontend makes requests with AWS Signature V4
const AWS = require('aws-sdk');
AWS.config.credentials = new AWS.CognitoIdentityCredentials({
  IdentityPoolId: 'us-east-1:xxx'
});

const signer = new AWS.Signers.V4(request, 'execute-api');
signer.addAuthorization(AWS.config.credentials, new Date());
```

### 2. Cache User Tier in JWT

**Why:** Avoid DynamoDB lookup on every request
**How:**

```javascript
// When creating JWT in auth-operations
const payload = {
  userId: user.userId,
  email: user.email,
  tier: user.tier,  // Include tier
  exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24) // 24 hours
};

const token = jwt.sign(payload, jwtSecret);
```

**In Lambda authorizer:**

```javascript
const decoded = jwt.verify(token, jwtSecret);
return {
  principalId: decoded.userId,
  context: {
    userId: decoded.userId,
    tier: decoded.tier  // Available in event.requestContext.authorizer.tier
  }
};
```

### 3. Implement Rate Limiting in Lambda (Additional Layer)

**Why:** Extra protection against abuse
**Where:** DynamoDB with TTL

```javascript
async function checkRateLimit(userId, action) {
  const key = `${userId}:${action}:${Math.floor(Date.now() / 60000)}`; // Per minute

  const result = await dynamodb.get({
    TableName: 'snapitqr-rate-limits',
    Key: { key }
  }).promise();

  if (result.Item && result.Item.count >= RATE_LIMITS[action]) {
    return { allowed: false, retryAfter: 60 };
  }

  await dynamodb.update({
    TableName: 'snapitqr-rate-limits',
    Key: { key },
    UpdateExpression: 'ADD #count :inc SET #ttl = :ttl',
    ExpressionAttributeNames: {
      '#count': 'count',
      '#ttl': 'ttl'
    },
    ExpressionAttributeValues: {
      ':inc': 1,
      ':ttl': Math.floor(Date.now() / 1000) + 120  // Delete after 2 minutes
    }
  }).promise();

  return { allowed: true };
}
```

---

## Pricing Strategy

### Free Tier
- 100 short URLs
- 100 QR codes (static)
- 3 dynamic QR codes
- Basic analytics
- Password protection
- Expiration dates
- **Cost:** $0/month

### Starter Tier
- 1,000 short URLs
- 1,000 QR codes
- 50 dynamic QR codes
- Advanced analytics
- Custom aliases
- 1 custom domain
- **Cost:** $9/month or $90/year

### Pro Tier
- 10,000 short URLs
- 10,000 QR codes
- 500 dynamic QR codes
- Enterprise analytics
- Bulk operations
- 5 custom domains
- **Cost:** $29/month or $290/year

### Business Tier
- 100,000 short URLs
- 100,000 QR codes
- 5,000 dynamic QR codes
- Custom analytics
- API access
- Webhooks
- Unlimited custom domains
- Priority support
- **Cost:** $99/month or $990/year

---

## Monitoring

### CloudWatch Metrics

**Track:**
- Requests per tier per hour
- Throttled requests (429 errors)
- Rejected requests (403 errors due to limits)
- Average usage per tier

**CloudWatch Dashboard:**

```bash
aws cloudwatch put-dashboard \
  --dashboard-name snapitqr-usage \
  --dashboard-body file://dashboard.json
```

**dashboard.json:**

```json
{
  "widgets": [
    {
      "type": "metric",
      "properties": {
        "metrics": [
          ["AWS/ApiGateway", "Count", {"stat": "Sum"}],
          [".", "4XXError", {"stat": "Sum"}],
          [".", "5XXError", {"stat": "Sum"}]
        ],
        "period": 300,
        "stat": "Sum",
        "region": "us-east-1",
        "title": "API Gateway Requests"
      }
    }
  ]
}
```

---

## Summary

**Recommended Implementation:**

1. ✅ **API Gateway Usage Plans** - Rate limiting (requests/sec, requests/day)
2. ✅ **Lambda Tier Enforcement** - Feature limits (URL count, QR codes)
3. ✅ **JWT with Tier** - Fast tier lookup without DB call
4. ✅ **DynamoDB Tracking** - Per-user usage counts
5. ✅ **Anonymous Support** - Limited access without auth
6. ✅ **Stripe Integration** - Auto-assign usage plans on subscription

**Priority:**
1. Update Lambda with anonymous tier limits (High)
2. Create API Gateway usage plans (High)
3. Add rate limiting table (Medium)
4. Implement monitoring dashboard (Low)

---

**End of Usage Plan Strategy**
