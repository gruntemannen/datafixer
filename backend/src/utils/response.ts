import type { APIGatewayProxyResultV2 } from 'aws-lambda';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Amz-Date,X-Api-Key',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
};

export function success<T>(body: T): APIGatewayProxyResultV2 {
  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}

export function created<T>(body: T): APIGatewayProxyResultV2 {
  return {
    statusCode: 201,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}

export function badRequest(message: string): APIGatewayProxyResultV2 {
  return {
    statusCode: 400,
    headers: CORS_HEADERS,
    body: JSON.stringify({ error: message }),
  };
}

export function unauthorized(message: string = 'Unauthorized'): APIGatewayProxyResultV2 {
  return {
    statusCode: 401,
    headers: CORS_HEADERS,
    body: JSON.stringify({ error: message }),
  };
}

export function forbidden(message: string = 'Forbidden'): APIGatewayProxyResultV2 {
  return {
    statusCode: 403,
    headers: CORS_HEADERS,
    body: JSON.stringify({ error: message }),
  };
}

export function notFound(message: string = 'Not found'): APIGatewayProxyResultV2 {
  return {
    statusCode: 404,
    headers: CORS_HEADERS,
    body: JSON.stringify({ error: message }),
  };
}

export function serverError(message: string = 'Internal server error'): APIGatewayProxyResultV2 {
  return {
    statusCode: 500,
    headers: CORS_HEADERS,
    body: JSON.stringify({ error: message }),
  };
}

/**
 * Normalize a job summary to handle both the old schema (fieldsAdded)
 * and the new schema (fieldsFilled / fieldsDiscovered) stored in DynamoDB.
 * Old jobs processed before the schema migration only have `fieldsAdded`.
 */
export function normalizeSummary(
  summary: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!summary) return summary;

  if ('fieldsAdded' in summary && !('fieldsFilled' in summary)) {
    return {
      ...summary,
      fieldsFilled: (summary.fieldsAdded as number) ?? 0,
      fieldsDiscovered: 0,
    };
  }

  return summary;
}

// Extract user info from JWT claims in API Gateway event
export interface UserContext {
  userId: string;
  email: string;
  tenantId: string;
}

export function getUserContext(claims: Record<string, string> | undefined): UserContext {
  if (!claims) {
    throw new Error('No claims found in request');
  }

  const userId = claims.sub;
  const email = claims.email;
  // For MVP, use userId as tenantId. In multi-tenant setup, this would come from a custom claim.
  const tenantId = claims['custom:tenantId'] || userId;

  if (!userId) {
    throw new Error('User ID not found in claims');
  }

  return { userId, email, tenantId };
}
