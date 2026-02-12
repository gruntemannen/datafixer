import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { createJob } from '../../utils/dynamodb.js';
import { getObjectMetadata } from '../../utils/s3.js';
import { created, badRequest, serverError, getUserContext } from '../../utils/response.js';
import type { Job, CreateJobRequest } from '../../types/index.js';
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'create-job' });
const sfnClient = new SFNClient({ region: process.env.AWS_REGION || 'eu-central-1' });

const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN!;
const MAX_FILE_SIZE_MB = 50;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  try {
    const userContext = getUserContext(event.requestContext.authorizer?.jwt?.claims as Record<string, string>);
    const { userId, tenantId } = userContext;

    // Parse request body
    if (!event.body) {
      return badRequest('Request body is required');
    }

    const body: CreateJobRequest = JSON.parse(event.body);
    const { fileKey, fileName, excludedColumns } = body;

    if (!fileKey || !fileName) {
      return badRequest('fileKey and fileName are required');
    }

    // Extract jobId from fileKey (uploads/{tenantId}/{jobId}/{fileName})
    const keyParts = fileKey.split('/');
    if (keyParts.length < 4) {
      return badRequest('Invalid fileKey format');
    }
    const jobId = keyParts[2];

    // Verify file exists and check size
    let fileSizeBytes: number;
    try {
      const metadata = await getObjectMetadata(fileKey);
      fileSizeBytes = metadata.contentLength;
      
      if (fileSizeBytes > MAX_FILE_SIZE_BYTES) {
        return badRequest(`File size exceeds maximum allowed size of ${MAX_FILE_SIZE_MB}MB`);
      }
    } catch (error) {
      logger.error('File not found or not accessible', { fileKey, error });
      return badRequest('File not found. Please upload the file first.');
    }

    const now = new Date().toISOString();

    // Create job record
    const job: Job = {
      jobId,
      tenantId,
      userId,
      status: 'PENDING',
      fileName,
      fileKey,
      fileSizeBytes,
      ...(excludedColumns && excludedColumns.length > 0 && { excludedColumns }),
      createdAt: now,
      updatedAt: now,
    };

    await createJob(job);

    // Start Step Functions execution
    const executionInput = {
      jobId,
      tenantId,
      userId,
      fileKey,
      fileName,
      ...(excludedColumns && excludedColumns.length > 0 && { excludedColumns }),
    };

    await sfnClient.send(new StartExecutionCommand({
      stateMachineArn: STATE_MACHINE_ARN,
      name: `job-${jobId}`,
      input: JSON.stringify(executionInput),
    }));

    logger.info('Job created and execution started', { jobId, tenantId, fileName });

    return created({
      jobId,
      status: job.status,
      fileName,
      createdAt: job.createdAt,
    });
  } catch (error) {
    logger.error('Error creating job', { error });
    return serverError('Failed to create job');
  }
}
