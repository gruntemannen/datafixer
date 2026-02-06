import { updateJobStatus } from '../utils/dynamodb.js';
import type { GenerateOutputsOutput, Job } from '../types/index.js';
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'complete-job' });

interface CompleteJobInput extends GenerateOutputsOutput {
  status?: 'COMPLETED' | 'FAILED';
  error?: {
    Error: string;
    Cause: string;
  };
}

export async function handler(event: CompleteJobInput): Promise<{ jobId: string; status: string }> {
  const { jobId, tenantId, status, error, outputCsvKey, outputReportKey, summary } = event;
  
  const finalStatus = status || 'COMPLETED';
  const now = new Date().toISOString();
  
  logger.info('Completing job', { jobId, status: finalStatus });
  
  try {
    const updateFields: Partial<Job> = {
      completedAt: now,
    };
    
    if (finalStatus === 'COMPLETED') {
      updateFields.outputCsvKey = outputCsvKey;
      updateFields.outputReportKey = outputReportKey;
      updateFields.summary = summary;
    } else if (error) {
      updateFields.errorMessage = `${error.Error}: ${error.Cause}`;
    }
    
    await updateJobStatus(tenantId, jobId, finalStatus, updateFields);
    
    logger.info('Job completed', { 
      jobId, 
      status: finalStatus,
      summary: finalStatus === 'COMPLETED' ? summary : undefined,
    });
    
    return {
      jobId,
      status: finalStatus,
    };
  } catch (err) {
    logger.error('Error completing job', { error: err, jobId });
    
    // Try to mark as failed
    try {
      await updateJobStatus(tenantId, jobId, 'FAILED', {
        errorMessage: err instanceof Error ? err.message : 'Unknown error',
        completedAt: now,
      });
    } catch {
      // Ignore
    }
    
    throw err;
  }
}
