#!/bin/bash

# Setup SSM Parameter Store parameters for SnapIT QR
# These parameters store sensitive configuration values

set -e

AWS_REGION="us-east-1"

echo "============================================"
echo "SnapIT QR - SSM Parameter Setup"
echo "============================================"
echo ""

# JWT Secret (generate random secret if not provided)
JWT_SECRET=${JWT_SECRET:-$(openssl rand -base64 64 | tr -d '\n')}

echo "Setting up SSM parameters..."

# JWT Secret
aws ssm put-parameter \
  --name "/snapitqr/jwt-secret" \
  --value "$JWT_SECRET" \
  --type "SecureString" \
  --overwrite \
  --region "$AWS_REGION" \
  --description "JWT secret for SnapIT QR authentication" \
  > /dev/null && echo "✓ /snapitqr/jwt-secret"

# Google Client ID (from environment or prompt)
if [ -z "$GOOGLE_CLIENT_ID" ]; then
  GOOGLE_CLIENT_ID="242648112266-u65iurckpjf01qkc9l5k7lqq44t4tmr9.apps.googleusercontent.com"
fi

aws ssm put-parameter \
  --name "/snapitqr/google-client-id" \
  --value "$GOOGLE_CLIENT_ID" \
  --type "String" \
  --overwrite \
  --region "$AWS_REGION" \
  --description "Google OAuth Client ID" \
  > /dev/null && echo "✓ /snapitqr/google-client-id"

# Stripe Secret Key (from environment or prompt)
if [ -z "$STRIPE_SECRET_KEY" ]; then
  echo ""
  echo "⚠️  STRIPE_SECRET_KEY not found in environment"
  echo "Please set it manually:"
  echo "  aws ssm put-parameter --name \"/snapitqr/stripe-secret-key\" --value \"sk_live_...\" --type \"SecureString\" --overwrite"
else
  aws ssm put-parameter \
    --name "/snapitqr/stripe-secret-key" \
    --value "$STRIPE_SECRET_KEY" \
    --type "SecureString" \
    --overwrite \
    --region "$AWS_REGION" \
    --description "Stripe secret key (live mode)" \
    > /dev/null && echo "✓ /snapitqr/stripe-secret-key"
fi

# Stripe Webhook Secret (from environment or prompt)
if [ -z "$STRIPE_WEBHOOK_SECRET" ]; then
  echo ""
  echo "⚠️  STRIPE_WEBHOOK_SECRET not found in environment"
  echo "Please set it manually after creating webhook endpoint:"
  echo "  aws ssm put-parameter --name \"/snapitqr/stripe-webhook-secret\" --value \"whsec_...\" --type \"SecureString\" --overwrite"
else
  aws ssm put-parameter \
    --name "/snapitqr/stripe-webhook-secret" \
    --value "$STRIPE_WEBHOOK_SECRET" \
    --type "SecureString" \
    --overwrite \
    --region "$AWS_REGION" \
    --description "Stripe webhook signing secret" \
    > /dev/null && echo "✓ /snapitqr/stripe-webhook-secret"
fi

echo ""
echo "✓ SSM parameters configured"
echo ""
echo "To view parameters:"
echo "  aws ssm get-parameter --name \"/snapitqr/jwt-secret\" --with-decryption --region $AWS_REGION"
