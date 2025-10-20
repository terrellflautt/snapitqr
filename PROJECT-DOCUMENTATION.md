# SnapIT QR & URL Platform - Project Documentation

**Last Updated:** October 12, 2025
**Status:** Production Ready
**Author:** SnapIT Software Team

---

## Table of Contents

1. [Overview](#overview)
2. [How Both Services Work Together](#how-both-services-work-together)
3. [Project Structure](#project-structure)
4. [AWS Infrastructure](#aws-infrastructure)
5. [Deployment Guide](#deployment-guide)
6. [SSM Parameter Store](#ssm-parameter-store)
7. [GitHub Security](#github-security)
8. [Lambda Functions](#lambda-functions)
9. [Database Schema](#database-schema)
10. [API Endpoints](#api-endpoints)

---

## Overview

SnapIT Platform consists of two unified web applications:

- **snapitqr.com** - QR code generation focus (also does URL shortening)
- **snapiturl.com** - URL shortening focus (also does QR generation)

Both sites share:
- Same backend API (AWS Lambda + API Gateway)
- Same database (DynamoDB)
- Same authentication (Google OAuth)
- Same payment system (Stripe)
- Same user accounts

Users can use either domain and their data/account works on both sites.

---

## How Both Services Work Together

### Unified Backend Architecture

```
User visits snapitqr.com OR snapiturl.com
           ↓
    CloudFront CDN (S3 static hosting)
           ↓
    Single Page Application (HTML + JS)
           ↓
    API Gateway (hvfj8o1yb0)
           ↓
    Lambda Functions
           ↓
    DynamoDB Tables
           ↓
    User Dashboard (shows data from both sites)
```

### Shared Resources

1. **Authentication**
   - Google OAuth credentials shared
   - JWT tokens work on both domains
   - User profile stored once in `snapitqr-users` table

2. **Data Storage**
   - All URLs stored in `snapitqr-shorturls` table
   - All QR codes reference URLs in same table
   - Analytics stored in `snapitqr-analytics` table

3. **Domain Flexibility**
   - Users can choose domain for each short URL:
     - `https://api.snapitqr.com/r/abc123`
     - `https://api.snapiturl.com/r/abc123`
   - Both redirect to same Lambda function
   - Both count towards same usage limits

### User Experience Flow

**Scenario 1: User creates URL on snapiturl.com**
1. Visits snapiturl.com
2. Creates short URL (optional: sign in)
3. URL stored in `snapitqr-shorturls`
4. Can view it on snapiturl.com dashboard OR snapitqr.com dashboard
5. Can generate QR code for it on either site

**Scenario 2: User creates QR on snapitqr.com**
1. Visits snapitqr.com
2. Generates QR code
3. Backend automatically creates short URL
4. Both stored in `snapitqr-shorturls`
5. Can manage both on either site's dashboard

---

## Project Structure

### Root Directory Layout

```
snapitqr/
├── backend/
│   ├── auth-operations/
│   │   ├── index.js              # Google OAuth, user registration
│   │   ├── package.json
│   │   └── node_modules/
│   ├── url-operations/
│   │   ├── index.js              # URL shortening, redirects, CRUD
│   │   ├── package.json
│   │   └── node_modules/
│   ├── qr-operations/
│   │   ├── index.js              # QR code generation
│   │   ├── package.json
│   │   └── node_modules/
│   ├── analytics-operations/
│   │   ├── index.js              # Analytics queries, dashboard data
│   │   ├── package.json
│   │   └── node_modules/
│   └── stripe-operations/
│       ├── index.js              # Stripe webhooks, subscription management
│       ├── package.json
│       └── node_modules/
├── frontend/
│   ├── snapitqr.html             # QR-focused site (S3: snapit-qr-frontend)
│   ├── snapiturl.html            # URL-focused site (S3: snapit-url-frontend)
│   └── config.js                 # Shared config (API URLs, client IDs)
├── serverless.yml                # Infrastructure as Code
├── .gitignore                    # Protects sensitive files
├── PROJECT-DOCUMENTATION.md      # This file
└── README.md                     # Getting started guide
```

### Frontend Files Location

**S3 Buckets:**

1. **snapit-qr-frontend** (serves snapitqr.com)
   - `s3://snapit-qr-frontend/index.html` ← snapitqr.html
   - `s3://snapit-qr-frontend/config.js` ← config.js

2. **snapit-url-frontend** (serves snapiturl.com)
   - `s3://snapit-url-frontend/index.html` ← snapiturl.html
   - `s3://snapit-url-frontend/config.js` ← config.js

**CloudFront Distributions:**

1. **E273RP3KO0IY32** → snapitqr.com
2. **E3O5LGFPCS87PN** → snapiturl.com

### Backend Files Location

**Lambda Functions:**

All in AWS Lambda, region: us-east-1

1. `snapitqr-auth-operations` ← backend/auth-operations/index.js
2. `snapitqr-url-operations` ← backend/url-operations/index.js
3. `snapitqr-qr-operations` ← backend/qr-operations/index.js
4. `snapitqr-analytics-operations` ← backend/analytics-operations/index.js
5. `snapitqr-stripe-operations` ← backend/stripe-operations/index.js

**API Gateway:**

- REST API ID: `hvfj8o1yb0`
- Stage: `production`
- Custom domains:
  - api.snapitqr.com
  - api.snapiturl.com

---

## AWS Infrastructure

### DynamoDB Tables

1. **snapitqr-shorturls**
   - Primary Key: `shortCode` (String)
   - GSI: `userId-createdAt-index`
   - Stores: All short URLs and their metadata

2. **snapitqr-users**
   - Primary Key: `userId` (String)
   - Stores: User profiles, tier, usage counts

3. **snapitqr-analytics**
   - Primary Key: `eventId` (String)
   - GSI: `shortCode-timestamp-index`
   - Stores: Click events, analytics data
   - TTL: 1 year (automatic cleanup)

### API Gateway Routes

```
POST   /auth/google           → snapitqr-auth-operations
POST   /register/google       → snapitqr-auth-operations

POST   /url/shorten           → snapitqr-url-operations
GET    /url/list              → snapitqr-url-operations
GET    /short-urls            → snapitqr-url-operations
PUT    /url/{shortCode}       → snapitqr-url-operations
DELETE /url/{shortCode}       → snapitqr-url-operations
GET    /r/{shortCode}         → snapitqr-url-operations (redirect)

POST   /qr/generate           → snapitqr-qr-operations
GET    /qr/list               → snapitqr-qr-operations
GET    /qr-codes              → snapitqr-qr-operations

GET    /analytics/dashboard   → snapitqr-analytics-operations
GET    /dashboard-data        → snapitqr-analytics-operations

POST   /stripe/create-checkout → snapitqr-stripe-operations
POST   /stripe/webhook        → snapitqr-stripe-operations
```

### IAM Roles

**snapitqr-lambda-role**
- Permissions:
  - DynamoDB: Full access to snapitqr-* tables
  - CloudWatch: Log creation and writes
  - SSM: Read parameters (for secrets)

---

## Deployment Guide

### Frontend Deployment

**Deploy snapitqr.com:**

```bash
# 1. Upload files to S3
aws s3 cp /path/to/frontend/snapitqr.html s3://snapit-qr-frontend/index.html --content-type "text/html"
aws s3 cp /path/to/frontend/config.js s3://snapit-qr-frontend/config.js --content-type "application/javascript"

# 2. Invalidate CloudFront cache
aws cloudfront create-invalidation --distribution-id E273RP3KO0IY32 --paths "/*"

# 3. Wait 2-3 minutes for propagation

# 4. Test
curl https://snapitqr.com/
```

**Deploy snapiturl.com:**

```bash
# 1. Upload files to S3
aws s3 cp /path/to/frontend/snapiturl.html s3://snapit-url-frontend/index.html --content-type "text/html"
aws s3 cp /path/to/frontend/config.js s3://snapit-url-frontend/config.js --content-type "application/javascript"

# 2. Invalidate CloudFront cache
aws cloudfront create-invalidation --distribution-id E3O5LGFPCS87PN --paths "/*"

# 3. Wait 2-3 minutes for propagation

# 4. Test
curl https://snapiturl.com/
```

### Backend Deployment

**Deploy Lambda Function:**

```bash
# Navigate to function directory
cd backend/url-operations

# Create deployment package
python3 -c "
import zipfile
import os

with zipfile.ZipFile('function.zip', 'w', zipfile.ZIP_DEFLATED) as zipf:
    zipf.write('index.js')
    if os.path.exists('node_modules'):
        for root, dirs, files in os.walk('node_modules'):
            for file in files:
                file_path = os.path.join(root, file)
                arcname = os.path.relpath(file_path, '.')
                zipf.write(file_path, arcname)
"

# Deploy to AWS Lambda
aws lambda update-function-code \
  --function-name snapitqr-url-operations \
  --zip-file fileb://function.zip

# Wait for deployment to complete
aws lambda wait function-updated \
  --function-name snapitqr-url-operations

# Test
aws lambda invoke \
  --function-name snapitqr-url-operations \
  --payload '{"httpMethod":"GET","path":"/r/test"}' \
  response.json
```

**Deploy All Lambda Functions:**

```bash
#!/bin/bash
# deploy-all-lambdas.sh

FUNCTIONS=("auth-operations" "url-operations" "qr-operations" "analytics-operations" "stripe-operations")

for func in "${FUNCTIONS[@]}"; do
    echo "Deploying snapitqr-$func..."
    cd backend/$func

    # Create zip
    python3 -c "
import zipfile, os
with zipfile.ZipFile('function.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    z.write('index.js')
    if os.path.exists('node_modules'):
        for r, d, f in os.walk('node_modules'):
            for file in f:
                p = os.path.join(r, file)
                z.write(p, os.path.relpath(p, '.'))
    "

    # Deploy
    aws lambda update-function-code \
      --function-name snapitqr-$func \
      --zip-file fileb://function.zip

    cd ../..
done
```

---

## SSM Parameter Store

### Why Use SSM?

- **Security**: Secrets encrypted at rest
- **Version Control**: Track changes to secrets
- **Access Control**: IAM-based permissions
- **No Git Commits**: Sensitive data stays in AWS

### Required Parameters

Store these in AWS Systems Manager Parameter Store:

```bash
# Google OAuth Credentials
aws ssm put-parameter \
  --name /snapitqr/google-client-id \
  --type SecureString \
  --value "YOUR_GOOGLE_CLIENT_ID" \
  --description "Google OAuth Client ID for snapitqr.com and snapiturl.com"

aws ssm put-parameter \
  --name /snapitqr/google-client-secret \
  --type SecureString \
  --value "YOUR_GOOGLE_CLIENT_SECRET" \
  --description "Google OAuth Client Secret"

# Stripe Keys
aws ssm put-parameter \
  --name /snapitqr/stripe-publishable-key \
  --type String \
  --value "pk_live_..." \
  --description "Stripe Publishable Key (safe for frontend)"

aws ssm put-parameter \
  --name /snapitqr/stripe-secret-key \
  --type SecureString \
  --value "sk_live_..." \
  --description "Stripe Secret Key (backend only)"

aws ssm put-parameter \
  --name /snapitqr/stripe-webhook-secret \
  --type SecureString \
  --value "whsec_..." \
  --description "Stripe Webhook Signing Secret"

# JWT Secrets
aws ssm put-parameter \
  --name /snapitqr/jwt-secret \
  --type SecureString \
  --value "$(openssl rand -base64 32)" \
  --description "JWT signing secret"
```

### Reading from SSM in Lambda

**Example: auth-operations/index.js**

```javascript
const AWS = require('aws-sdk');
const ssm = new AWS.SSM();

// Cache parameters to avoid repeated SSM calls
let cachedParams = null;

async function getParameters() {
  if (cachedParams) return cachedParams;

  const params = await ssm.getParameters({
    Names: [
      '/snapitqr/google-client-id',
      '/snapitqr/google-client-secret',
      '/snapitqr/jwt-secret'
    ],
    WithDecryption: true
  }).promise();

  cachedParams = {};
  params.Parameters.forEach(p => {
    const key = p.Name.split('/').pop();
    cachedParams[key] = p.Value;
  });

  return cachedParams;
}

exports.handler = async (event) => {
  const params = await getParameters();
  const googleClientId = params['google-client-id'];
  // Use in OAuth flow...
};
```

### Reading from SSM in Frontend

**Frontend config.js should read from SSM at build time:**

```javascript
// config.js.template (committed to Git)
window.SNAPIT_CONFIG = {
    GOOGLE_CLIENT_ID: '{{GOOGLE_CLIENT_ID}}',
    STRIPE_PUBLISHABLE_KEY: '{{STRIPE_PUBLISHABLE_KEY}}',
    API_BASE_URL: 'https://api.snapitqr.com',
    API_BASE_URL_SNAPITURL: 'https://api.snapiturl.com',
};
```

**Build script replaces placeholders:**

```bash
#!/bin/bash
# build-config.sh

# Get values from SSM
GOOGLE_CLIENT_ID=$(aws ssm get-parameter --name /snapitqr/google-client-id --query Parameter.Value --output text)
STRIPE_KEY=$(aws ssm get-parameter --name /snapitqr/stripe-publishable-key --query Parameter.Value --output text)

# Replace placeholders
sed "s/{{GOOGLE_CLIENT_ID}}/$GOOGLE_CLIENT_ID/g" config.js.template | \
sed "s/{{STRIPE_PUBLISHABLE_KEY}}/$STRIPE_KEY/g" > config.js

echo "config.js built successfully"
```

---

## GitHub Security

### .gitignore Configuration

**Essential entries:**

```gitignore
# Sensitive configuration
config.js
.env
.env.local
.env.production

# Secrets and credentials
*.pem
*.key
*.cert
secrets/
credentials/

# AWS deployment packages
function.zip
*.zip

# Node modules (can be regenerated)
node_modules/

# Build artifacts
dist/
build/
*.log

# IDE files
.vscode/
.idea/
*.swp
*.swo

# OS files
.DS_Store
Thumbs.db

# Backup files
*-BACKUP-*.html
*.bak
```

### Files Safe to Commit

**✅ Safe:**
- `serverless.yml` (no secrets, only structure)
- `PROJECT-DOCUMENTATION.md`
- `README.md`
- `backend/*/index.js` (Lambda code without secrets)
- `backend/*/package.json`
- `frontend/*.html` (templates without client IDs)
- `config.js.template` (with placeholders)

**❌ Never Commit:**
- `config.js` (contains Google OAuth client ID)
- `.env` files
- `function.zip` (deployment packages)
- Any file with "BACKUP" in name
- API keys, secrets, credentials

### Pre-Commit Hook

**Create `.git/hooks/pre-commit`:**

```bash
#!/bin/bash

# Check for sensitive files
SENSITIVE_FILES=(
  "config.js"
  ".env"
  "function.zip"
)

for file in "${SENSITIVE_FILES[@]}"; do
  if git diff --cached --name-only | grep -q "$file"; then
    echo "ERROR: Attempting to commit sensitive file: $file"
    echo "Please remove it from staging: git reset HEAD $file"
    exit 1
  fi
done

# Check for hardcoded secrets
if git diff --cached | grep -i "sk_live_"; then
  echo "ERROR: Found Stripe secret key in staged changes"
  exit 1
fi

if git diff --cached | grep -i "AIza"; then
  echo "ERROR: Found Google API key in staged changes"
  exit 1
fi

echo "✅ Pre-commit checks passed"
exit 0
```

Make it executable:

```bash
chmod +x .git/hooks/pre-commit
```

---

## Lambda Functions

### 1. auth-operations

**File:** `backend/auth-operations/index.js`

**Endpoints:**
- `POST /auth/google` - Authenticate with Google OAuth
- `POST /register/google` - Register new user with Google

**Environment Variables:**
- None (reads from SSM)

**Permissions:**
- DynamoDB: snapitqr-users (read/write)
- SSM: Read /snapitqr/google-* parameters
- SSM: Read /snapitqr/jwt-secret

**Key Functions:**
- `verifyGoogleToken()` - Validates Google ID token
- `createJWT()` - Issues JWT for authenticated sessions
- `registerUser()` - Creates new user record

### 2. url-operations

**File:** `backend/url-operations/index.js`

**Endpoints:**
- `POST /url/shorten` - Create short URL
- `GET /url/list` - List user's URLs
- `GET /r/{shortCode}` - Redirect to original URL
- `PUT /url/{shortCode}` - Update URL destination
- `DELETE /url/{shortCode}` - Delete URL

**Environment Variables:**
- None

**Permissions:**
- DynamoDB: snapitqr-shorturls (read/write)
- DynamoDB: snapitqr-users (read)
- DynamoDB: snapitqr-analytics (write)

**Key Functions:**
- `shortenURL()` - Creates short URL with custom alias support
- `redirectURL()` - Handles redirect with click tracking
- `generateShortCode()` - Creates 6-character URL-safe code
- `checkUsageLimit()` - Enforces tier limits

**Tier Limits:**
```javascript
free: 100 URLs
starter: 1000 URLs
pro: 10000 URLs
business: 100000 URLs
```

### 3. qr-operations

**File:** `backend/qr-operations/index.js`

**Endpoints:**
- `POST /qr/generate` - Generate QR code
- `GET /qr/list` - List user's QR codes

**Permissions:**
- DynamoDB: snapitqr-shorturls (read/write)
- DynamoDB: snapitqr-users (read)

**Key Functions:**
- `generateQR()` - Creates QR code (calls url-operations internally)
- `listQRCodes()` - Returns QR codes with click stats

### 4. analytics-operations

**File:** `backend/analytics-operations/index.js`

**Endpoints:**
- `GET /analytics/dashboard` - Get dashboard data
- `GET /dashboard-data` - Alias for dashboard

**Permissions:**
- DynamoDB: snapitqr-analytics (read)
- DynamoDB: snapitqr-shorturls (read)

**Key Functions:**
- `getDashboardData()` - Aggregates clicks, top URLs, geography
- `getClickTimeSeries()` - Returns click data over time

### 5. stripe-operations

**File:** `backend/stripe-operations/index.js`

**Endpoints:**
- `POST /stripe/create-checkout` - Create Stripe checkout session
- `POST /stripe/webhook` - Handle Stripe webhooks

**Environment Variables:**
- Reads from SSM

**Permissions:**
- DynamoDB: snapitqr-users (read/write)
- SSM: Read /snapitqr/stripe-* parameters

**Key Functions:**
- `createCheckoutSession()` - Creates Stripe payment session
- `handleWebhook()` - Processes subscription events

---

## Database Schema

### snapitqr-shorturls

**Primary Key:** `shortCode` (String)

**Attributes:**
```javascript
{
  shortCode: "abc123",           // Primary key
  urlId: "uuid-v4",               // Unique ID
  userId: "google-oauth-id",      // Owner (or "anonymous")
  originalUrl: "https://...",     // Destination URL
  title: "My Link",               // User-defined title
  clicks: 0,                      // Total clicks (atomic counter)
  status: "active",               // active | inactive
  createdAt: "2025-10-12T...",   // ISO timestamp
  updatedAt: "2025-10-12T...",   // ISO timestamp
  expiresAt: null,                // Optional expiration
  passwordHash: null              // Optional password (SHA-256)
}
```

**GSI: userId-createdAt-index**
- Partition Key: `userId`
- Sort Key: `createdAt`
- Projection: ALL

### snapitqr-users

**Primary Key:** `userId` (String)

**Attributes:**
```javascript
{
  userId: "google-oauth-id",      // Primary key
  email: "user@example.com",
  name: "John Doe",
  picture: "https://...",
  tier: "free",                   // free | starter | pro | business
  stripeCustomerId: "cus_...",    // Stripe customer ID
  subscriptionId: "sub_...",      // Stripe subscription ID
  subscriptionStatus: "active",   // active | canceled | past_due
  usage: {
    shortURLs: 5,                 // Current usage count
    qrCodes: 3
  },
  createdAt: "2025-10-12T...",
  updatedAt: "2025-10-12T..."
}
```

### snapitqr-analytics

**Primary Key:** `eventId` (String)

**Attributes:**
```javascript
{
  eventId: "uuid-v4",             // Primary key
  eventType: "url_clicked",       // Event type
  shortCode: "abc123",
  urlId: "uuid-v4",
  userId: "google-oauth-id",
  timestamp: "2025-10-12T...",
  ttl: 1760290000,                // Auto-delete after 1 year
  metadata: {
    userAgent: "Mozilla/5.0...",
    sourceIp: "1.2.3.4",
    referer: "https://...",
    country: "US"
  }
}
```

**GSI: shortCode-timestamp-index**
- Partition Key: `shortCode`
- Sort Key: `timestamp`
- Projection: ALL

---

## API Endpoints

### Authentication

**POST /auth/google**

Request:
```json
{
  "credential": "google-id-token"
}
```

Response:
```json
{
  "success": true,
  "token": "jwt-token",
  "user": {
    "userId": "...",
    "email": "...",
    "name": "...",
    "tier": "free"
  }
}
```

### URL Operations

**POST /url/shorten**

Request:
```json
{
  "url": "https://example.com",
  "customAlias": "my-link",
  "domain": "snapiturl.com",
  "title": "My Cool Link",
  "expiresAt": "2025-12-31T23:59:59Z",
  "password": "optional-password"
}
```

Response:
```json
{
  "success": true,
  "urlId": "uuid-v4",
  "shortCode": "abc123",
  "shortUrl": "https://api.snapiturl.com/r/abc123",
  "originalUrl": "https://example.com",
  "domain": "snapiturl.com"
}
```

**GET /r/{shortCode}**

Redirects to original URL with 302 status.

Tracks click analytics automatically.

---

## Troubleshooting

### Frontend Issues

**Site shows old content:**
```bash
# Invalidate CloudFront cache
aws cloudfront create-invalidation --distribution-id E3O5LGFPCS87PN --paths "/*"

# Wait 2-3 minutes, then test
curl -I https://snapiturl.com/
```

**Google sign-in not working:**
1. Check config.js has correct GOOGLE_CLIENT_ID
2. Verify domain authorized in Google Console
3. Check browser console for errors

### Backend Issues

**Redirects return 404:**
```bash
# Check URL exists in database
aws dynamodb get-item \
  --table-name snapitqr-shorturls \
  --key '{"shortCode":{"S":"abc123"}}'

# Check Lambda logs
aws logs tail /aws/lambda/snapitqr-url-operations --since 10m

# Test Lambda directly
aws lambda invoke \
  --function-name snapitqr-url-operations \
  --payload '{"httpMethod":"GET","path":"/r/abc123","pathParameters":{"shortCode":"abc123"}}' \
  response.json
```

**Usage limits not enforcing:**
```bash
# Check user tier
aws dynamodb get-item \
  --table-name snapitqr-users \
  --key '{"userId":{"S":"google-oauth-id"}}'

# Check usage count
# Should see: usage: { shortURLs: 5 }
```

---

## Next Steps for Future Agents

When you need to work on this project:

1. **Read this document first** - Understand the architecture
2. **Check SSM for secrets** - Never hardcode credentials
3. **Test locally** - Use local HTML files before deploying
4. **Deploy backend first** - Then frontend
5. **Invalidate CloudFront** - Always after frontend changes
6. **Check logs** - CloudWatch logs are your friend

**Key Commands:**

```bash
# Check Lambda function code
aws lambda get-function --function-name snapitqr-url-operations

# Check API Gateway config
aws apigateway get-rest-api --rest-api-id hvfj8o1yb0

# Check DynamoDB table
aws dynamodb describe-table --table-name snapitqr-shorturls

# View recent logs
aws logs tail /aws/lambda/snapitqr-url-operations --follow

# Test redirect
curl -I https://api.snapiturl.com/r/abc123
```

---

**For Questions or Issues:**

1. Check CloudWatch logs first
2. Verify database records
3. Test Lambda functions directly
4. Check API Gateway stages
5. Review this documentation

---

**End of Documentation**
