import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getJob, deleteJob } from '../../utils/dynamodb.js';
import { deleteS3Object } from '../../utils/s3.js';
import { success, notFound, serverError, getUserContext, forbidden } from '../../utils/response.js';
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'delete-job' });

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  try {
    const userContext = getUserContext(event.requestContext.authorizer?.jwt?.claims as Record<string, string>);
    const { tenantId, userId } = userContext;

    const jobId = event.pathParameters?.jobId;
    if (!jobId) {
      return notFound('Job ID is required');
    }

    // Get the job to verify ownership and get file keys
    const job = await getJob(tenantId, jobId);
    if (!job) {
      return notFound('Job not found');
    }

    // Check user owns the job
    if (job.userId !== userId) {
      return forbidden('Access denied');
    }

    logger.info('Deleting job', { jobId, tenantId, userId });

    // Delete S3 objects (ignore errors if files don't exist)
    const s3DeletePromises: Promise<void>[] = [];
    
    if (job.fileKey) {
      s3DeletePromises.push(
        deleteS3Object(job.fileKey).catch(err => {
          logger.warn('Failed to delete uploaded file', { fileKey: job.fileKey, error: err });
        })
      );
    }
    
    if (job.outputCsvKey) {
      s3DeletePromises.push(
        deleteS3Object(job.outputCsvKey).catch(err => {
          logger.warn('Failed to delete output CSV', { outputCsvKey: job.outputCsvKey, error: err });
        })
      );
    }
    
    if (job.outputReportKey) {
      s3DeletePromises.push(
        deleteS3Object(job.outputReportKey).catch(err => {
          logger.warn('Failed to delete output report', { outputReportKey: job.outputReportKey, error: err });
        })
      );
    }

    // Wait for S3 deletions to complete
    await Promise.all(s3DeletePromises);

    // Delete DynamoDB records (job and all rows)
    await deleteJob(tenantId, jobId);

    logger.info('Job deleted successfully', { jobId });

    return success({ message: 'Job deleted successfully', jobId });
  } catch (error) {
    logger.error('Error deleting job', { error });
    return serverError('Failed to delete job');
  }
}
