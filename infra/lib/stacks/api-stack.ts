import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayIntegrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as apigatewayAuthorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import { Construct } from 'constructs';

export interface ApiStackProps extends cdk.StackProps {
  projectName: string;
  environment: string;
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  dataBucket: s3.Bucket;
  jobsTable: dynamodb.Table;
  rowsTable: dynamodb.Table;
  stateMachine: sfn.StateMachine;
}

export class ApiStack extends cdk.Stack {
  public readonly api: apigateway.HttpApi;
  public readonly apiEndpoint: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { 
      projectName, 
      environment, 
      userPool, 
      userPoolClient, 
      dataBucket, 
      jobsTable, 
      rowsTable,
      stateMachine 
    } = props;

    // Common Lambda environment variables
    const commonEnv = {
      DATA_BUCKET: dataBucket.bucketName,
      JOBS_TABLE: jobsTable.tableName,
      ROWS_TABLE: rowsTable.tableName,
      STATE_MACHINE_ARN: stateMachine.stateMachineArn,
      AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      POWERTOOLS_SERVICE_NAME: projectName,
      LOG_LEVEL: 'INFO',
    };

    // Common Lambda props
    const commonLambdaProps: Partial<lambdaNodejs.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
      environment: commonEnv,
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
        forceDockerBundling: false,
      },
    };

    // Lambda: Get Upload URL
    const getUploadUrlFn = new lambdaNodejs.NodejsFunction(this, 'GetUploadUrlFunction', {
      ...commonLambdaProps,
      functionName: `${projectName}-${environment}-get-upload-url`,
      entry: path.join(__dirname, '../../../backend/src/handlers/api/get-upload-url.ts'),
      handler: 'handler',
    });

    // Lambda: Create Job
    const createJobFn = new lambdaNodejs.NodejsFunction(this, 'CreateJobFunction', {
      ...commonLambdaProps,
      functionName: `${projectName}-${environment}-create-job`,
      entry: path.join(__dirname, '../../../backend/src/handlers/api/create-job.ts'),
      handler: 'handler',
    });

    // Lambda: Get Job Status
    const getJobStatusFn = new lambdaNodejs.NodejsFunction(this, 'GetJobStatusFunction', {
      ...commonLambdaProps,
      functionName: `${projectName}-${environment}-get-job-status`,
      entry: path.join(__dirname, '../../../backend/src/handlers/api/get-job-status.ts'),
      handler: 'handler',
    });

    // Lambda: List Jobs
    const listJobsFn = new lambdaNodejs.NodejsFunction(this, 'ListJobsFunction', {
      ...commonLambdaProps,
      functionName: `${projectName}-${environment}-list-jobs`,
      entry: path.join(__dirname, '../../../backend/src/handlers/api/list-jobs.ts'),
      handler: 'handler',
    });

    // Lambda: Get Job Results
    const getJobResultsFn = new lambdaNodejs.NodejsFunction(this, 'GetJobResultsFunction', {
      ...commonLambdaProps,
      functionName: `${projectName}-${environment}-get-job-results`,
      entry: path.join(__dirname, '../../../backend/src/handlers/api/get-job-results.ts'),
      handler: 'handler',
    });

    // Lambda: Get Download URL
    const getDownloadUrlFn = new lambdaNodejs.NodejsFunction(this, 'GetDownloadUrlFunction', {
      ...commonLambdaProps,
      functionName: `${projectName}-${environment}-get-download-url`,
      entry: path.join(__dirname, '../../../backend/src/handlers/api/get-download-url.ts'),
      handler: 'handler',
    });

    // Lambda: Delete Job
    const deleteJobFn = new lambdaNodejs.NodejsFunction(this, 'DeleteJobFunction', {
      ...commonLambdaProps,
      functionName: `${projectName}-${environment}-delete-job`,
      entry: path.join(__dirname, '../../../backend/src/handlers/api/delete-job.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(60), // Longer timeout for deleting many rows
    });

    // Grant permissions
    dataBucket.grantReadWrite(getUploadUrlFn);
    dataBucket.grantRead(createJobFn); // Needs read to verify file exists with HeadObject
    dataBucket.grantRead(getDownloadUrlFn);
    dataBucket.grantRead(getJobResultsFn);
    dataBucket.grantDelete(deleteJobFn);
    
    jobsTable.grantReadWriteData(createJobFn);
    jobsTable.grantReadData(getJobStatusFn);
    jobsTable.grantReadData(listJobsFn);
    jobsTable.grantReadData(getJobResultsFn);
    jobsTable.grantReadData(getDownloadUrlFn); // Needs to read job to get file keys
    jobsTable.grantReadWriteData(deleteJobFn);
    
    rowsTable.grantReadData(getJobResultsFn);
    rowsTable.grantReadWriteData(deleteJobFn);
    
    stateMachine.grantStartExecution(createJobFn);

    // HTTP API
    this.api = new apigateway.HttpApi(this, 'HttpApi', {
      apiName: `${projectName}-${environment}-api`,
      description: 'Data Cleanser API',
      corsPreflight: {
        allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key'],
        allowMethods: [
          apigateway.CorsHttpMethod.GET,
          apigateway.CorsHttpMethod.POST,
          apigateway.CorsHttpMethod.PUT,
          apigateway.CorsHttpMethod.DELETE,
          apigateway.CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: ['*'], // Will be restricted in production
        maxAge: cdk.Duration.hours(1),
      },
    });

    // JWT Authorizer
    const authorizer = new apigatewayAuthorizers.HttpJwtAuthorizer('JwtAuthorizer', 
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      {
        jwtAudience: [userPoolClient.userPoolClientId],
        identitySource: ['$request.header.Authorization'],
      }
    );

    // Routes
    // GET /upload-url - Get pre-signed URL for upload
    this.api.addRoutes({
      path: '/upload-url',
      methods: [apigateway.HttpMethod.GET],
      integration: new apigatewayIntegrations.HttpLambdaIntegration(
        'GetUploadUrlIntegration',
        getUploadUrlFn
      ),
      authorizer,
    });

    // POST /jobs - Create a new processing job
    this.api.addRoutes({
      path: '/jobs',
      methods: [apigateway.HttpMethod.POST],
      integration: new apigatewayIntegrations.HttpLambdaIntegration(
        'CreateJobIntegration',
        createJobFn
      ),
      authorizer,
    });

    // GET /jobs - List all jobs for the user
    this.api.addRoutes({
      path: '/jobs',
      methods: [apigateway.HttpMethod.GET],
      integration: new apigatewayIntegrations.HttpLambdaIntegration(
        'ListJobsIntegration',
        listJobsFn
      ),
      authorizer,
    });

    // GET /jobs/{jobId} - Get job status
    this.api.addRoutes({
      path: '/jobs/{jobId}',
      methods: [apigateway.HttpMethod.GET],
      integration: new apigatewayIntegrations.HttpLambdaIntegration(
        'GetJobStatusIntegration',
        getJobStatusFn
      ),
      authorizer,
    });

    // GET /jobs/{jobId}/results - Get job results (rows with issues)
    this.api.addRoutes({
      path: '/jobs/{jobId}/results',
      methods: [apigateway.HttpMethod.GET],
      integration: new apigatewayIntegrations.HttpLambdaIntegration(
        'GetJobResultsIntegration',
        getJobResultsFn
      ),
      authorizer,
    });

    // GET /jobs/{jobId}/download - Get download URL for output files
    this.api.addRoutes({
      path: '/jobs/{jobId}/download',
      methods: [apigateway.HttpMethod.GET],
      integration: new apigatewayIntegrations.HttpLambdaIntegration(
        'GetDownloadUrlIntegration',
        getDownloadUrlFn
      ),
      authorizer,
    });

    // DELETE /jobs/{jobId} - Delete a job and all associated data
    this.api.addRoutes({
      path: '/jobs/{jobId}',
      methods: [apigateway.HttpMethod.DELETE],
      integration: new apigatewayIntegrations.HttpLambdaIntegration(
        'DeleteJobIntegration',
        deleteJobFn
      ),
      authorizer,
    });

    this.apiEndpoint = this.api.apiEndpoint;

    // Outputs
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: this.api.apiEndpoint,
      description: 'API Gateway endpoint URL',
      exportName: `${projectName}-${environment}-api-endpoint`,
    });

    new cdk.CfnOutput(this, 'ApiId', {
      value: this.api.apiId,
      description: 'API Gateway ID',
      exportName: `${projectName}-${environment}-api-id`,
    });
  }
}
