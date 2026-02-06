import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import { Construct } from 'constructs';

export interface ProcessingStackProps extends cdk.StackProps {
  projectName: string;
  environment: string;
  dataBucket: s3.Bucket;
  jobsTable: dynamodb.Table;
  rowsTable: dynamodb.Table;
  enrichmentCacheTable: dynamodb.Table;
}

export class ProcessingStack extends cdk.Stack {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: ProcessingStackProps) {
    super(scope, id, props);

    const { projectName, environment, dataBucket, jobsTable, rowsTable, enrichmentCacheTable } = props;

    // Common Lambda environment variables
    const commonEnv = {
      DATA_BUCKET: dataBucket.bucketName,
      JOBS_TABLE: jobsTable.tableName,
      ROWS_TABLE: rowsTable.tableName,
      ENRICHMENT_CACHE_TABLE: enrichmentCacheTable.tableName,
      AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      POWERTOOLS_SERVICE_NAME: projectName,
      LOG_LEVEL: 'INFO',
      // Optional: Tavily API key for web search enrichment (https://tavily.com)
      SEARCH_API_KEY: this.node.tryGetContext('searchApiKey') || '',
      // Optional: UK Companies House API key (https://developer.company-information.service.gov.uk/)
      COMPANIES_HOUSE_API_KEY: this.node.tryGetContext('companiesHouseApiKey') || '',
      // Optional: OpenCorporates API key (https://api.opencorporates.com/)
      OPENCORPORATES_API_KEY: this.node.tryGetContext('opencorporatesApiKey') || '',
    };

    // Common Lambda props
    const commonLambdaProps: Partial<lambdaNodejs.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      tracing: lambda.Tracing.ACTIVE,
      environment: commonEnv,
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
        forceDockerBundling: false,
      },
    };

    // Lambda: Parse CSV
    const parseCsvFn = new lambdaNodejs.NodejsFunction(this, 'ParseCsvFunction', {
      ...commonLambdaProps,
      functionName: `${projectName}-${environment}-parse-csv`,
      entry: path.join(__dirname, '../../../backend/src/handlers/parse-csv.ts'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(10),
      memorySize: 1024,
    });

    // Lambda: Infer Schema
    const inferSchemaFn = new lambdaNodejs.NodejsFunction(this, 'InferSchemaFunction', {
      ...commonLambdaProps,
      functionName: `${projectName}-${environment}-infer-schema`,
      entry: path.join(__dirname, '../../../backend/src/handlers/infer-schema.ts'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
    });

    // Lambda: Validate Rows
    const validateRowsFn = new lambdaNodejs.NodejsFunction(this, 'ValidateRowsFunction', {
      ...commonLambdaProps,
      functionName: `${projectName}-${environment}-validate-rows`,
      entry: path.join(__dirname, '../../../backend/src/handlers/validate-rows.ts'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(10),
      memorySize: 1024,
    });

    // Lambda: Enrich Row (multi-source: VIES + web search + AI + cross-row)
    const enrichRowFn = new lambdaNodejs.NodejsFunction(this, 'EnrichRowFunction', {
      ...commonLambdaProps,
      functionName: `${projectName}-${environment}-enrich-row`,
      entry: path.join(__dirname, '../../../backend/src/handlers/enrich-row.ts'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(10), // Increased for VIES + web search + AI
      memorySize: 1024,
    });

    // Lambda: Generate Outputs
    const generateOutputsFn = new lambdaNodejs.NodejsFunction(this, 'GenerateOutputsFunction', {
      ...commonLambdaProps,
      functionName: `${projectName}-${environment}-generate-outputs`,
      entry: path.join(__dirname, '../../../backend/src/handlers/generate-outputs.ts'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(10),
      memorySize: 2048,
    });

    // Lambda: Complete Job
    const completeJobFn = new lambdaNodejs.NodejsFunction(this, 'CompleteJobFunction', {
      ...commonLambdaProps,
      functionName: `${projectName}-${environment}-complete-job`,
      entry: path.join(__dirname, '../../../backend/src/handlers/complete-job.ts'),
      handler: 'handler',
    });

    // Grant permissions
    const allLambdas = [parseCsvFn, inferSchemaFn, validateRowsFn, enrichRowFn, generateOutputsFn, completeJobFn];
    
    for (const fn of allLambdas) {
      dataBucket.grantReadWrite(fn);
      jobsTable.grantReadWriteData(fn);
      rowsTable.grantReadWriteData(fn);
      enrichmentCacheTable.grantReadWriteData(fn);
    }

    // Bedrock permissions for AI-enabled lambdas
    // Using EU inference profile which routes to multiple EU regions
    const bedrockPolicy = new iam.PolicyStatement({
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
      ],
      resources: ['*'], // Inference profiles route to multiple regions
      conditions: {
        StringLike: {
          'aws:RequestedRegion': 'eu-*', // Allow all EU regions for inference profile
        },
      },
    });

    inferSchemaFn.addToRolePolicy(bedrockPolicy);
    validateRowsFn.addToRolePolicy(bedrockPolicy);
    enrichRowFn.addToRolePolicy(bedrockPolicy);

    // Step Functions Definition
    const updateJobStatus = (status: string) => new tasks.DynamoUpdateItem(this, `UpdateJob${status}`, {
      table: jobsTable,
      key: {
        pk: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.tenantId')),
        sk: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.format('JOB#{}', sfn.JsonPath.stringAt('$.jobId'))),
      },
      updateExpression: 'SET #status = :status, #updatedAt = :updatedAt',
      expressionAttributeNames: {
        '#status': 'status',
        '#updatedAt': 'updatedAt',
      },
      expressionAttributeValues: {
        ':status': tasks.DynamoAttributeValue.fromString(status),
        ':updatedAt': tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$$.State.EnteredTime')),
      },
      resultPath: sfn.JsonPath.DISCARD,
    });

    // Task: Parse CSV
    const parseCsvTask = new tasks.LambdaInvoke(this, 'ParseCSV', {
      lambdaFunction: parseCsvFn,
      outputPath: '$.Payload',
      retryOnServiceExceptions: true,
    });

    // Task: Infer Schema
    const inferSchemaTask = new tasks.LambdaInvoke(this, 'InferSchema', {
      lambdaFunction: inferSchemaFn,
      outputPath: '$.Payload',
      retryOnServiceExceptions: true,
    });

    // Task: Validate Rows
    const validateRowsTask = new tasks.LambdaInvoke(this, 'ValidateRows', {
      lambdaFunction: validateRowsFn,
      outputPath: '$.Payload',
      retryOnServiceExceptions: true,
    });

    // Task: Enrich Row (Map state)
    const enrichRowTask = new tasks.LambdaInvoke(this, 'EnrichSingleRow', {
      lambdaFunction: enrichRowFn,
      outputPath: '$.Payload',
    });

    const enrichRowsMap = new sfn.Map(this, 'EnrichRows', {
      maxConcurrency: 5, // Rate limiting for external API calls
      itemsPath: '$.rowBatches',
      parameters: {
        'jobId.$': '$.jobId',
        'tenantId.$': '$.tenantId',
        'schema.$': '$.schema',
        'batch.$': '$$.Map.Item.Value',
        'batchIndex.$': '$$.Map.Item.Index',
      },
      resultPath: '$.enrichmentResults',
    });
    enrichRowsMap.itemProcessor(enrichRowTask);

    // Task: Generate Outputs
    const generateOutputsTask = new tasks.LambdaInvoke(this, 'GenerateOutputs', {
      lambdaFunction: generateOutputsFn,
      outputPath: '$.Payload',
      retryOnServiceExceptions: true,
    });

    // Task: Complete Job
    const completeJobTask = new tasks.LambdaInvoke(this, 'CompleteJob', {
      lambdaFunction: completeJobFn,
      outputPath: '$.Payload',
      retryOnServiceExceptions: true,
    });

    // Error handling
    const jobFailed = new sfn.Fail(this, 'JobFailed', {
      cause: 'Job processing failed',
      error: 'JobProcessingError',
    });

    const handleError = new tasks.LambdaInvoke(this, 'HandleError', {
      lambdaFunction: completeJobFn,
      payload: sfn.TaskInput.fromObject({
        'jobId.$': '$.jobId',
        'tenantId.$': '$.tenantId',
        'status': 'FAILED',
        'error.$': '$.error',
      }),
      resultPath: sfn.JsonPath.DISCARD,
    }).next(jobFailed);

    // Build the state machine chain
    const definition = parseCsvTask
      .addCatch(handleError, { resultPath: '$.error' })
      .next(inferSchemaTask.addCatch(handleError, { resultPath: '$.error' }))
      .next(validateRowsTask.addCatch(handleError, { resultPath: '$.error' }))
      .next(enrichRowsMap.addCatch(handleError, { resultPath: '$.error' }))
      .next(generateOutputsTask.addCatch(handleError, { resultPath: '$.error' }))
      .next(completeJobTask);

    // Create log group for Step Functions
    const logGroup = new logs.LogGroup(this, 'StateMachineLogGroup', {
      logGroupName: `/aws/stepfunctions/${projectName}-${environment}-processing`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // State Machine
    this.stateMachine = new sfn.StateMachine(this, 'ProcessingStateMachine', {
      stateMachineName: `${projectName}-${environment}-processing`,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      tracingEnabled: true,
      logs: {
        destination: logGroup,
        level: sfn.LogLevel.ALL,
        includeExecutionData: true,
      },
    });

    // Outputs
    new cdk.CfnOutput(this, 'StateMachineArn', {
      value: this.stateMachine.stateMachineArn,
      description: 'Processing State Machine ARN',
      exportName: `${projectName}-${environment}-state-machine-arn`,
    });

    new cdk.CfnOutput(this, 'ParseCsvFunctionArn', {
      value: parseCsvFn.functionArn,
      description: 'Parse CSV Lambda ARN',
    });

    new cdk.CfnOutput(this, 'EnrichRowFunctionArn', {
      value: enrichRowFn.functionArn,
      description: 'Enrich Row Lambda ARN',
    });
  }
}
