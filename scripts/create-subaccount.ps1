# PowerShell script to create AWS subaccount for DataFixer
# Run this from your root account with AWS CLI configured

param(
    [string]$AccountName = "datafixer",
    [string]$Email = "", # Required: unique email for the new account
    [string]$RoleName = "OrganizationAccountAccessRole"
)

if ([string]::IsNullOrEmpty($Email)) {
    Write-Error "Email is required. Usage: .\create-subaccount.ps1 -Email 'your+datafixer@yourdomain.com'"
    exit 1
}

Write-Host "Creating AWS subaccount: $AccountName" -ForegroundColor Cyan

# Step 1: Create the account
Write-Host "`nStep 1: Creating account..." -ForegroundColor Yellow
$createResult = aws organizations create-account `
    --email $Email `
    --account-name $AccountName `
    --role-name $RoleName `
    --output json | ConvertFrom-Json

$requestId = $createResult.CreateAccountStatus.Id
Write-Host "Create request ID: $requestId"

# Step 2: Wait for account creation
Write-Host "`nStep 2: Waiting for account creation..." -ForegroundColor Yellow
$maxAttempts = 30
$attempt = 0

do {
    Start-Sleep -Seconds 10
    $attempt++
    
    $status = aws organizations describe-create-account-status `
        --create-account-request-id $requestId `
        --output json | ConvertFrom-Json
    
    $state = $status.CreateAccountStatus.State
    Write-Host "  Attempt $attempt/$maxAttempts - Status: $state"
    
    if ($state -eq "SUCCEEDED") {
        $accountId = $status.CreateAccountStatus.AccountId
        Write-Host "`nAccount created successfully!" -ForegroundColor Green
        Write-Host "Account ID: $accountId"
        break
    }
    elseif ($state -eq "FAILED") {
        Write-Error "Account creation failed: $($status.CreateAccountStatus.FailureReason)"
        exit 1
    }
} while ($attempt -lt $maxAttempts)

if ($attempt -ge $maxAttempts) {
    Write-Error "Timeout waiting for account creation"
    exit 1
}

# Step 3: Create AWS CLI profile for the new account
Write-Host "`nStep 3: Creating AWS CLI profile..." -ForegroundColor Yellow

$profileName = "datafixer-deploy"
$roleArn = "arn:aws:iam::${accountId}:role/$RoleName"

# Get the current profile/source profile
$sourceProfile = $env:AWS_PROFILE
if ([string]::IsNullOrEmpty($sourceProfile)) {
    $sourceProfile = "default"
}

# Add profile to AWS config
$awsConfigPath = "$env:USERPROFILE\.aws\config"
$profileConfig = @"

[profile $profileName]
role_arn = $roleArn
source_profile = $sourceProfile
region = eu-central-1
"@

Add-Content -Path $awsConfigPath -Value $profileConfig
Write-Host "Added profile '$profileName' to $awsConfigPath"

# Step 4: Test the new profile
Write-Host "`nStep 4: Testing new profile..." -ForegroundColor Yellow
try {
    $identity = aws sts get-caller-identity --profile $profileName --output json | ConvertFrom-Json
    Write-Host "Successfully assumed role in account: $($identity.Account)" -ForegroundColor Green
}
catch {
    Write-Warning "Could not test profile. You may need to wait a few minutes for the role to be available."
}

# Output summary
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "SUBACCOUNT SETUP COMPLETE" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Account Name: $AccountName"
Write-Host "Account ID: $accountId"
Write-Host "Account Email: $Email"
Write-Host "Role ARN: $roleArn"
Write-Host "CLI Profile: $profileName"
Write-Host "`nTo deploy, run:"
Write-Host "  cd infra"
Write-Host "  npm install"
Write-Host "  npm run bootstrap -- --profile $profileName"
Write-Host "  npm run deploy:subaccount"
Write-Host "========================================" -ForegroundColor Cyan
