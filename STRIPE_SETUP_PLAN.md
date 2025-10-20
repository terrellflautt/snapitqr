# Stripe Setup Plan for SnapIT QR & URL

## CRITICAL: Switch to LIVE Mode

All commands below must be run with LIVE Stripe keys. Update your Stripe CLI:
```bash
stripe login
# Select LIVE mode when prompted
```

## Step 1: Create LIVE Products

### Product 1: SnapIT QR & URL - Core
**Pricing Strategy**: Undercut Bitly's $29/mo professional tier
```bash
stripe products create \
  --name="SnapIT Core" \
  --description="Professional QR codes and short URLs with custom domain" \
  --statement-descriptor="SNAPIT CORE"
```

### Product 2: SnapIT QR & URL - Growth
```bash
stripe products create \
  --name="SnapIT Growth" \
  --description="Advanced features for growing businesses with team collaboration" \
  --statement-descriptor="SNAPIT GROWTH"
```

### Product 3: SnapIT QR & URL - Business
```bash
stripe products create \
  --name="SnapIT Business" \
  --description="Enterprise-grade with unlimited resources and dedicated support" \
  --statement-descriptor="SNAPIT BIZ"
```

## Step 2: Create LIVE Prices (use product IDs from above)

### Core Tier: $19/mo (undercuts Bitly's $29)
```bash
# Monthly
stripe prices create \
  --product=prod_XXX \
  --unit-amount=1900 \
  --currency=usd \
  --recurring[interval]=month \
  --nickname="Core Monthly"

# Yearly (save 20%)
stripe prices create \
  --product=prod_XXX \
  --unit-amount=18240 \
  --currency=usd \
  --recurring[interval]=year \
  --nickname="Core Yearly"
```

### Growth Tier: $69/mo
```bash
# Monthly
stripe prices create \
  --product=prod_YYY \
  --unit-amount=6900 \
  --currency=usd \
  --recurring[interval]=month \
  --nickname="Growth Monthly"

# Yearly (save 20%)
stripe prices create \
  --product=prod_YYY \
  --unit-amount=66240 \
  --currency=usd \
  --recurring[interval]=year \
  --nickname="Growth Yearly"
```

### Business Tier: $199/mo
```bash
# Monthly
stripe prices create \
  --product=prod_ZZZ \
  --unit-amount=19900 \
  --currency=usd \
  --recurring[interval]=month \
  --nickname="Business Monthly"

# Yearly (save 20%)
stripe prices create \
  --product=prod_ZZZ \
  --unit-amount=191040 \
  --currency=usd \
  --recurring[interval]=year \
  --nickname="Business Yearly"
```

## Step 3: Create LIVE Webhook Endpoint

```bash
stripe webhook_endpoints create \
  --url=https://api.snapitqr.com/stripe/webhook \
  --enabled-events=checkout.session.completed \
  --enabled-events=customer.subscription.created \
  --enabled-events=customer.subscription.updated \
  --enabled-events=customer.subscription.deleted \
  --enabled-events=invoice.payment_succeeded \
  --enabled-events=invoice.payment_failed \
  --description="SnapIT QR & URL production webhooks"
```

## Step 4: Update Backend Code

File: `snapitqr/backend/stripe-operations/index.js`

Replace price IDs (lines 11-18) with LIVE price IDs from Step 2:
```javascript
const PRICE_IDS = {
  core_monthly: 'price_LIVE_XXX',    // from Core Monthly above
  core_yearly: 'price_LIVE_XXX',     // from Core Yearly above
  growth_monthly: 'price_LIVE_YYY',  // from Growth Monthly above
  growth_yearly: 'price_LIVE_YYY',   // from Growth Yearly above
  business_monthly: 'price_LIVE_ZZZ',// from Business Monthly above
  business_yearly: 'price_LIVE_ZZZ'  // from Business Yearly above
};
```

Replace tier limits (lines 20-45):
```javascript
const TIER_LIMITS = {
  free: {
    staticQRs: Infinity,
    dynamicQRs: 10,              // Increased from 3 to 10 ✅
    shortURLs: 10,               // Added ✅
    customDomains: 0,
    apiCalls: 0,
    teamMembers: 0
  },
  core: {                         // Renamed from 'starter' ✅
    staticQRs: Infinity,
    dynamicQRs: 1000,            // Increased from 50 to 1000 ✅
    shortURLs: 1000,             // Increased ✅
    customDomains: 1,            // This is the KEY feature ✅
    apiCalls: 10000,
    teamMembers: 1,
    dataRetention: '1 year'
  },
  growth: {                       // Renamed from 'pro' ✅
    staticQRs: Infinity,
    dynamicQRs: 5000,
    shortURLs: 5000,
    customDomains: 5,            // Increased from 1 to 5 ✅
    apiCalls: 100000,
    teamMembers: 5,
    dataRetention: 'unlimited'
  },
  business: {
    staticQRs: Infinity,
    dynamicQRs: Infinity,        // Truly unlimited ✅
    shortURLs: Infinity,
    customDomains: Infinity,
    apiCalls: Infinity,
    teamMembers: Infinity,
    dataRetention: 'unlimited'
  }
};
```

## Step 5: Update Frontend Pricing Pages

Both `snapitqr/frontend/index.html` and `snapiturl/frontend/index.html` need:

1. Update pricing display to match new tiers
2. Update price IDs in JavaScript
3. Add clear comparison with Bitly

## Step 6: Update AWS SSM Parameters

Store LIVE Stripe keys in AWS Parameter Store:
```bash
aws ssm put-parameter \
  --name "/snapitqr/stripe-secret-key" \
  --value "sk_live_YOUR_LIVE_KEY" \
  --type "SecureString" \
  --overwrite

aws ssm put-parameter \
  --name "/snapitqr/stripe-webhook-secret" \
  --value "whsec_YOUR_WEBHOOK_SECRET" \
  --type "SecureString" \
  --overwrite
```

## Step 7: Test Complete Flow

1. Sign up for free account
2. Create 10 dynamic QRs (should work)
3. Try to create 11th (should show upgrade modal)
4. Click upgrade, select Core tier
5. Complete Stripe checkout
6. Verify webhook updates user tier
7. Verify limits increased to 1000
8. Verify custom domain access enabled

---

## Competitive Positioning

**vs Bitly**:
- Bitly Free: 5 links, 2 QRs, no custom domain
- SnapIT Free: 10 dynamic links+QRs ✅ BETTER

- Bitly Core ($10/mo): 100 links, no custom domain ❌
- Bitly Growth ($29/mo): 500 links, 1 custom domain

- SnapIT Core ($19/mo): 1,000 links+QRs, 1 custom domain ✅ BETTER VALUE
- SnapIT Growth ($69/mo): 5,000 links+QRs, 5 custom domains ✅ MORE FEATURES

**Result**: SnapIT offers more for less at every tier!
