#!/bin/bash

# SnapIT QR - Deploy All Lambda Functions
# This script builds and deploys all Lambda functions to AWS

set -e

echo "============================================"
echo "SnapIT QR Lambda Deployment Script"
echo "============================================"
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# AWS Configuration
AWS_REGION="us-east-1"
LAMBDA_ROLE_ARN="arn:aws:iam::692859945539:role/snapitqr-lambda-role"
LAMBDA_TIMEOUT=30
LAMBDA_MEMORY=512

# Lambda functions to deploy
declare -A LAMBDAS=(
  ["qr-operations"]="snapitqr-qr-operations"
  ["url-operations"]="snapitqr-url-operations"
  ["auth-operations"]="snapitqr-auth-operations"
  ["stripe-operations"]="snapitqr-stripe-operations"
  ["authorizer"]="snapitqr-authorizer"
)

# Function to build Lambda package
build_lambda() {
  local dir=$1
  local name=$2

  echo -e "${YELLOW}Building ${name}...${NC}"

  cd "$dir"

  # Install dependencies
  if [ -f "package.json" ]; then
    npm install --production --silent
  fi

  # Create deployment package
  zip -r "${name}.zip" . -x "*.zip" -x ".git/*" -x "node_modules/.cache/*" > /dev/null 2>&1

  echo -e "${GREEN}✓ Built ${name}.zip${NC}"

  cd ..
}

# Function to deploy Lambda
deploy_lambda() {
  local dir=$1
  local function_name=$2
  local zip_file="${dir}/${function_name}.zip"

  echo -e "${YELLOW}Deploying ${function_name}...${NC}"

  # Check if function exists
  if aws lambda get-function --function-name "$function_name" --region "$AWS_REGION" > /dev/null 2>&1; then
    # Update existing function
    aws lambda update-function-code \
      --function-name "$function_name" \
      --zip-file "fileb://${zip_file}" \
      --region "$AWS_REGION" \
      --no-cli-pager > /dev/null

    echo -e "${GREEN}✓ Updated ${function_name}${NC}"
  else
    # Create new function
    aws lambda create-function \
      --function-name "$function_name" \
      --runtime nodejs20.x \
      --role "$LAMBDA_ROLE_ARN" \
      --handler index.handler \
      --zip-file "fileb://${zip_file}" \
      --timeout "$LAMBDA_TIMEOUT" \
      --memory-size "$LAMBDA_MEMORY" \
      --region "$AWS_REGION" \
      --environment "Variables={S3_BUCKET=snapitqr-assets}" \
      --no-cli-pager > /dev/null

    echo -e "${GREEN}✓ Created ${function_name}${NC}"
  fi
}

# Main deployment process
echo "Step 1: Building Lambda packages..."
echo "-------------------------------------------"

for dir in "${!LAMBDAS[@]}"; do
  build_lambda "$dir" "${LAMBDAS[$dir]}"
done

echo ""
echo "Step 2: Deploying Lambda functions..."
echo "-------------------------------------------"

for dir in "${!LAMBDAS[@]}"; do
  deploy_lambda "$dir" "${LAMBDAS[$dir]}"
done

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}All Lambda functions deployed successfully!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""

# Display deployed functions
echo "Deployed functions:"
for function_name in "${LAMBDAS[@]}"; do
  ARN=$(aws lambda get-function --function-name "$function_name" --region "$AWS_REGION" --query 'Configuration.FunctionArn' --output text)
  echo -e "  ${GREEN}✓${NC} $function_name"
  echo -e "    ARN: $ARN"
done

echo ""
echo "Next steps:"
echo "  1. Create/update API Gateway with routes to these functions"
echo "  2. Configure Lambda authorizer for rate limiting"
echo "  3. Test API endpoints"
echo ""
