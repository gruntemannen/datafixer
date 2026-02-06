import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export interface StorageStackProps extends cdk.StackProps {
  projectName: string;
  environment: string;
}

export class StorageStack extends cdk.Stack {
  public readonly dataBucket: s3.Bucket;
  public readonly jobsTable: dynamodb.Table;
  public readonly rowsTable: dynamodb.Table;
  public readonly enrichmentCacheTable: dynamodb.Table;
  public readonly encryptionKey: kms.Key;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    const { projectName, environment } = props;

    // KMS key for encryption at rest
    this.encryptionKey = new kms.Key(this, 'EncryptionKey', {
      alias: `${projectName}-${environment}-key`,
      description: 'Encryption key for Data Cleanser',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // S3 Bucket for data storage (raw uploads, processed outputs)
    this.dataBucket = new s3.Bucket(this, 'DataBucket', {
      bucketName: `${projectName}-${environment}-data-${this.account}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'delete-incomplete-multipart',
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
        {
          id: 'move-to-ia-after-90-days',
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
        },
        {
          id: 'delete-temp-files',
          prefix: 'temp/',
          expiration: cdk.Duration.days(1),
        },
      ],
      cors: [
        {
          allowedHeaders: ['*'],
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST],
          allowedOrigins: ['*'], // Will be restricted via CloudFront in production
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
    });

    // Jobs Table - tracks processing jobs
    this.jobsTable = new dynamodb.Table(this, 'JobsTable', {
      tableName: `${projectName}-${environment}-jobs`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING }, // TENANT#<tenantId>
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING }, // JOB#<jobId>
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.encryptionKey,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'ttl',
    });

    // GSI for querying jobs by status
    this.jobsTable.addGlobalSecondaryIndex({
      indexName: 'status-index',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI for querying jobs by user
    this.jobsTable.addGlobalSecondaryIndex({
      indexName: 'user-index',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Rows Table - stores individual row data and results
    this.rowsTable = new dynamodb.Table(this, 'RowsTable', {
      tableName: `${projectName}-${environment}-rows`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING }, // JOB#<jobId>
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING }, // ROW#<rowIndex>
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.encryptionKey,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'ttl',
    });

    // GSI for querying rows with issues
    this.rowsTable.addGlobalSecondaryIndex({
      indexName: 'status-index',
      partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'rowStatus', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Enrichment Cache Table - caches enrichment results
    this.enrichmentCacheTable = new dynamodb.Table(this, 'EnrichmentCacheTable', {
      tableName: `${projectName}-${environment}-enrichment-cache`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING }, // ENTITY#<normalizedKey>
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING }, // SOURCE#<sourceType>
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.encryptionKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'ttl',
    });

    // Outputs
    new cdk.CfnOutput(this, 'DataBucketName', {
      value: this.dataBucket.bucketName,
      description: 'Data bucket name',
      exportName: `${projectName}-${environment}-data-bucket-name`,
    });

    new cdk.CfnOutput(this, 'JobsTableName', {
      value: this.jobsTable.tableName,
      description: 'Jobs table name',
      exportName: `${projectName}-${environment}-jobs-table-name`,
    });

    new cdk.CfnOutput(this, 'RowsTableName', {
      value: this.rowsTable.tableName,
      description: 'Rows table name',
      exportName: `${projectName}-${environment}-rows-table-name`,
    });

    new cdk.CfnOutput(this, 'EnrichmentCacheTableName', {
      value: this.enrichmentCacheTable.tableName,
      description: 'Enrichment cache table name',
      exportName: `${projectName}-${environment}-enrichment-cache-table-name`,
    });
  }
}
