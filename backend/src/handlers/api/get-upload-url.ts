import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { getUploadPresignedUrl, generateUploadKey } from '../../utils/s3.js';
import { success, badRequest, serverError, getUserContext } from '../../utils/response.js';
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'get-upload-url' });

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  try {
    const userContext = getUserContext(event.requestContext.authorizer?.jwt?.claims as Record<string, string>);
    const { tenantId } = userContext;

    // Get filename from query params
    const fileName = event.queryStringParameters?.fileName;
    if (!fileName) {
      return badRequest('fileName query parameter is required');
    }

    // Validate file extension
    if (!fileName.toLowerCase().endsWith('.csv')) {
      return badRequest('Only CSV files are allowed');
    }

    // Generate unique job ID and file key
    const jobId = uuidv4();
    const fileKey = generateUploadKey(tenantId, jobId, fileName);

    // Generate pre-signed URL (valid for 1 hour)
    const uploadUrl = await getUploadPresignedUrl(fileKey, 'text/csv', 3600);

    logger.info('Generated upload URL', { tenantId, jobId, fileName });

    return success({
      uploadUrl,
      fileKey,
      jobId,
      expiresIn: 3600,
    });
  } catch (error) {
    logger.error('Error generating upload URL', { error });
    return serverError('Failed to generate upload URL');
  }
}
