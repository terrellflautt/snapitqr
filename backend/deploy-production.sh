#!/bin/bash

# SnapIT QR - Master Production Deployment Script
# This script deploys the complete backend infrastructure

set -e

echo "============================================"
echo "SnapIT QR - Production Deployment"
echo "============================================"
echo ""
echo "This script will:"
echo "  1. Create IAM role for Lambda functions"
echo "  2. Setup SSM parameters (secrets)"
echo "  3. Build and deploy all Lambda functions"
echo "  4. Create API Gateway with proper routing"
echo "  5. Configure usage plans for all tiers"
echo ""

read -p "Continue with deployment? (y/n) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Deployment cancelled"
  exit 1
fi

# Make scripts executable
chmod +x create-iam-role.sh
chmod +x setup-ssm-parameters.sh
chmod +x deploy-all.sh
chmod +x create-api-gateway.sh

echo ""
echo "============================================"
echo "Step 1: Creating IAM Role"
echo "============================================"
echo ""

./create-iam-role.sh

echo ""
echo "============================================"
echo "Step 2: Setting up SSM Parameters"
echo "============================================"
echo ""

./setup-ssm-parameters.sh

echo ""
echo "============================================"
echo "Step 3: Deploying Lambda Functions"
echo "============================================"
echo ""

./deploy-all.sh

echo ""
echo "============================================"
echo "Step 4: Creating API Gateway"
echo "============================================"
echo ""

./create-api-gateway.sh

echo ""
echo "============================================"
echo "🎉 DEPLOYMENT COMPLETE! 🎉"
echo "============================================"
echo ""
echo "Your SnapIT QR backend is now live!"
echo ""
echo "Next steps:"
echo "  1. Update frontend to use the API endpoint above"
echo "  2. Configure Stripe webhook URL:"
echo "     https://YOUR_API_ID.execute-api.us-east-1.amazonaws.com/production/stripe/webhook"
echo "  3. Test all API endpoints"
echo "  4. Deploy frontend to S3/CloudFront"
echo ""
echo "Documentation:"
echo "  - Architecture: /mnt/c/Users/decry/Desktop/snapitqr-architecture.md"
echo "  - Stripe Setup: /mnt/c/Users/decry/Desktop/snapitqr-stripe-products-LIVE.md"
echo "  - Status: /mnt/c/Users/decry/Desktop/SNAPITQR-PRODUCTION-STATUS.md"
echo ""
