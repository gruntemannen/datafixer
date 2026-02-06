#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { StorageStack } from '../lib/stacks/storage-stack';
import { AuthStack } from '../lib/stacks/auth-stack';
import { ApiStack } from '../lib/stacks/api-stack';
import { ProcessingStack } from '../lib/stacks/processing-stack';
import { FrontendStack } from '../lib/stacks/frontend-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID,
  region: 'eu-central-1',
};

const projectName = app.node.tryGetContext('projectName') || 'datafixer';
const environment = app.node.tryGetContext('environment') || 'dev';

// Stack naming convention
const stackPrefix = `${projectName}-${environment}`;

// Storage Stack - S3 buckets and DynamoDB tables
const storageStack = new StorageStack(app, `${stackPrefix}-storage`, {
  env,
  stackName: `${stackPrefix}-storage`,
  description: 'DataFixer - Storage resources (S3, DynamoDB)',
  projectName,
  environment,
});

// Auth Stack - Cognito User Pool
const authStack = new AuthStack(app, `${stackPrefix}-auth`, {
  env,
  stackName: `${stackPrefix}-auth`,
  description: 'DataFixer - Authentication (Cognito)',
  projectName,
  environment,
});

// Processing Stack - Step Functions and Lambda
const processingStack = new ProcessingStack(app, `${stackPrefix}-processing`, {
  env,
  stackName: `${stackPrefix}-processing`,
  description: 'DataFixer - Processing (Step Functions, Lambda)',
  projectName,
  environment,
  dataBucket: storageStack.dataBucket,
  jobsTable: storageStack.jobsTable,
  rowsTable: storageStack.rowsTable,
  enrichmentCacheTable: storageStack.enrichmentCacheTable,
});

// API Stack - API Gateway and Lambda handlers
const apiStack = new ApiStack(app, `${stackPrefix}-api`, {
  env,
  stackName: `${stackPrefix}-api`,
  description: 'DataFixer - API (API Gateway, Lambda)',
  projectName,
  environment,
  userPool: authStack.userPool,
  userPoolClient: authStack.userPoolClient,
  dataBucket: storageStack.dataBucket,
  jobsTable: storageStack.jobsTable,
  rowsTable: storageStack.rowsTable,
  stateMachine: processingStack.stateMachine,
});

// Frontend Stack - S3 + CloudFront
const frontendStack = new FrontendStack(app, `${stackPrefix}-frontend`, {
  env,
  stackName: `${stackPrefix}-frontend`,
  description: 'DataFixer - Frontend (S3, CloudFront)',
  projectName,
  environment,
  apiEndpoint: apiStack.apiEndpoint,
  userPoolId: authStack.userPool.userPoolId,
  userPoolClientId: authStack.userPoolClient.userPoolClientId,
});

// Add dependencies
processingStack.addDependency(storageStack);
apiStack.addDependency(storageStack);
apiStack.addDependency(authStack);
apiStack.addDependency(processingStack);
frontendStack.addDependency(apiStack);
frontendStack.addDependency(authStack);

// Tags
cdk.Tags.of(app).add('Project', projectName);
cdk.Tags.of(app).add('Environment', environment);
cdk.Tags.of(app).add('ManagedBy', 'CDK');

app.synth();
