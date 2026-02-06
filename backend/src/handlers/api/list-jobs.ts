import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { listJobsByUser } from '../../utils/dynamodb.js';
import { success, serverError, getUserContext, normalizeSummary } from '../../utils/response.js';
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'list-jobs' });

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  try {
    const userContext = getUserContext(event.requestContext.authorizer?.jwt?.claims as Record<string, string>);
    const { userId } = userContext;

    const limit = parseInt(event.queryStringParameters?.limit || '20', 10);
    const cursor = event.queryStringParameters?.cursor;

    // Decode cursor if provided
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    if (cursor) {
      try {
        lastEvaluatedKey = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8'));
      } catch {
        // Invalid cursor, ignore
      }
    }

    const { jobs, lastEvaluatedKey: newLastKey } = await listJobsByUser(userId, limit, lastEvaluatedKey);

    // Encode next cursor
    let nextCursor: string | undefined;
    if (newLastKey) {
      nextCursor = Buffer.from(JSON.stringify(newLastKey)).toString('base64');
    }

    logger.info('Listed jobs', { userId, count: jobs.length });

    return success({
      jobs: jobs.map(job => ({
        jobId: job.jobId,
        status: job.status,
        fileName: job.fileName,
        totalRows: job.totalRows,
        summary: normalizeSummary(job.summary as Record<string, unknown> | undefined),
        createdAt: job.createdAt,
        completedAt: job.completedAt,
      })),
      nextCursor,
      hasMore: !!newLastKey,
    });
  } catch (error) {
    logger.error('Error listing jobs', { error });
    return serverError('Failed to list jobs');
  }
}
