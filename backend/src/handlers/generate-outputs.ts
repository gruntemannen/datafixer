import { stringify } from 'csv-stringify/sync';
import { putObject, getObject, generateOutputCsvKey, generateOutputReportKey } from '../utils/s3.js';
import { updateJobStatus, getRowsByJob } from '../utils/dynamodb.js';
import type { GenerateOutputsInput, GenerateOutputsOutput, ProcessedRow, Job } from '../types/index.js';
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'generate-outputs' });

// Canonical field names (used for report generation only)
const CANONICAL_FIELDS = [
  'company_name',
  'address_line1',
  'address_line2',
  'city',
  'state_province',
  'postal_code',
  'country',
  'website',
  'email',
  'phone',
  'vat_id',
  'registration_id',
  'industry',
];

interface ParsedData {
  headers: string[];
  allHeaders?: string[];
  rows: Array<{ rowIndex: number; data: Record<string, string>; excludedData?: Record<string, string> }>;
}

export async function handler(event: GenerateOutputsInput): Promise<GenerateOutputsOutput> {
  const { jobId, tenantId, userId, fileKey, fileName, schema, enrichmentResults, rawDataKey } = event;
  
  logger.info('Generating outputs', { jobId });
  
  try {
    // Update job status
    await updateJobStatus(tenantId, jobId, 'GENERATING_OUTPUTS');
    
    // Retrieve the original headers from the parsed raw data to preserve
    // the exact column order and include unmapped columns.
    // `allHeaders` includes excluded columns; falls back to `headers` for older jobs.
    const rawData = await getObject(rawDataKey);
    const parsedData: ParsedData = JSON.parse(rawData);
    const originalHeaders = parsedData.allHeaders || parsedData.headers;
    
    // Build a lookup of excluded column data per row index for CSV generation
    const excludedDataByRow = new Map<number, Record<string, string>>();
    for (const row of parsedData.rows) {
      if (row.excludedData) {
        excludedDataByRow.set(row.rowIndex, row.excludedData);
      }
    }
    
    // Collect all rows from DynamoDB
    const allRows: ProcessedRow[] = [];
    let lastKey: Record<string, unknown> | undefined;
    
    do {
      const result = await getRowsByJob(jobId, 100, lastKey);
      allRows.push(...result.rows);
      lastKey = result.lastEvaluatedKey;
    } while (lastKey);
    
    // Sort by row index
    allRows.sort((a, b) => a.rowIndex - b.rowIndex);
    
    // Build reverse mapping: canonicalField -> sourceColumn
    // This lets us write enriched/corrected values back into the original columns
    const canonicalToSource = new Map<string, string>();
    for (const mapping of schema.mappings) {
      if (mapping.canonicalField !== 'UNMAPPED') {
        canonicalToSource.set(mapping.canonicalField, mapping.sourceColumn);
      }
    }
    
    // Generate clean CSV: same columns, same order as the original file
    // (including excluded columns with their original values)
    const csvData = generateCleanCsv(allRows, originalHeaders, canonicalToSource, excludedDataByRow);
    const outputCsvKey = generateOutputCsvKey(tenantId, jobId);
    await putObject(outputCsvKey, csvData, 'text/csv');
    
    // Generate JSON report with all enrichment detail (canonical mappings,
    // confidence scores, validation issues, added fields without a source column)
    const report = generateReport(allRows, schema, jobId, fileName, originalHeaders, canonicalToSource);
    const outputReportKey = generateOutputReportKey(tenantId, jobId);
    await putObject(outputReportKey, JSON.stringify(report, null, 2), 'application/json');
    
    // Calculate summary
    // Split enrichment counts into fields that were written back to the CSV
    // vs. fields that were discovered but have no column in the original file
    const summary: Job['summary'] = {
      totalRows: allRows.length,
      validRows: allRows.filter(r => r.validationIssues.length === 0).length,
      rowsWithIssues: allRows.filter(r => r.validationIssues.length > 0).length,
      rowsEnriched: allRows.filter(r => (r.enrichmentResults?.length || 0) > 0).length,
      fieldsFilled: allRows.reduce((sum, r) =>
        sum + (r.enrichmentResults?.filter(c =>
          c.action === 'ADDED' && canonicalToSource.has(c.field)
        ).length || 0), 0),
      fieldsCorrected: allRows.reduce((sum, r) => 
        sum + (r.enrichmentResults?.filter(c => c.action === 'CORRECTED').length || 0), 0),
      fieldsDiscovered: allRows.reduce((sum, r) =>
        sum + (r.enrichmentResults?.filter(c =>
          c.action === 'ADDED' && !canonicalToSource.has(c.field)
        ).length || 0), 0),
    };
    
    logger.info('Outputs generated', { 
      jobId, 
      outputCsvKey, 
      outputReportKey,
      summary,
      originalColumnCount: originalHeaders.length,
    });
    
    return {
      jobId,
      tenantId,
      userId,
      fileKey,
      fileName,
      outputCsvKey,
      outputReportKey,
      summary,
    };
  } catch (error) {
    logger.error('Error generating outputs', { error, jobId });
    await updateJobStatus(tenantId, jobId, 'FAILED', {
      errorMessage: error instanceof Error ? error.message : 'Unknown error during output generation',
    });
    throw error;
  }
}

/**
 * Generate a clean CSV that preserves the original file structure exactly:
 * - Same columns in the same order (including unmapped columns)
 * - Corrected and enriched values written back into the corresponding source columns
 * - ALL enrichment results applied (including lower-confidence ones)
 * - Unmapped columns passed through unchanged
 * - No synthetic columns (no row_index, canonical_*, confidence, status, etc.)
 */
function generateCleanCsv(
  rows: ProcessedRow[],
  originalHeaders: string[],
  canonicalToSource: Map<string, string>,
  excludedDataByRow: Map<number, Record<string, string>>,
): string {
  // Build source-column -> canonical-field reverse lookup for quick access
  const sourceToCanonical = new Map<string, string>();
  for (const [canonical, source] of canonicalToSource.entries()) {
    sourceToCanonical.set(source, canonical);
  }

  const dataRows = rows.map(row => {
    const excluded = excludedDataByRow.get(row.rowIndex);

    // Build a map of ALL enrichment values (regardless of confidence) so they
    // appear in the CSV. During processing, only >= 70% confidence values are
    // auto-applied to canonicalData. But the user downloading the CSV expects
    // to see all enrichment results that were shown in the UI.
    const enrichedValues = new Map<string, string>();
    for (const change of row.enrichmentResults || []) {
      if (change.proposedValue && canonicalToSource.has(change.field)) {
        enrichedValues.set(change.field, change.proposedValue);
      }
    }

    return originalHeaders.map(header => {
      const canonicalField = sourceToCanonical.get(header);

      if (canonicalField) {
        // This source column is mapped to a canonical field.
        // Priority: canonical data (auto-applied enrichments + corrections) first,
        // then enrichment results (covers lower-confidence changes), then original.
        const canonicalValue = row.canonicalData[canonicalField];
        if (canonicalValue && canonicalValue !== '-' && canonicalValue.trim() !== '') {
          return canonicalValue;
        }
        // Fall back to enrichment results (includes lower-confidence values)
        const enrichedValue = enrichedValues.get(canonicalField);
        if (enrichedValue) {
          return enrichedValue;
        }
        // Fall back to original value
        return row.originalData[header] ?? '';
      }

      // Check if this is an excluded column — restore its original value
      if (excluded && header in excluded) {
        return excluded[header] ?? '';
      }

      // Unmapped but included column — pass through the original value unchanged
      return row.originalData[header] ?? '';
    });
  });

  return stringify([originalHeaders, ...dataRows]);
}

function generateReport(
  rows: ProcessedRow[], 
  schema: GenerateOutputsInput['schema'],
  jobId: string,
  fileName: string,
  originalHeaders: string[],
  canonicalToSource: Map<string, string>,
): object {
  const now = new Date().toISOString();

  // Identify canonical fields that have no corresponding source column.
  // Enrichments for these fields are "report-only" — they cannot be written
  // back to the CSV because the original file had no column for them.
  const reportOnlyCanonicalFields = CANONICAL_FIELDS.filter(f => !canonicalToSource.has(f));

  return {
    metadata: {
      jobId,
      fileName,
      generatedAt: now,
      version: '2.0',
    },
    outputFormat: {
      description: 'The output CSV preserves the original file structure exactly. '
        + 'Same columns in the same order, with corrected and enriched values written back '
        + 'into the corresponding source columns. Unmapped columns are passed through unchanged. '
        + 'All enrichment detail, confidence scores, and additional discovered fields are in this report only.',
      originalHeaders,
      columnMappings: schema.mappings,
      unmappedColumns: schema.unmappedColumns,
      reportOnlyFields: reportOnlyCanonicalFields,
      detectedDelimiter: schema.detectedDelimiter,
    },
    summary: {
      totalRows: rows.length,
      validRows: rows.filter(r => r.validationIssues.length === 0).length,
      rowsWithIssues: rows.filter(r => r.validationIssues.length > 0).length,
      rowsEnriched: rows.filter(r => (r.enrichmentResults?.length || 0) > 0).length,
      rowsNeedingReview: rows.filter(r => r.status === 'NEEDS_REVIEW').length,
      totalIssues: rows.reduce((sum, r) => sum + r.validationIssues.length, 0),
      totalEnrichments: rows.reduce((sum, r) => sum + (r.enrichmentResults?.length || 0), 0),
      issuesByType: countByType(rows.flatMap(r => r.validationIssues), 'issueType'),
      issuesBySeverity: countByType(rows.flatMap(r => r.validationIssues), 'severity'),
      enrichmentsByAction: countByType(rows.flatMap(r => r.enrichmentResults || []), 'action'),
    },
    rows: rows.map(row => ({
      rowIndex: row.rowIndex,
      status: row.status,
      originalData: row.originalData,
      canonicalData: row.canonicalData,
      validationIssues: row.validationIssues.map(issue => ({
        field: issue.field,
        sourceColumn: canonicalToSource.get(issue.field) || null,
        originalValue: issue.originalValue,
        issueType: issue.issueType,
        severity: issue.severity,
        message: issue.message,
        suggestedValue: issue.suggestedValue,
      })),
      enrichmentResults: row.enrichmentResults?.map(change => ({
        field: change.field,
        sourceColumn: canonicalToSource.get(change.field) || null,
        writtenBackToCsv: canonicalToSource.has(change.field),
        originalValue: change.originalValue,
        proposedValue: change.proposedValue,
        confidence: change.confidence,
        reasoning: change.reasoning,
        action: change.action,
        sources: change.sources.map(source => ({
          url: source.url,
          type: source.type,
          retrievedAt: source.retrievedAt,
          snippet: source.snippet,
        })),
      })),
      entityCandidates: row.entityCandidates,
    })),
  };
}

function countByType(items: Array<{ [key: string]: unknown }>, key: string): Record<string, number> {
  return items.reduce((acc, item) => {
    const value = String(item[key] || 'UNKNOWN');
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
}
