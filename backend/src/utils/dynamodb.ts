import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { 
  DynamoDBDocumentClient, 
  PutCommand, 
  GetCommand, 
  QueryCommand, 
  UpdateCommand,
  DeleteCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Job, ProcessedRow } from '../types/index.js';

const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'eu-central-1' });
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

const JOBS_TABLE = process.env.JOBS_TABLE!;
const ROWS_TABLE = process.env.ROWS_TABLE!;
const ENRICHMENT_CACHE_TABLE = process.env.ENRICHMENT_CACHE_TABLE!;

// Job operations
export async function createJob(job: Job): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: JOBS_TABLE,
    Item: {
      pk: `TENANT#${job.tenantId}`,
      sk: `JOB#${job.jobId}`,
      ...job,
    },
    ConditionExpression: 'attribute_not_exists(pk)',
  }));
}

export async function getJob(tenantId: string, jobId: string): Promise<Job | null> {
  const result = await docClient.send(new GetCommand({
    TableName: JOBS_TABLE,
    Key: {
      pk: `TENANT#${tenantId}`,
      sk: `JOB#${jobId}`,
    },
  }));
  return result.Item as Job | null;
}

export async function updateJobStatus(
  tenantId: string, 
  jobId: string, 
  status: string, 
  additionalFields?: Partial<Job>
): Promise<void> {
  let updateExpression = 'SET #status = :status, #updatedAt = :updatedAt';
  const expressionAttributeNames: Record<string, string> = {
    '#status': 'status',
    '#updatedAt': 'updatedAt',
  };
  const expressionAttributeValues: Record<string, unknown> = {
    ':status': status,
    ':updatedAt': new Date().toISOString(),
  };

  if (additionalFields) {
    Object.entries(additionalFields).forEach(([key, value]) => {
      if (value !== undefined) {
        updateExpression += `, #${key} = :${key}`;
        expressionAttributeNames[`#${key}`] = key;
        expressionAttributeValues[`:${key}`] = value;
      }
    });
  }

  await docClient.send(new UpdateCommand({
    TableName: JOBS_TABLE,
    Key: {
      pk: `TENANT#${tenantId}`,
      sk: `JOB#${jobId}`,
    },
    UpdateExpression: updateExpression,
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues,
  }));
}

export async function listJobsByUser(
  userId: string, 
  limit: number = 20,
  lastEvaluatedKey?: Record<string, unknown>
): Promise<{ jobs: Job[]; lastEvaluatedKey?: Record<string, unknown> }> {
  const result = await docClient.send(new QueryCommand({
    TableName: JOBS_TABLE,
    IndexName: 'user-index',
    KeyConditionExpression: 'userId = :userId',
    ExpressionAttributeValues: {
      ':userId': userId,
    },
    ScanIndexForward: false, // Most recent first
    Limit: limit,
    ExclusiveStartKey: lastEvaluatedKey,
  }));

  return {
    jobs: (result.Items || []) as Job[],
    lastEvaluatedKey: result.LastEvaluatedKey,
  };
}

export async function deleteJob(tenantId: string, jobId: string): Promise<void> {
  // Delete the job record
  await docClient.send(new DeleteCommand({
    TableName: JOBS_TABLE,
    Key: {
      pk: `TENANT#${tenantId}`,
      sk: `JOB#${jobId}`,
    },
  }));

  // Delete all rows associated with this job
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(new QueryCommand({
      TableName: ROWS_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': `JOB#${jobId}`,
      },
      ProjectionExpression: 'pk, sk',
      ExclusiveStartKey: lastEvaluatedKey,
    }));

    if (result.Items && result.Items.length > 0) {
      // Delete in batches of 25
      const batches: Array<{ pk: string; sk: string }[]> = [];
      for (let i = 0; i < result.Items.length; i += 25) {
        batches.push(result.Items.slice(i, i + 25) as Array<{ pk: string; sk: string }>);
      }

      for (const batch of batches) {
        await docClient.send(new BatchWriteCommand({
          RequestItems: {
            [ROWS_TABLE]: batch.map(item => ({
              DeleteRequest: {
                Key: {
                  pk: item.pk,
                  sk: item.sk,
                },
              },
            })),
          },
        }));
      }
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
}

// Row operations
export async function saveRow(jobId: string, row: ProcessedRow): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: ROWS_TABLE,
    Item: {
      pk: `JOB#${jobId}`,
      sk: `ROW#${String(row.rowIndex).padStart(10, '0')}`,
      jobId,
      rowStatus: row.status,
      ...row,
    },
  }));
}

export async function saveRowsBatch(jobId: string, rows: ProcessedRow[]): Promise<void> {
  // DynamoDB batch write supports max 25 items
  const batches: ProcessedRow[][] = [];
  for (let i = 0; i < rows.length; i += 25) {
    batches.push(rows.slice(i, i + 25));
  }

  for (const batch of batches) {
    await docClient.send(new BatchWriteCommand({
      RequestItems: {
        [ROWS_TABLE]: batch.map(row => ({
          PutRequest: {
            Item: {
              pk: `JOB#${jobId}`,
              sk: `ROW#${String(row.rowIndex).padStart(10, '0')}`,
              jobId,
              rowStatus: row.status,
              ...row,
            },
          },
        })),
      },
    }));
  }
}

export async function getRow(jobId: string, rowIndex: number): Promise<ProcessedRow | null> {
  const result = await docClient.send(new GetCommand({
    TableName: ROWS_TABLE,
    Key: {
      pk: `JOB#${jobId}`,
      sk: `ROW#${String(rowIndex).padStart(10, '0')}`,
    },
  }));
  return result.Item as ProcessedRow | null;
}

export async function getRowsByJob(
  jobId: string,
  limit: number = 100,
  lastEvaluatedKey?: Record<string, unknown>
): Promise<{ rows: ProcessedRow[]; lastEvaluatedKey?: Record<string, unknown> }> {
  const result = await docClient.send(new QueryCommand({
    TableName: ROWS_TABLE,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: {
      ':pk': `JOB#${jobId}`,
    },
    Limit: limit,
    ExclusiveStartKey: lastEvaluatedKey,
  }));

  return {
    rows: (result.Items || []) as ProcessedRow[],
    lastEvaluatedKey: result.LastEvaluatedKey,
  };
}

export async function getRowsWithIssues(
  jobId: string,
  limit: number = 100
): Promise<ProcessedRow[]> {
  const result = await docClient.send(new QueryCommand({
    TableName: ROWS_TABLE,
    IndexName: 'status-index',
    KeyConditionExpression: 'jobId = :jobId AND rowStatus = :status',
    ExpressionAttributeValues: {
      ':jobId': jobId,
      ':status': 'NEEDS_REVIEW',
    },
    Limit: limit,
  }));

  return (result.Items || []) as ProcessedRow[];
}

// Cross-row consistency: find other rows with the same company name in this job
export async function getRowsByCompanyName(
  jobId: string,
  companyName: string
): Promise<ProcessedRow[]> {
  // We need to scan rows for this job and filter by company name
  // For large datasets, this could be optimized with a GSI
  const normalizedName = companyName.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
  const allRows: ProcessedRow[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(new QueryCommand({
      TableName: ROWS_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': `JOB#${jobId}`,
      },
      Limit: 200,
      ExclusiveStartKey: lastKey,
    }));

    const rows = (result.Items || []) as ProcessedRow[];
    for (const row of rows) {
      const rowName = (row.canonicalData?.company_name || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
      if (rowName === normalizedName) {
        allRows.push(row);
      }
    }

    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return allRows;
}

// Enrichment cache operations
export interface EnrichmentCacheEntry {
  normalizedKey: string;
  sourceType: string;
  data: Record<string, unknown>;
  retrievedAt: string;
  ttl: number;
}

export async function getCachedEnrichment(
  normalizedKey: string,
  sourceType: string
): Promise<EnrichmentCacheEntry | null> {
  const result = await docClient.send(new GetCommand({
    TableName: ENRICHMENT_CACHE_TABLE,
    Key: {
      pk: `ENTITY#${normalizedKey}`,
      sk: `SOURCE#${sourceType}`,
    },
  }));
  return result.Item as EnrichmentCacheEntry | null;
}

export async function setCachedEnrichment(entry: EnrichmentCacheEntry): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60; // 7 days
  await docClient.send(new PutCommand({
    TableName: ENRICHMENT_CACHE_TABLE,
    Item: {
      pk: `ENTITY#${entry.normalizedKey}`,
      sk: `SOURCE#${entry.sourceType}`,
      ...entry,
      ttl,
    },
  }));
}

export function normalizeCompanyKey(companyName: string, country?: string): string {
  const normalized = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();
  return country ? `${normalized}:${country.toLowerCase()}` : normalized;
}

// Atomically increment enrichment batch counter
export async function incrementEnrichmentBatchCompleted(
  tenantId: string,
  jobId: string
): Promise<void> {
  await docClient.send(new UpdateCommand({
    TableName: JOBS_TABLE,
    Key: {
      pk: `TENANT#${tenantId}`,
      sk: `JOB#${jobId}`,
    },
    UpdateExpression: 'SET #completed = if_not_exists(#completed, :zero) + :one, #updatedAt = :updatedAt',
    ExpressionAttributeNames: {
      '#completed': 'enrichmentBatchesCompleted',
      '#updatedAt': 'updatedAt',
    },
    ExpressionAttributeValues: {
      ':one': 1,
      ':zero': 0,
      ':updatedAt': new Date().toISOString(),
    },
  }));
}
