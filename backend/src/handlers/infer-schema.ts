import { getObject, putObject } from '../utils/s3.js';
import { updateJobStatus } from '../utils/dynamodb.js';
import { inferSchema as inferSchemaAI } from '../utils/bedrock.js';
import type { ParseCsvOutput, InferSchemaOutput, InferredSchema } from '../types/index.js';
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'infer-schema' });

interface ParsedData {
  headers: string[];
  rows: Array<{ rowIndex: number; data: Record<string, string> }>;
}

export async function handler(event: ParseCsvOutput): Promise<InferSchemaOutput> {
  const { jobId, tenantId, rawDataKey, totalRows, detectedDelimiter, hasHeader } = event;
  
  logger.info('Starting schema inference', { jobId });
  
  try {
    // Update job status
    await updateJobStatus(tenantId, jobId, 'INFERRING_SCHEMA');
    
    // Get parsed data
    const rawData = await getObject(rawDataKey);
    const parsedData: ParsedData = JSON.parse(rawData);
    
    // Get sample rows for schema inference
    const sampleSize = Math.min(10, parsedData.rows.length);
    const sampleRows = parsedData.rows.slice(0, sampleSize).map(r => 
      parsedData.headers.map(h => r.data[h] || '')
    );
    
    // Call Bedrock to infer schema
    const inferenceResult = await inferSchemaAI({
      headers: parsedData.headers,
      sampleRows,
    });
    
    // Build complete schema
    const schema: InferredSchema = {
      mappings: inferenceResult.mappings,
      unmappedColumns: inferenceResult.unmappedColumns,
      detectedDelimiter,
      hasHeader,
      encoding: 'UTF-8',
      totalRows,
    };
    
    // Log schema inference results
    logger.info('Schema inference completed', {
      jobId,
      mappedFields: schema.mappings.filter(m => m.canonicalField !== 'UNMAPPED').length,
      unmappedFields: schema.unmappedColumns.length,
    });
    
    // Update job with schema
    await updateJobStatus(tenantId, jobId, 'INFERRING_SCHEMA', {
      schema,
    });
    
    return {
      ...event,
      schema,
    };
  } catch (error) {
    logger.error('Error inferring schema', { error, jobId });
    await updateJobStatus(tenantId, jobId, 'FAILED', {
      errorMessage: error instanceof Error ? error.message : 'Unknown error during schema inference',
    });
    throw error;
  }
}
