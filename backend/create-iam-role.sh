#!/bin/bash

# Create IAM role for Lambda functions

set -e

ROLE_NAME="snapitqr-lambda-role"
AWS_REGION="us-east-1"

echo "Creating IAM role: $ROLE_NAME"

# Trust policy for Lambda
TRUST_POLICY='{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}'

# Create role
aws iam create-role \
  --role-name "$ROLE_NAME" \
  --assume-role-policy-document "$TRUST_POLICY" \
  --description "Execution role for SnapIT QR Lambda functions" \
  || echo "Role already exists"

# Attach AWS managed policies
echo "Attaching managed policies..."

aws iam attach-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"

# Create custom policy for DynamoDB, S3, and SSM access
CUSTOM_POLICY='{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:Scan"
      ],
      "Resource": [
        "arn:aws:dynamodb:us-east-1:*:table/snapitqr-*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:PutObjectAcl"
      ],
      "Resource": [
        "arn:aws:s3:::snapitqr-assets/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "ssm:GetParameter"
      ],
      "Resource": [
        "arn:aws:ssm:us-east-1:*:parameter/snapitqr/*"
      ]
    }
  ]
}'

# Create custom policy
POLICY_ARN=$(aws iam create-policy \
  --policy-name "snapitqr-lambda-policy" \
  --policy-document "$CUSTOM_POLICY" \
  --query 'Policy.Arn' \
  --output text 2>/dev/null || aws iam list-policies --query "Policies[?PolicyName=='snapitqr-lambda-policy'].Arn" --output text)

# Attach custom policy
aws iam attach-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-arn "$POLICY_ARN"

echo "✓ IAM role created and configured: $ROLE_NAME"
echo ""
echo "Role ARN:"
aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text
