#!/bin/bash

# Create API Gateway for SnapIT QR with proper routing and usage plans

set -e

AWS_REGION="us-east-1"
API_NAME="snapitqr-unified-api"
STAGE_NAME="production"

echo "============================================"
echo "SnapIT QR - API Gateway Setup"
echo "============================================"
echo ""

# Get Lambda function ARNs
QR_LAMBDA_ARN=$(aws lambda get-function --function-name "snapitqr-qr-operations" --region "$AWS_REGION" --query 'Configuration.FunctionArn' --output text)
URL_LAMBDA_ARN=$(aws lambda get-function --function-name "snapitqr-url-operations" --region "$AWS_REGION" --query 'Configuration.FunctionArn' --output text)
AUTH_LAMBDA_ARN=$(aws lambda get-function --function-name "snapitqr-auth-operations" --region "$AWS_REGION" --query 'Configuration.FunctionArn' --output text)
STRIPE_LAMBDA_ARN=$(aws lambda get-function --function-name "snapitqr-stripe-operations" --region "$AWS_REGION" --query 'Configuration.FunctionArn' --output text)
AUTHORIZER_LAMBDA_ARN=$(aws lambda get-function --function-name "snapitqr-authorizer" --region "$AWS_REGION" --query 'Configuration.FunctionArn' --output text)

echo "Lambda functions found:"
echo "  QR Operations: $QR_LAMBDA_ARN"
echo "  URL Operations: $URL_LAMBDA_ARN"
echo "  Auth Operations: $AUTH_LAMBDA_ARN"
echo "  Stripe Operations: $STRIPE_LAMBDA_ARN"
echo "  Authorizer: $AUTHORIZER_LAMBDA_ARN"
echo ""

# Check if API already exists
API_ID=$(aws apigateway get-rest-apis --region "$AWS_REGION" --query "items[?name=='$API_NAME'].id" --output text)

if [ -n "$API_ID" ]; then
  echo "API Gateway already exists: $API_ID"
  echo "Using existing API..."
else
  echo "Creating new API Gateway..."
  API_ID=$(aws apigateway create-rest-api \
    --name "$API_NAME" \
    --description "Unified API for SnapIT QR and URL shortener" \
    --endpoint-configuration types=REGIONAL \
    --region "$AWS_REGION" \
    --query 'id' \
    --output text)
  echo "✓ Created API: $API_ID"
fi

# Get root resource ID
ROOT_ID=$(aws apigateway get-resources --rest-api-id "$API_ID" --region "$AWS_REGION" --query 'items[?path==`/`].id' --output text)

echo "Root resource ID: $ROOT_ID"
echo ""

# Create Lambda authorizer
echo "Creating Lambda authorizer..."

AUTHORIZER_ID=$(aws apigateway create-authorizer \
  --rest-api-id "$API_ID" \
  --name "snapitqr-rate-limit-authorizer" \
  --type TOKEN \
  --authorizer-uri "arn:aws:apigateway:${AWS_REGION}:lambda:path/2015-03-31/functions/${AUTHORIZER_LAMBDA_ARN}/invocations" \
  --identity-source "method.request.header.Authorization" \
  --authorizer-result-ttl-in-seconds 300 \
  --region "$AWS_REGION" \
  --query 'id' \
  --output text 2>/dev/null || \
  aws apigateway get-authorizers --rest-api-id "$API_ID" --region "$AWS_REGION" --query "items[?name=='snapitqr-rate-limit-authorizer'].id" --output text)

echo "✓ Authorizer ID: $AUTHORIZER_ID"

# Grant API Gateway permission to invoke authorizer Lambda
aws lambda add-permission \
  --function-name "snapitqr-authorizer" \
  --statement-id "apigateway-authorizer-invoke-$API_ID" \
  --action "lambda:InvokeFunction" \
  --principal "apigateway.amazonaws.com" \
  --source-arn "arn:aws:execute-api:${AWS_REGION}:*:${API_ID}/authorizers/${AUTHORIZER_ID}" \
  --region "$AWS_REGION" \
  2>/dev/null || echo "  (Permission already exists)"

echo ""
echo "Creating resources and methods..."

# Helper function to create resource
create_resource() {
  local parent_id=$1
  local path_part=$2

  # Check if resource exists
  RESOURCE_ID=$(aws apigateway get-resources \
    --rest-api-id "$API_ID" \
    --region "$AWS_REGION" \
    --query "items[?pathPart=='$path_part' && parentId=='$parent_id'].id" \
    --output text)

  if [ -z "$RESOURCE_ID" ]; then
    RESOURCE_ID=$(aws apigateway create-resource \
      --rest-api-id "$API_ID" \
      --parent-id "$parent_id" \
      --path-part "$path_part" \
      --region "$AWS_REGION" \
      --query 'id' \
      --output text)
  fi

  echo "$RESOURCE_ID"
}

# Helper function to create method with Lambda integration
create_method() {
  local resource_id=$1
  local http_method=$2
  local lambda_arn=$3
  local use_authorizer=$4

  # Create method
  aws apigateway put-method \
    --rest-api-id "$API_ID" \
    --resource-id "$resource_id" \
    --http-method "$http_method" \
    --authorization-type ${use_authorizer:+"CUSTOM"} \
    ${use_authorizer:+--authorizer-id "$AUTHORIZER_ID"} \
    --region "$AWS_REGION" \
    --no-cli-pager > /dev/null 2>&1 || true

  # Create integration
  aws apigateway put-integration \
    --rest-api-id "$API_ID" \
    --resource-id "$resource_id" \
    --http-method "$http_method" \
    --type AWS_PROXY \
    --integration-http-method POST \
    --uri "arn:aws:apigateway:${AWS_REGION}:lambda:path/2015-03-31/functions/${lambda_arn}/invocations" \
    --region "$AWS_REGION" \
    --no-cli-pager > /dev/null 2>&1 || true

  # Grant API Gateway permission to invoke Lambda
  local statement_id="apigateway-${http_method,,}-${resource_id}"
  aws lambda add-permission \
    --function-name "${lambda_arn##*:function:}" \
    --statement-id "$statement_id" \
    --action "lambda:InvokeFunction" \
    --principal "apigateway.amazonaws.com" \
    --source-arn "arn:aws:execute-api:${AWS_REGION}:*:${API_ID}/*/${http_method}/*" \
    --region "$AWS_REGION" \
    2>/dev/null || true
}

# Create /qr resource and methods
QR_ID=$(create_resource "$ROOT_ID" "qr")
echo "✓ /qr resource created"

QR_GENERATE_ID=$(create_resource "$QR_ID" "generate")
create_method "$QR_GENERATE_ID" "POST" "$QR_LAMBDA_ARN" "true"
create_method "$QR_GENERATE_ID" "OPTIONS" "$QR_LAMBDA_ARN" ""
echo "✓ /qr/generate methods created"

QR_LIST_ID=$(create_resource "$QR_ID" "list")
create_method "$QR_LIST_ID" "GET" "$QR_LAMBDA_ARN" "true"
create_method "$QR_LIST_ID" "OPTIONS" "$QR_LAMBDA_ARN" ""
echo "✓ /qr/list methods created"

QR_ID_RESOURCE=$(create_resource "$QR_ID" "{id}")
create_method "$QR_ID_RESOURCE" "GET" "$QR_LAMBDA_ARN" ""
create_method "$QR_ID_RESOURCE" "PUT" "$QR_LAMBDA_ARN" "true"
create_method "$QR_ID_RESOURCE" "DELETE" "$QR_LAMBDA_ARN" "true"
create_method "$QR_ID_RESOURCE" "OPTIONS" "$QR_LAMBDA_ARN" ""
echo "✓ /qr/{id} methods created"

# Create /url resource and methods
URL_ID=$(create_resource "$ROOT_ID" "url")
echo "✓ /url resource created"

URL_SHORTEN_ID=$(create_resource "$URL_ID" "shorten")
create_method "$URL_SHORTEN_ID" "POST" "$URL_LAMBDA_ARN" "true"
create_method "$URL_SHORTEN_ID" "OPTIONS" "$URL_LAMBDA_ARN" ""
echo "✓ /url/shorten methods created"

URL_LIST_ID=$(create_resource "$URL_ID" "list")
create_method "$URL_LIST_ID" "GET" "$URL_LAMBDA_ARN" "true"
create_method "$URL_LIST_ID" "OPTIONS" "$URL_LAMBDA_ARN" ""
echo "✓ /url/list methods created"

URL_CODE_RESOURCE=$(create_resource "$URL_ID" "{shortCode}")
create_method "$URL_CODE_RESOURCE" "GET" "$URL_LAMBDA_ARN" ""
create_method "$URL_CODE_RESOURCE" "PUT" "$URL_LAMBDA_ARN" "true"
create_method "$URL_CODE_RESOURCE" "DELETE" "$URL_LAMBDA_ARN" "true"
create_method "$URL_CODE_RESOURCE" "OPTIONS" "$URL_LAMBDA_ARN" ""
echo "✓ /url/{shortCode} methods created"

# Create /r/{shortCode} for redirects
R_ID=$(create_resource "$ROOT_ID" "r")
R_CODE_RESOURCE=$(create_resource "$R_ID" "{shortCode}")
create_method "$R_CODE_RESOURCE" "GET" "$URL_LAMBDA_ARN" ""
echo "✓ /r/{shortCode} redirect created"

# Create /auth resource and methods
AUTH_ID=$(create_resource "$ROOT_ID" "auth")
echo "✓ /auth resource created"

AUTH_GOOGLE_ID=$(create_resource "$AUTH_ID" "google")
create_method "$AUTH_GOOGLE_ID" "POST" "$AUTH_LAMBDA_ARN" ""
create_method "$AUTH_GOOGLE_ID" "OPTIONS" "$AUTH_LAMBDA_ARN" ""
echo "✓ /auth/google methods created"

AUTH_ME_ID=$(create_resource "$AUTH_ID" "me")
create_method "$AUTH_ME_ID" "GET" "$AUTH_LAMBDA_ARN" "true"
create_method "$AUTH_ME_ID" "OPTIONS" "$AUTH_LAMBDA_ARN" ""
echo "✓ /auth/me methods created"

# Create /stripe resource and methods
STRIPE_ID=$(create_resource "$ROOT_ID" "stripe")
echo "✓ /stripe resource created"

STRIPE_CHECKOUT_ID=$(create_resource "$STRIPE_ID" "create-checkout")
create_method "$STRIPE_CHECKOUT_ID" "POST" "$STRIPE_LAMBDA_ARN" "true"
create_method "$STRIPE_CHECKOUT_ID" "OPTIONS" "$STRIPE_LAMBDA_ARN" ""
echo "✓ /stripe/create-checkout methods created"

STRIPE_WEBHOOK_ID=$(create_resource "$STRIPE_ID" "webhook")
create_method "$STRIPE_WEBHOOK_ID" "POST" "$STRIPE_LAMBDA_ARN" ""
echo "✓ /stripe/webhook method created"

STRIPE_PORTAL_ID=$(create_resource "$STRIPE_ID" "portal")
create_method "$STRIPE_PORTAL_ID" "POST" "$STRIPE_LAMBDA_ARN" "true"
create_method "$STRIPE_PORTAL_ID" "OPTIONS" "$STRIPE_LAMBDA_ARN" ""
echo "✓ /stripe/portal methods created"

echo ""
echo "Deploying API to $STAGE_NAME stage..."

aws apigateway create-deployment \
  --rest-api-id "$API_ID" \
  --stage-name "$STAGE_NAME" \
  --description "Deployment with microservices Lambda architecture" \
  --region "$AWS_REGION" \
  --no-cli-pager > /dev/null

echo "✓ API deployed"

echo ""
echo "Creating usage plans..."

# Create usage plans for each tier
create_usage_plan() {
  local tier=$1
  local quota_limit=$2
  local rate_limit=$3
  local burst_limit=$4

  PLAN_NAME="snapitqr-${tier}-plan"

  # Check if plan exists
  PLAN_ID=$(aws apigateway get-usage-plans --region "$AWS_REGION" --query "items[?name=='$PLAN_NAME'].id" --output text)

  if [ -z "$PLAN_ID" ]; then
    PLAN_ID=$(aws apigateway create-usage-plan \
      --name "$PLAN_NAME" \
      --description "Usage plan for $tier tier" \
      --throttle "rateLimit=${rate_limit},burstLimit=${burst_limit}" \
      --quota "limit=${quota_limit},period=MONTH" \
      --api-stages "apiId=${API_ID},stage=${STAGE_NAME}" \
      --region "$AWS_REGION" \
      --query 'id' \
      --output text)
    echo "✓ Created usage plan: $tier (ID: $PLAN_ID)"
  else
    echo "  Usage plan already exists: $tier (ID: $PLAN_ID)"
  fi
}

create_usage_plan "free" "50000" "50" "100"
create_usage_plan "starter" "200000" "200" "400"
create_usage_plan "pro" "1000000" "500" "1000"
create_usage_plan "business" "100000000" "2000" "4000"

echo ""
echo "============================================"
echo "API Gateway Setup Complete!"
echo "============================================"
echo ""
echo "API Endpoint:"
echo "  https://${API_ID}.execute-api.${AWS_REGION}.amazonaws.com/${STAGE_NAME}"
echo ""
echo "Example requests:"
echo "  # Generate QR code (no auth)"
echo "  curl -X POST https://${API_ID}.execute-api.${AWS_REGION}.amazonaws.com/${STAGE_NAME}/qr/generate \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"content\":\"https://example.com\",\"type\":\"static\"}'"
echo ""
echo "  # Shorten URL (with auth)"
echo "  curl -X POST https://${API_ID}.execute-api.${AWS_REGION}.amazonaws.com/${STAGE_NAME}/url/shorten \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -H 'Authorization: Bearer YOUR_JWT_TOKEN' \\"
echo "    -d '{\"url\":\"https://example.com\"}'"
echo ""
