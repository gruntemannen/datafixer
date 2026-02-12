import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { parse } from 'csv-parse';
import { getObject } from '../../utils/s3.js';
import { success, badRequest, serverError, getUserContext } from '../../utils/response.js';
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'preview-columns' });

const MAX_PREVIEW_ROWS = 3;

// Detect delimiter from first few lines (same logic as parse-csv)
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

// Check if first row looks like headers (same logic as parse-csv)
function hasHeader(firstRow: string[], secondRow: string[] | undefined): boolean {
  if (!secondRow) return false;

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

  const firstAllStrings = firstRowTypes.every(t => t === 'string');
  const secondMixed = secondRowTypes.some(t => t !== 'string');

  return firstAllStrings && secondMixed;
}

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  try {
    const userContext = getUserContext(event.requestContext.authorizer?.jwt?.claims as Record<string, string>);
    const { tenantId } = userContext;

    const fileKey = event.queryStringParameters?.fileKey;
    if (!fileKey) {
      return badRequest('fileKey query parameter is required');
    }

    // Verify the file belongs to this tenant
    if (!fileKey.startsWith(`uploads/${tenantId}/`)) {
      return badRequest('Access denied to this file');
    }

    logger.info('Previewing CSV columns', { tenantId, fileKey });

    // Read the file from S3
    const content = await getObject(fileKey);

    // Detect delimiter
    const delimiter = detectDelimiter(content);

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
          // Only need header + a few sample rows
          if (rows.length > MAX_PREVIEW_ROWS + 1) {
            parser.destroy();
            break;
          }
        }
      });

      parser.on('error', (err) => {
        // Ignore destroy errors from early termination
        if (err.message?.includes('premature')) {
          resolve(rows);
        } else {
          reject(err);
        }
      });
      parser.on('end', () => resolve(rows));
      parser.on('close', () => resolve(rows));

      parser.write(content);
      parser.end();
    });

    if (records.length === 0) {
      return badRequest('CSV file is empty');
    }

    // Detect if has header
    const hasHeaderRow = hasHeader(records[0], records[1]);

    // Extract headers (same sanitization as parse-csv)
    const rawHeaders = hasHeaderRow ? records[0] : records[0].map((_, i) => `column_${i + 1}`);
    let unnamedCounter = 0;
    const usedHeaders = new Set<string>();
    const headers = rawHeaders.map((h) => {
      let name = h.trim();
      if (!name) {
        unnamedCounter++;
        name = `unnamed_column_${unnamedCounter}`;
      }
      let uniqueName = name;
      let suffix = 2;
      while (usedHeaders.has(uniqueName)) {
        uniqueName = `${name}_${suffix}`;
        suffix++;
      }
      usedHeaders.add(uniqueName);
      return uniqueName;
    });

    // Get sample data rows
    const dataRows = hasHeaderRow ? records.slice(1) : records;
    const sampleRows = dataRows.slice(0, MAX_PREVIEW_ROWS).map(row =>
      Object.fromEntries(headers.map((h, i) => [h, row[i] || '']))
    );

    // Estimate total rows from the full content (count newlines)
    const totalRows = content.split('\n').filter(l => l.trim()).length - (hasHeaderRow ? 1 : 0);

    logger.info('Column preview generated', {
      tenantId,
      fileKey,
      columnCount: headers.length,
      sampleRowCount: sampleRows.length,
      totalRows,
    });

    return success({
      headers,
      sampleRows,
      totalRows,
      hasHeader: hasHeaderRow,
      detectedDelimiter: delimiter === '\t' ? 'tab' : delimiter,
    });
  } catch (error) {
    logger.error('Error previewing columns', { error });
    return serverError('Failed to preview CSV columns');
  }
}
