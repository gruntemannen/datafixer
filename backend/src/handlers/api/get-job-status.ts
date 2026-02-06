import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getJob } from '../../utils/dynamodb.js';
import { success, notFound, serverError, getUserContext, forbidden, normalizeSummary } from '../../utils/response.js';
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'get-job-status' });

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

    const job = await getJob(tenantId, jobId);
    if (!job) {
      return notFound('Job not found');
    }

    // Check user owns the job
    if (job.userId !== userId) {
      return forbidden('Access denied');
    }

    logger.info('Retrieved job status', { jobId, status: job.status });

    return success({
      jobId: job.jobId,
      status: job.status,
      fileName: job.fileName,
      fileSizeBytes: job.fileSizeBytes,
      totalRows: job.totalRows,
      processedRows: job.processedRows,
      enrichmentBatchesTotal: job.enrichmentBatchesTotal,
      enrichmentBatchesCompleted: job.enrichmentBatchesCompleted,
      summary: normalizeSummary(job.summary as Record<string, unknown> | undefined),
      errorMessage: job.errorMessage,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt,
    });
  } catch (error) {
    logger.error('Error getting job status', { error });
    return serverError('Failed to get job status');
  }
}
