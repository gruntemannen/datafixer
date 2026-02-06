import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getJob } from '../../utils/dynamodb.js';
import { getDownloadPresignedUrl } from '../../utils/s3.js';
import { success, notFound, serverError, getUserContext, forbidden, badRequest } from '../../utils/response.js';
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'get-download-url' });

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

    const fileType = event.queryStringParameters?.type || 'csv'; // 'csv' or 'report'

    // Verify job exists and user owns it
    const job = await getJob(tenantId, jobId);
    if (!job) {
      return notFound('Job not found');
    }
    if (job.userId !== userId) {
      return forbidden('Access denied');
    }

    // Check job is completed
    if (job.status !== 'COMPLETED') {
      return badRequest('Job is not completed yet');
    }

    let fileKey: string | undefined;
    let fileName: string;

    if (fileType === 'csv') {
      fileKey = job.outputCsvKey;
      fileName = `${job.fileName.replace('.csv', '')}_cleaned.csv`;
    } else if (fileType === 'report') {
      fileKey = job.outputReportKey;
      fileName = `${job.fileName.replace('.csv', '')}_report.json`;
    } else {
      return badRequest('Invalid file type. Use "csv" or "report"');
    }

    if (!fileKey) {
      return notFound('Output file not found');
    }

    // Generate pre-signed URL (valid for 1 hour) with Content-Disposition to force download
    const downloadUrl = await getDownloadPresignedUrl(fileKey, 3600, fileName);

    logger.info('Generated download URL', { jobId, fileType });

    return success({
      downloadUrl,
      fileName,
      expiresIn: 3600,
    });
  } catch (error) {
    logger.error('Error generating download URL', { error });
    return serverError('Failed to generate download URL');
  }
}
