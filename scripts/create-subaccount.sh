#!/bin/bash
# Bash script to create AWS subaccount for DataFixer
# Run this from your root account with AWS CLI configured

set -e

ACCOUNT_NAME="${1:-datafixer}"
EMAIL="${2:-}"
ROLE_NAME="${3:-OrganizationAccountAccessRole}"

if [ -z "$EMAIL" ]; then
    echo "Error: Email is required"
    echo "Usage: ./create-subaccount.sh <account-name> <email> [role-name]"
    echo "Example: ./create-subaccount.sh datafixer your+datafixer@yourdomain.com"
    exit 1
fi

echo "Creating AWS subaccount: $ACCOUNT_NAME"

# Step 1: Create the account
echo ""
echo "Step 1: Creating account..."
CREATE_RESULT=$(aws organizations create-account \
    --email "$EMAIL" \
    --account-name "$ACCOUNT_NAME" \
    --role-name "$ROLE_NAME" \
    --output json)

REQUEST_ID=$(echo $CREATE_RESULT | jq -r '.CreateAccountStatus.Id')
echo "Create request ID: $REQUEST_ID"

# Step 2: Wait for account creation
echo ""
echo "Step 2: Waiting for account creation..."
MAX_ATTEMPTS=30
ATTEMPT=0

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    sleep 10
    ATTEMPT=$((ATTEMPT + 1))
    
    STATUS=$(aws organizations describe-create-account-status \
        --create-account-request-id "$REQUEST_ID" \
        --output json)
    
    STATE=$(echo $STATUS | jq -r '.CreateAccountStatus.State')
    echo "  Attempt $ATTEMPT/$MAX_ATTEMPTS - Status: $STATE"
    
    if [ "$STATE" == "SUCCEEDED" ]; then
        ACCOUNT_ID=$(echo $STATUS | jq -r '.CreateAccountStatus.AccountId')
        echo ""
        echo "Account created successfully!"
        echo "Account ID: $ACCOUNT_ID"
        break
    elif [ "$STATE" == "FAILED" ]; then
        FAILURE_REASON=$(echo $STATUS | jq -r '.CreateAccountStatus.FailureReason')
        echo "Error: Account creation failed: $FAILURE_REASON"
        exit 1
    fi
done

if [ $ATTEMPT -ge $MAX_ATTEMPTS ]; then
    echo "Error: Timeout waiting for account creation"
    exit 1
fi

# Step 3: Create AWS CLI profile for the new account
echo ""
echo "Step 3: Creating AWS CLI profile..."

PROFILE_NAME="datafixer-deploy"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/$ROLE_NAME"

# Get the current profile/source profile
SOURCE_PROFILE="${AWS_PROFILE:-default}"

# Add profile to AWS config
AWS_CONFIG_FILE="${HOME}/.aws/config"

cat >> "$AWS_CONFIG_FILE" << EOF

[profile $PROFILE_NAME]
role_arn = $ROLE_ARN
source_profile = $SOURCE_PROFILE
region = eu-central-1
EOF

echo "Added profile '$PROFILE_NAME' to $AWS_CONFIG_FILE"

# Step 4: Test the new profile
echo ""
echo "Step 4: Testing new profile..."
if aws sts get-caller-identity --profile "$PROFILE_NAME" > /dev/null 2>&1; then
    echo "Successfully assumed role in account: $ACCOUNT_ID"
else
    echo "Warning: Could not test profile. You may need to wait a few minutes for the role to be available."
fi

# Output summary
echo ""
echo "========================================"
echo "SUBACCOUNT SETUP COMPLETE"
echo "========================================"
echo "Account Name: $ACCOUNT_NAME"
echo "Account ID: $ACCOUNT_ID"
echo "Account Email: $EMAIL"
echo "Role ARN: $ROLE_ARN"
echo "CLI Profile: $PROFILE_NAME"
echo ""
echo "To deploy, run:"
echo "  cd infra"
echo "  npm install"
echo "  npm run bootstrap -- --profile $PROFILE_NAME"
echo "  npm run deploy:subaccount"
echo "========================================"
