# GitHub Repository Setup Guide

**Date:** October 12, 2025
**Repositories:**
- https://github.com/terrellflautt/snapitqr1 (snapitqr.com)
- https://github.com/terrellflautt/snapiturl1 (snapiturl.com)

---

## Overview

Both repositories share the same backend but have different frontends optimized for their primary use case:
- **snapitqr1**: QR code generation focus
- **snapiturl1**: URL shortening focus

Each repository contains ONLY essential files. All secrets live in AWS SSM Parameter Store.

---

## Repository Structure

### What To Include

```
snapitqr/  (or snapiturl/)
├── frontend/
│   ├── index.html.template        # Frontend with placeholders
│   ├── config.js.template         # Config with {{PLACEHOLDERS}}
│   └── README.md                  # Frontend deployment guide
├── backend/
│   ├── auth-operations/
│   │   ├── index.js
│   │   ├── package.json
│   │   └── README.md
│   ├── url-operations/
│   │   ├── index.js
│   │   ├── package.json
│   │   └── README.md
│   ├── qr-operations/
│   │   ├── index.js
│   │   ├── package.json
│   │   └── README.md
│   ├── analytics-operations/
│   │   ├── index.js
│   │   ├── package.json
│   │   └── README.md
│   └── stripe-operations/
│       ├── index.js
│       ├── package.json
│       └── README.md
├── scripts/
│   ├── deploy-frontend.sh        # Deploys to S3 + CloudFront
│   ├── deploy-backend.sh         # Deploys all Lambda functions
│   ├── build-config.sh           # Builds config from SSM
│   └── setup-ssm.sh              # Creates SSM parameters
├── serverless.yml                 # Infrastructure as Code
├── .gitignore                     # Protects sensitive files
├── README.md                      # Quick start guide
├── PROJECT-DOCUMENTATION.md       # Complete documentation
├── USAGE-PLAN-STRATEGY.md        # Rate limiting guide
└── GITHUB-SETUP-GUIDE.md          # This file
```

### What NOT To Include

**❌ Never commit:**
- `frontend/index.html` (has real client IDs)
- `frontend/config.js` (has real keys)
- `backend/*/node_modules/` (regenerate with npm install)
- `backend/*/function.zip` (deployment artifacts)
- `.env` files
- Any file with "BACKUP" in name
- `*.pem`, `*.key`, `*.cert` (credentials)

---

## .gitignore Configuration

Create `.gitignore` in repository root:

```gitignore
# Sensitive configuration
config.js
*.env
.env*

# Built files (regenerate from templates)
frontend/index.html
!frontend/index.html.template

# Node modules (regenerate with npm install)
node_modules/

# Deployment artifacts
function.zip
*.zip
dist/
build/

# Credentials and secrets
*.pem
*.key
*.cert
secrets/
credentials/

# Logs
*.log
npm-debug.log*

# IDE files
.vscode/
.idea/
*.swp
*.swo

# OS files
.DS_Store
Thumbs.db

# Backup files
*-BACKUP-*
*.bak

# AWS CLI output
response.json
output.json
```

---

## Template Files

### frontend/index.html.template

**Purpose:** HTML file with placeholders for secrets

**Example:**

```html
<!DOCTYPE html>
<html>
<head>
    <title>SnapIT URL</title>
    <!-- Google OAuth will be loaded from config.js -->
</head>
<body>
    <script src="config.js"></script>
    <script>
        // Use window.SNAPIT_CONFIG.GOOGLE_CLIENT_ID
        console.log('Client ID:', window.SNAPIT_CONFIG.GOOGLE_CLIENT_ID);
    </script>
</body>
</html>
```

### frontend/config.js.template

**Purpose:** Config file with placeholders

```javascript
// config.js.template
// Build with: ./scripts/build-config.sh

window.SNAPIT_CONFIG = {
    GOOGLE_CLIENT_ID: '{{GOOGLE_CLIENT_ID}}',
    STRIPE_PUBLISHABLE_KEY: '{{STRIPE_PUBLISHABLE_KEY}}',
    API_BASE_URL: 'https://api.snapitqr.com',
    API_BASE_URL_SNAPITURL: 'https://api.snapiturl.com',
};
```

---

## Deployment Scripts

### scripts/build-config.sh

**Purpose:** Replace placeholders with real values from SSM

```bash
#!/bin/bash
set -e

echo "Building config.js from SSM parameters..."

# Get values from SSM
GOOGLE_CLIENT_ID=$(aws ssm get-parameter \
  --name /snapitqr/google-client-id \
  --query Parameter.Value \
  --output text)

STRIPE_KEY=$(aws ssm get-parameter \
  --name /snapitqr/stripe-publishable-key \
  --query Parameter.Value \
  --output text)

# Replace placeholders
sed "s|{{GOOGLE_CLIENT_ID}}|$GOOGLE_CLIENT_ID|g" frontend/config.js.template | \
sed "s|{{STRIPE_PUBLISHABLE_KEY}}|$STRIPE_KEY|g" > frontend/config.js

echo "✅ config.js built successfully"

# Note: index.html doesn't need placeholders since it loads config.js
cp frontend/index.html.template frontend/index.html

echo "✅ Files ready for deployment"
```

### scripts/deploy-frontend.sh

**Purpose:** Deploy frontend to S3 and invalidate CloudFront

```bash
#!/bin/bash
set -e

SITE=$1  # "snapitqr" or "snapiturl"

if [ -z "$SITE" ]; then
    echo "Usage: ./deploy-frontend.sh [snapitqr|snapiturl]"
    exit 1
fi

# Configuration
if [ "$SITE" == "snapitqr" ]; then
    BUCKET="snapit-qr-frontend"
    DISTRIBUTION_ID="E273RP3KO0IY32"
    DOMAIN="snapitqr.com"
elif [ "$SITE" == "snapiturl" ]; then
    BUCKET="snapit-url-frontend"
    DISTRIBUTION_ID="E3O5LGFPCS87PN"
    DOMAIN="snapiturl.com"
else
    echo "Invalid site: $SITE"
    exit 1
fi

echo "Deploying $SITE frontend..."

# Build config from SSM (if not already built)
if [ ! -f frontend/config.js ]; then
    ./scripts/build-config.sh
fi

# Upload to S3
aws s3 cp frontend/index.html s3://$BUCKET/index.html --content-type "text/html"
aws s3 cp frontend/config.js s3://$BUCKET/config.js --content-type "application/javascript"

echo "✅ Files uploaded to S3"

# Invalidate CloudFront
aws cloudfront create-invalidation --distribution-id $DISTRIBUTION_ID --paths "/*"

echo "✅ CloudFront cache invalidated"
echo "🌍 Live at: https://$DOMAIN"
echo "⏱️  Wait 2-3 minutes for propagation"
```

### scripts/deploy-backend.sh

**Purpose:** Deploy all Lambda functions

```bash
#!/bin/bash
set -e

echo "Deploying all Lambda functions..."

FUNCTIONS=("auth-operations" "url-operations" "qr-operations" "analytics-operations" "stripe-operations")

for func in "${FUNCTIONS[@]}"; do
    echo ""
    echo "📦 Deploying snapitqr-$func..."

    cd backend/$func

    # Install dependencies if needed
    if [ -f package.json ] && [ ! -d node_modules ]; then
        echo "Installing dependencies..."
        npm install --production
    fi

    # Create deployment package
    echo "Creating deployment package..."
    python3 << 'EOF'
import zipfile, os
with zipfile.ZipFile('function.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    z.write('index.js')
    if os.path.exists('node_modules'):
        for r, d, f in os.walk('node_modules'):
            for file in f:
                p = os.path.join(r, file)
                z.write(p, os.path.relpath(p, '.'))
EOF

    # Deploy to Lambda
    echo "Uploading to AWS Lambda..."
    aws lambda update-function-code \
      --function-name snapitqr-$func \
      --zip-file fileb://function.zip \
      > /dev/null

    # Wait for update to complete
    aws lambda wait function-updated --function-name snapitqr-$func

    # Clean up
    rm function.zip

    echo "✅ snapitqr-$func deployed"

    cd ../..
done

echo ""
echo "🎉 All Lambda functions deployed successfully!"
```

### scripts/setup-ssm.sh

**Purpose:** Initialize SSM parameters for new AWS account

```bash
#!/bin/bash
set -e

echo "Setting up SSM parameters..."
echo ""
echo "This script will create placeholder SSM parameters."
echo "You must replace the placeholder values with your real credentials."
echo ""
read -p "Continue? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
fi

# Google OAuth
aws ssm put-parameter \
  --name /snapitqr/google-client-id \
  --type String \
  --value "YOUR_GOOGLE_CLIENT_ID_HERE" \
  --description "Google OAuth Client ID for snapitqr.com and snapiturl.com" \
  --overwrite

aws ssm put-parameter \
  --name /snapitqr/google-client-secret \
  --type SecureString \
  --value "YOUR_GOOGLE_CLIENT_SECRET_HERE" \
  --description "Google OAuth Client Secret" \
  --overwrite

# Stripe Keys
aws ssm put-parameter \
  --name /snapitqr/stripe-publishable-key \
  --type String \
  --value "pk_live_PLACEHOLDER" \
  --description "Stripe Publishable Key (safe for frontend)" \
  --overwrite

aws ssm put-parameter \
  --name /snapitqr/stripe-secret-key \
  --type SecureString \
  --value "sk_live_PLACEHOLDER" \
  --description "Stripe Secret Key (backend only)" \
  --overwrite

aws ssm put-parameter \
  --name /snapitqr/stripe-webhook-secret \
  --type SecureString \
  --value "whsec_PLACEHOLDER" \
  --description "Stripe Webhook Signing Secret" \
  --overwrite

# JWT Secret
JWT_SECRET=$(openssl rand -base64 32)
aws ssm put-parameter \
  --name /snapitqr/jwt-secret \
  --type SecureString \
  --value "$JWT_SECRET" \
  --description "JWT signing secret" \
  --overwrite

echo ""
echo "✅ SSM parameters created!"
echo ""
echo "⚠️  IMPORTANT: Update the placeholder values with real credentials:"
echo ""
echo "aws ssm put-parameter --name /snapitqr/google-client-id --value 'YOUR_REAL_VALUE' --overwrite"
echo "aws ssm put-parameter --name /snapitqr/stripe-publishable-key --value 'pk_live_...' --overwrite"
echo ""
```

---

## Quick Start for New Developers

### 1. Clone Repository

```bash
git clone https://github.com/terrellflautt/snapitqr1.git
cd snapitqr1
```

### 2. Install Dependencies

```bash
cd backend/auth-operations && npm install && cd ../..
cd backend/url-operations && npm install && cd ../..
cd backend/qr-operations && npm install && cd ../..
cd backend/analytics-operations && npm install && cd ../..
cd backend/stripe-operations && npm install && cd ../..
```

### 3. Set Up SSM Parameters

```bash
chmod +x scripts/*.sh
./scripts/setup-ssm.sh
```

Then manually update placeholders in AWS Systems Manager:

```bash
aws ssm put-parameter \
  --name /snapitqr/google-client-id \
  --value "YOUR_REAL_GOOGLE_CLIENT_ID" \
  --overwrite
```

### 4. Deploy Backend

```bash
./scripts/deploy-backend.sh
```

### 5. Build & Deploy Frontend

```bash
./scripts/build-config.sh
./scripts/deploy-frontend.sh snapitqr  # or snapiturl
```

### 6. Test

```bash
curl https://snapitqr.com/
```

---

## Initial Repository Setup

### For snapitqr1 Repository

```bash
cd /path/to/snapitqr

# Initialize git (if not already)
git init

# Add remote
git remote add origin https://github.com/terrellflautt/snapitqr1.git

# Create .gitignore
cat > .gitignore << 'EOF'
# Sensitive files
config.js
*.env
frontend/index.html

# Node modules
node_modules/

# Build artifacts
function.zip
*.zip

# Backups
*-BACKUP-*
*.bak
EOF

# Create templates from existing files
cp frontend/snapitqr.html frontend/index.html.template

# Create template config
cat > frontend/config.js.template << 'EOF'
window.SNAPIT_CONFIG = {
    GOOGLE_CLIENT_ID: '{{GOOGLE_CLIENT_ID}}',
    STRIPE_PUBLISHABLE_KEY: '{{STRIPE_PUBLISHABLE_KEY}}',
    API_BASE_URL: 'https://api.snapitqr.com',
    API_BASE_URL_SNAPITURL: 'https://api.snapiturl.com',
};
EOF

# Copy scripts
mkdir -p scripts
# (Copy the script files created above)

# Add essential files only
git add backend/ frontend/*.template scripts/ serverless.yml README.md .gitignore

# Commit
git commit -m "Initial commit: Essential files only, no secrets"

# Push
git push -u origin main
```

### For snapiturl1 Repository

Same process, but use `snapiturl.html` as the template source.

---

## Pre-Commit Hook

Prevent accidental secret commits:

```bash
cat > .git/hooks/pre-commit << 'EOF'
#!/bin/bash

# Check for sensitive files
if git diff --cached --name-only | grep -E "config.js$|\.env|function.zip"; then
    echo "❌ ERROR: Attempting to commit sensitive file"
    echo "Blocked files:"
    git diff --cached --name-only | grep -E "config.js$|\.env|function.zip"
    exit 1
fi

# Check for hardcoded secrets
if git diff --cached | grep -E "sk_live_|AIza|whsec_"; then
    echo "❌ ERROR: Found hardcoded secrets in staged changes"
    exit 1
fi

echo "✅ Pre-commit checks passed"
EOF

chmod +x .git/hooks/pre-commit
```

---

## README.md Template

Create a README.md in each repository:

```markdown
# SnapIT QR - Production Files

Production-ready files for snapitqr.com (QR code generation platform).

## Quick Start

1. **Clone & Install**
   ```bash
   git clone https://github.com/terrellflautt/snapitqr1.git
   cd snapitqr1
   ./scripts/install-dependencies.sh
   ```

2. **Configure AWS**
   ```bash
   aws configure
   ./scripts/setup-ssm.sh
   ```

3. **Deploy**
   ```bash
   ./scripts/deploy-backend.sh
   ./scripts/deploy-frontend.sh snapitqr
   ```

## Architecture

- **Frontend**: S3 + CloudFront CDN
- **Backend**: AWS Lambda + API Gateway
- **Database**: DynamoDB
- **Auth**: Google OAuth + JWT
- **Payments**: Stripe

## Documentation

- [PROJECT-DOCUMENTATION.md](PROJECT-DOCUMENTATION.md) - Complete system documentation
- [USAGE-PLAN-STRATEGY.md](USAGE-PLAN-STRATEGY.md) - Rate limiting guide
- [GITHUB-SETUP-GUIDE.md](GITHUB-SETUP-GUIDE.md) - This file

## Security

All secrets stored in AWS Systems Manager Parameter Store:
- `/snapitqr/google-client-id`
- `/snapitqr/stripe-publishable-key`
- `/snapitqr/jwt-secret`

**Never commit config.js, .env, or credentials!**

## Support

For issues or questions, create an issue in this repository.
```

---

## Maintenance

### Updating Frontend

```bash
# Edit templates
vim frontend/index.html.template

# Build
./scripts/build-config.sh

# Deploy
./scripts/deploy-frontend.sh snapitqr

# Commit changes
git add frontend/index.html.template
git commit -m "Update frontend: [description]"
git push
```

### Updating Backend

```bash
# Edit Lambda function
vim backend/url-operations/index.js

# Deploy
cd backend/url-operations
./../../scripts/deploy-function.sh url-operations

# Commit changes
git add backend/url-operations/index.js
git commit -m "Fix: [description]"
git push
```

### Rotating Secrets

```bash
# Update in SSM
aws ssm put-parameter \
  --name /snapitqr/jwt-secret \
  --value "$(openssl rand -base64 32)" \
  --overwrite

# Rebuild config
./scripts/build-config.sh

# Redeploy frontend
./scripts/deploy-frontend.sh snapitqr

# Redeploy affected Lambda functions
./scripts/deploy-backend.sh
```

---

## Best Practices

### ✅ DO

- Commit template files (`.template`)
- Commit backend Lambda code (`index.js`, `package.json`)
- Commit scripts and documentation
- Use SSM for all secrets
- Test locally before pushing
- Write descriptive commit messages

### ❌ DON'T

- Commit `config.js` or `index.html` (built files)
- Commit `node_modules/` (regenerate with npm install)
- Commit `.env` files
- Hardcode secrets in code
- Push without testing
- Commit backup files

---

## CI/CD Integration (Future)

### GitHub Actions Example

```yaml
name: Deploy to Production

on:
  push:
    branches: [ main ]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2

      - name: Configure AWS
        uses: aws-actions/configure-aws-credentials@v1
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1

      - name: Deploy Backend
        run: ./scripts/deploy-backend.sh

      - name: Deploy Frontend
        run: |
          ./scripts/build-config.sh
          ./scripts/deploy-frontend.sh snapitqr
```

---

## Troubleshooting

### Issue: "config.js not found"

**Solution:** Build it first:
```bash
./scripts/build-config.sh
```

### Issue: "SSM parameter not found"

**Solution:** Create SSM parameters:
```bash
./scripts/setup-ssm.sh
```

### Issue: "Lambda deployment failed"

**Solution:** Check function size and timeout:
```bash
aws lambda get-function --function-name snapitqr-url-operations
```

---

## Summary

**Key Points:**
1. ✅ Only commit essential files (templates, Lambda code, scripts)
2. ✅ All secrets in SSM Parameter Store
3. ✅ Use deployment scripts for consistency
4. ✅ Pre-commit hooks prevent accidents
5. ✅ Templates ensure no hardcoded secrets

**Files in Git:**
- ✅ `frontend/*.template`
- ✅ `backend/*/index.js`
- ✅ `backend/*/package.json`
- ✅ `scripts/*.sh`
- ✅ Documentation files

**NOT in Git:**
- ❌ `frontend/config.js`
- ❌ `frontend/index.html`
- ❌ `node_modules/`
- ❌ `.env` files
- ❌ Credentials

---

**End of GitHub Setup Guide**
