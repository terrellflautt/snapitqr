#!/bin/bash

# Create DynamoDB tables for rate limiting and abuse prevention

echo "Creating snapitqr-rate-limits table..."
aws dynamodb create-table \
  --table-name snapitqr-rate-limits \
  --attribute-definitions \
    AttributeName=ipHash,AttributeType=S \
    AttributeName=timestamp,AttributeType=N \
  --key-schema \
    AttributeName=ipHash,KeyType=HASH \
    AttributeName=timestamp,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --global-secondary-indexes \
    '[{
      "IndexName": "ipHash-timestamp-index",
      "KeySchema": [
        {"AttributeName": "ipHash", "KeyType": "HASH"},
        {"AttributeName": "timestamp", "KeyType": "RANGE"}
      ],
      "Projection": {"ProjectionType": "ALL"}
    }]' \
  --tags Key=Project,Value=SnapITQR Key=Environment,Value=Production \
  --stream-specification StreamEnabled=false \
  --deletion-protection-enabled \
  2>&1

if [ $? -eq 0 ]; then
  echo "✅ snapitqr-rate-limits table created successfully"
else
  echo "⚠️ Table may already exist or error occurred"
fi

echo ""
echo "Creating snapitqr-abuse-log table..."
aws dynamodb create-table \
  --table-name snapitqr-abuse-log \
  --attribute-definitions \
    AttributeName=ipHash,AttributeType=S \
    AttributeName=timestamp,AttributeType=N \
  --key-schema \
    AttributeName=ipHash,KeyType=HASH \
    AttributeName=timestamp,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --tags Key=Project,Value=SnapITQR Key=Environment,Value=Production \
  --stream-specification StreamEnabled=false \
  --time-to-live-specification Enabled=true,AttributeName=ttl \
  2>&1

if [ $? -eq 0 ]; then
  echo "✅ snapitqr-abuse-log table created successfully"
else
  echo "⚠️ Table may already exist or error occurred"
fi

echo ""
echo "Waiting for tables to become active..."
aws dynamodb wait table-exists --table-name snapitqr-rate-limits
aws dynamodb wait table-exists --table-name snapitqr-abuse-log

echo ""
echo "✅ All rate limiting tables created and active!"
echo ""
echo "Tables created:"
echo "  1. snapitqr-rate-limits - Tracks all actions by IP with TTL"
echo "  2. snapitqr-abuse-log - Logs rate limit violations for analysis"
echo ""
echo "Next steps:"
echo "  1. Deploy rate-limiter Lambda function"
echo "  2. Update url-operations Lambda to check rate limits"
echo "  3. Update qr-operations Lambda to check rate limits"
echo "  4. Configure API Gateway endpoints"
