import { parse } from 'csv-parse';
import { getObject, putObject, generateRawDataKey } from '../utils/s3.js';
import { updateJobStatus } from '../utils/dynamodb.js';
import type { StepFunctionInput, ParseCsvOutput } from '../types/index.js';
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'parse-csv' });

// Detect delimiter from first few lines
function detectDelimiter(sample: string): string {
  const delimiters = [',', ';', '\t', '|'];
  const lines = sample.split('\n').slice(0, 5);
  
  let bestDelimiter = ',';
  let maxCount = 0;
  
  for (const delimiter of delimiters) {
    const counts = lines.map(line => line.split(delimiter).length - 1);
    const avgCount = counts.reduce((a, b) => a + b, 0) / counts.length;
    const isConsistent = counts.every(c => c === counts[0]);
    
    if (avgCount > maxCount && isConsistent) {
      maxCount = avgCount;
      bestDelimiter = delimiter;
    }
  }
  
  return bestDelimiter;
}

// Check if first row looks like headers
function hasHeader(firstRow: string[], secondRow: string[] | undefined): boolean {
  if (!secondRow) return false;
  
  // Headers are typically strings, data might have numbers
  const firstRowTypes = firstRow.map(cell => {
    if (/^\d+(\.\d+)?$/.test(cell.trim())) return 'number';
    if (/^\d{4}-\d{2}-\d{2}/.test(cell.trim())) return 'date';
    return 'string';
  });
  
  const secondRowTypes = secondRow.map(cell => {
    if (/^\d+(\.\d+)?$/.test(cell.trim())) return 'number';
    if (/^\d{4}-\d{2}-\d{2}/.test(cell.trim())) return 'date';
    return 'string';
  });
  
  // If first row is all strings and second row has mixed types, likely has header
  const firstAllStrings = firstRowTypes.every(t => t === 'string');
  const secondMixed = secondRowTypes.some(t => t !== 'string');
  
  return firstAllStrings && secondMixed;
}

export async function handler(event: StepFunctionInput): Promise<ParseCsvOutput> {
  const { jobId, tenantId, userId, fileKey, fileName } = event;
  
  logger.info('Starting CSV parsing', { jobId, fileKey });
  
  try {
    // Update job status
    await updateJobStatus(tenantId, jobId, 'PARSING');
    
    // Get file content
    const content = await getObject(fileKey);
    
    // Detect delimiter
    const delimiter = detectDelimiter(content);
    logger.info('Detected delimiter', { delimiter: delimiter === '\t' ? 'tab' : delimiter });
    
    // Parse CSV
    const records: string[][] = await new Promise((resolve, reject) => {
      const rows: string[][] = [];
      const parser = parse({
        delimiter,
        relaxColumnCount: true,
        skipEmptyLines: true,
        trim: true,
      });
      
      parser.on('readable', () => {
        let record;
        while ((record = parser.read()) !== null) {
          rows.push(record);
        }
      });
      
      parser.on('error', reject);
      parser.on('end', () => resolve(rows));
      
      parser.write(content);
      parser.end();
    });
    
    if (records.length === 0) {
      throw new Error('CSV file is empty');
    }
    
    // Detect if has header
    const hasHeaderRow = hasHeader(records[0], records[1]);
    
    // Extract headers and data
    const headers = hasHeaderRow ? records[0] : records[0].map((_, i) => `column_${i + 1}`);
    const dataRows = hasHeaderRow ? records.slice(1) : records;
    
    // Convert to objects
    const parsedData = dataRows.map((row, index) => ({
      rowIndex: index,
      data: Object.fromEntries(headers.map((h, i) => [h, row[i] || ''])),
    }));
    
    // Save parsed data to S3
    const rawDataKey = generateRawDataKey(tenantId, jobId);
    await putObject(rawDataKey, JSON.stringify({
      headers,
      rows: parsedData,
    }));
    
    // Update job with row count
    await updateJobStatus(tenantId, jobId, 'PARSING', {
      totalRows: parsedData.length,
    });
    
    logger.info('CSV parsing completed', { 
      jobId, 
      totalRows: parsedData.length,
      headerCount: headers.length,
      hasHeader: hasHeaderRow,
    });
    
    return {
      ...event,
      totalRows: parsedData.length,
      rawDataKey,
      detectedDelimiter: delimiter,
      hasHeader: hasHeaderRow,
    };
  } catch (error) {
    logger.error('Error parsing CSV', { error, jobId });
    await updateJobStatus(tenantId, jobId, 'FAILED', {
      errorMessage: error instanceof Error ? error.message : 'Unknown error during parsing',
    });
    throw error;
  }
}
