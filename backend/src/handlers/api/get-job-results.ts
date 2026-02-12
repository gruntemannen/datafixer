import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getJob, getRowsByJob, getRowsWithIssues } from '../../utils/dynamodb.js';
import { success, notFound, serverError, getUserContext, forbidden, badRequest } from '../../utils/response.js';
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'get-job-results' });

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

    // Verify job exists and user owns it
    const job = await getJob(tenantId, jobId);
    if (!job) {
      return notFound('Job not found');
    }
    if (job.userId !== userId) {
      return forbidden('Access denied');
    }

    // Parse query parameters
    const pageSize = Math.min(parseInt(event.queryStringParameters?.pageSize || '100', 10), 200);
    const filter = event.queryStringParameters?.filter; // 'enriched', 'validated', 'needs-review', or undefined for all
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

    let rows;
    let hasMore = false;
    let nextCursor: string | undefined;

    // Get all rows first, then apply filters
    // For better performance with large datasets, consider adding proper GSI indices
    const result = await getRowsByJob(jobId, 1000, lastEvaluatedKey); // Fetch more rows for filtering
    rows = result.rows;
    
    if (result.lastEvaluatedKey) {
      nextCursor = Buffer.from(JSON.stringify(result.lastEvaluatedKey)).toString('base64');
      hasMore = true;
    }

    // Apply filters
    if (filter === 'enriched') {
      rows = rows.filter(row => row.status === 'ENRICHED');
    } else if (filter === 'validated') {
      rows = rows.filter(row => row.status === 'VALIDATED');
    } else if (filter === 'needs-review') {
      rows = rows.filter(row => row.status === 'NEEDS_REVIEW' || row.status === 'ERROR');
    }
    
    // Apply pagination after filtering
    if (rows.length > pageSize) {
      rows = rows.slice(0, pageSize);
      hasMore = true;
    }

    logger.info('Retrieved job results', { jobId, rowCount: rows.length, filter });

    return success({
      jobId,
      status: job.status,
      rows: rows.map(row => ({
        rowIndex: row.rowIndex,
        originalData: row.originalData,
        canonicalData: row.canonicalData,
        validationIssues: row.validationIssues,
        enrichmentResults: row.enrichmentResults,
        status: row.status,
        entityCandidates: row.entityCandidates,
      })),
      totalRows: job.totalRows || 0,
      pageSize,
      nextCursor,
      hasMore,
    });
  } catch (error) {
    logger.error('Error getting job results', { error });
    return serverError('Failed to get job results');
  }
}
