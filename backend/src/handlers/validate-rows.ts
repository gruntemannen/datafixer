import { getObject } from '../utils/s3.js';
import { updateJobStatus, saveRowsBatch } from '../utils/dynamodb.js';
import { validateRowsBatch, normalizeCountryCode, checkSuspiciousCountryCode, isValidEmail, isValidUrl, isValidPhone, validatePostalCodeCountry, normalizeWebsiteUrl, normalizePhone } from '../utils/bedrock.js';
import type { InferSchemaOutput, ValidateRowsOutput, ProcessedRow, ValidationIssue } from '../types/index.js';
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'validate-rows' });

interface ParsedData {
  headers: string[];
  rows: Array<{ rowIndex: number; data: Record<string, string> }>;
}

const BATCH_SIZE = 100; // Process 100 rows at a time for better throughput
const ENRICHMENT_BATCH_SIZE = 5; // Size of batches for enrichment step
const MAX_AI_VALIDATED_ROWS = 200; // Cap AI validation to avoid Lambda timeout on large files
const STATUS_UPDATE_INTERVAL = 500; // Only update job status every N rows

// Basic validation rules (deterministic)
function validateRowDeterministic(
  data: Record<string, string | null>,
  schema: InferSchemaOutput['schema']
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  
  // Map source columns to canonical fields
  const canonicalData: Record<string, string | null> = {};
  for (const mapping of schema.mappings) {
    if (mapping.canonicalField !== 'UNMAPPED') {
      canonicalData[mapping.canonicalField] = data[mapping.sourceColumn] || null;
    }
  }
  
  // Required field: company_name — only flag if company_name is actually mapped in the schema.
  // If company_name isn't in the schema, the user chose not to include that column,
  // so flagging it as missing would generate false errors for every row.
  const companyNameIsMapped = schema.mappings.some(m => m.canonicalField === 'company_name');
  if (companyNameIsMapped && !canonicalData.company_name?.trim()) {
    issues.push({
      field: 'company_name',
      originalValue: canonicalData.company_name || null,
      issueType: 'MISSING',
      severity: 'ERROR',
      message: 'Company name is required',
    });
  }
  
  // Country validation
  if (canonicalData.country) {
    const normalized = normalizeCountryCode(canonicalData.country);
    if (!normalized) {
      issues.push({
        field: 'country',
        originalValue: canonicalData.country,
        issueType: 'INVALID',
        severity: 'WARNING',
        message: 'Country could not be converted to ISO 3166-1 alpha-2 code',
        suggestedValue: undefined,
      });
    } else {
      // Check for commonly misused country codes and AUTO-CORRECT them
      const suspiciousCheck = checkSuspiciousCountryCode(normalized);
      if (suspiciousCheck.isSuspicious && suspiciousCheck.suggestion) {
        // Auto-correct obvious country code errors (like SZ -> CH, UK -> GB)
        // Record as INFO since we're fixing it automatically
        issues.push({
          field: 'country',
          originalValue: canonicalData.country,
          issueType: 'SUSPICIOUS',
          severity: 'INFO', // Downgrade to INFO since we're auto-fixing
          message: `Auto-corrected: ${suspiciousCheck.reason}`,
          suggestedValue: suspiciousCheck.suggestion,
        });
        // Apply the correction - this will be reflected in canonicalData
        canonicalData.country = suspiciousCheck.suggestion;
      }
    }
  }
  
  // Postal code + country cross-validation
  if (canonicalData.postal_code && canonicalData.country) {
    const postalCheck = validatePostalCodeCountry(canonicalData.postal_code, canonicalData.country);
    if (!postalCheck.valid) {
      issues.push({
        field: 'postal_code',
        originalValue: canonicalData.postal_code,
        issueType: 'SUSPICIOUS',
        severity: postalCheck.likelyCountry ? 'WARNING' : 'INFO',
        message: postalCheck.reason || 'Postal code format does not match country',
        suggestedValue: undefined,
      });
      // If we're confident about the country mismatch, flag it
      if (postalCheck.likelyCountry && postalCheck.likelyCountry !== canonicalData.country) {
        issues.push({
          field: 'country',
          originalValue: canonicalData.country,
          issueType: 'SUSPICIOUS',
          severity: 'WARNING',
          message: `Postal code ${canonicalData.postal_code} suggests ${postalCheck.likelyCountryName} (${postalCheck.likelyCountry}), not ${canonicalData.country}`,
          suggestedValue: postalCheck.likelyCountry,
        });
      }
    }
  }

  // Email validation
  if (canonicalData.email && !isValidEmail(canonicalData.email)) {
    issues.push({
      field: 'email',
      originalValue: canonicalData.email,
      issueType: 'INVALID',
      severity: 'ERROR',
      message: 'Invalid email format',
    });
  }
  
  // Website validation and auto-fix
  if (canonicalData.website) {
    const normalized = normalizeWebsiteUrl(canonicalData.website);
    if (normalized && normalized.wasFixed) {
      issues.push({
        field: 'website',
        originalValue: canonicalData.website,
        issueType: 'FORMAT_ERROR',
        severity: 'INFO',
        message: 'Auto-corrected: Website URL normalized (added protocol/fixed format)',
        suggestedValue: normalized.url,
      });
      canonicalData.website = normalized.url;
    } else if (!normalized) {
      issues.push({
        field: 'website',
        originalValue: canonicalData.website,
        issueType: 'INVALID',
        severity: 'WARNING',
        message: 'Invalid website URL format',
      });
    }
  }
  
  // Phone validation and auto-normalization
  if (canonicalData.phone) {
    const normalized = normalizePhone(canonicalData.phone, canonicalData.country);
    if (normalized && normalized.wasFixed) {
      issues.push({
        field: 'phone',
        originalValue: canonicalData.phone,
        issueType: 'FORMAT_ERROR',
        severity: 'INFO',
        message: 'Auto-corrected: Phone number normalized',
        suggestedValue: normalized.phone,
      });
      canonicalData.phone = normalized.phone;
    } else if (canonicalData.phone && !isValidPhone(canonicalData.phone)) {
      issues.push({
        field: 'phone',
        originalValue: canonicalData.phone,
        issueType: 'SUSPICIOUS',
        severity: 'INFO',
        message: 'Phone number format may be invalid',
      });
    }
  }
  
  return issues;
}

// Convert raw data to canonical format
function toCanonicalData(
  data: Record<string, string>,
  schema: InferSchemaOutput['schema']
): Record<string, string | null> {
  const canonical: Record<string, string | null> = {};
  
  for (const mapping of schema.mappings) {
    if (mapping.canonicalField !== 'UNMAPPED') {
      const value = data[mapping.sourceColumn]?.trim() || null;
      canonical[mapping.canonicalField] = value;
      
      // Normalize and auto-correct country code
      if (mapping.canonicalField === 'country' && value) {
        // First try full name → code mapping
        let normalized = normalizeCountryCode(value);
        if (!normalized) {
          // If it's already a code (2-3 chars), check suspicious codes directly
          const upper = value.toUpperCase().trim();
          const suspiciousCheck = checkSuspiciousCountryCode(upper);
          if (suspiciousCheck.isSuspicious && suspiciousCheck.suggestion) {
            normalized = suspiciousCheck.suggestion;
          } else if (/^[A-Z]{2}$/.test(upper)) {
            normalized = upper; // Valid-looking 2-letter code, keep it
          }
        }
        if (normalized) {
          // Check for commonly misused codes and auto-correct (e.g., SZ -> CH, UK -> GB)
          const suspiciousCheck = checkSuspiciousCountryCode(normalized);
          if (suspiciousCheck.isSuspicious && suspiciousCheck.suggestion) {
            normalized = suspiciousCheck.suggestion;
          }
          canonical[mapping.canonicalField] = normalized;
        }
      }

      // Normalize website URL during canonicalization
      if (mapping.canonicalField === 'website' && value) {
        const normalized = normalizeWebsiteUrl(value);
        if (normalized) {
          canonical[mapping.canonicalField] = normalized.url;
        }
      }

      // Normalize phone number during canonicalization
      if (mapping.canonicalField === 'phone' && value) {
        const normalized = normalizePhone(value, canonical.country);
        if (normalized) {
          canonical[mapping.canonicalField] = normalized.phone;
        }
      }
    }
  }
  
  return canonical;
}

export async function handler(event: InferSchemaOutput): Promise<ValidateRowsOutput> {
  const { jobId, tenantId, rawDataKey, schema } = event;
  
  logger.info('Starting row validation', { jobId, totalRows: schema.totalRows });
  
  try {
    // Update job status
    await updateJobStatus(tenantId, jobId, 'VALIDATING');
    
    // Get parsed data
    const rawData = await getObject(rawDataKey);
    const parsedData: ParsedData = JSON.parse(rawData);
    
    const allProcessedRows: ProcessedRow[] = [];
    let totalIssues = 0;
    let errorCount = 0;
    let warningCount = 0;
    let aiValidatedRows = 0;
    
    // Process in batches
    for (let i = 0; i < parsedData.rows.length; i += BATCH_SIZE) {
      const batch = parsedData.rows.slice(i, i + BATCH_SIZE);
      
      // Process each row in the batch
      const batchResults: ProcessedRow[] = [];
      
      for (const row of batch) {
        const canonicalData = toCanonicalData(row.data, schema);
        
        // Run deterministic validation
        const deterministicIssues = validateRowDeterministic(row.data, schema);
        
        // Determine row status based on issues
        let status: ProcessedRow['status'] = 'VALIDATED';
        if (deterministicIssues.some(i => i.severity === 'ERROR')) {
          status = 'NEEDS_REVIEW';
        }
        
        const processedRow: ProcessedRow = {
          rowIndex: row.rowIndex,
          originalData: row.data,
          canonicalData,
          validationIssues: deterministicIssues,
          status,
        };
        
        batchResults.push(processedRow);
        
        // Count issues
        totalIssues += deterministicIssues.length;
        errorCount += deterministicIssues.filter(i => i.severity === 'ERROR').length;
        warningCount += deterministicIssues.filter(i => i.severity === 'WARNING').length;
      }
      
      // Run AI validation for complex cases (rows with genuine validation issues).
      // Only trigger AI for rows that have deterministic issues that AI might help resolve.
      // Don't trigger on structurally missing fields (e.g. company_name not mapped in schema).
      const canRunAI = aiValidatedRows < MAX_AI_VALIDATED_ROWS;
      const companyNameMapped = schema.mappings.some(m => m.canonicalField === 'company_name');
      const rowsNeedingAIValidation = canRunAI
        ? batchResults.filter(r => 
            r.validationIssues.length > 0 || 
            (companyNameMapped && !r.canonicalData.company_name)
          )
        : [];
      
      if (rowsNeedingAIValidation.length > 0) {
        try {
          const aiResults = await validateRowsBatch(
            rowsNeedingAIValidation.map(r => ({
              rowIndex: r.rowIndex,
              data: r.canonicalData as Record<string, string | null>,
            }))
          );
          
          // Merge AI issues with deterministic issues
          for (let j = 0; j < rowsNeedingAIValidation.length; j++) {
            const row = rowsNeedingAIValidation[j];
            const aiIssues = aiResults[j]?.issues || [];
            
            // Add AI issues that don't duplicate deterministic issues
            for (const aiIssue of aiIssues) {
              const isDuplicate = row.validationIssues.some(
                existing => existing.field === aiIssue.field && existing.issueType === aiIssue.issueType
              );
              if (!isDuplicate) {
                row.validationIssues.push(aiIssue);
                totalIssues++;
                if (aiIssue.severity === 'ERROR') errorCount++;
                if (aiIssue.severity === 'WARNING') warningCount++;
              }
            }
            
            // Update status if new errors found
            if (row.validationIssues.some(i => i.severity === 'ERROR')) {
              row.status = 'NEEDS_REVIEW';
            }
          }
          aiValidatedRows += rowsNeedingAIValidation.length;
        } catch (error) {
          // Log AI validation error but continue with deterministic results
          logger.warn('AI validation failed for batch, using deterministic results only', { error });
        }
      }
      
      allProcessedRows.push(...batchResults);
      
      // Save batch to DynamoDB
      await saveRowsBatch(jobId, batchResults);
      
      const processedSoFar = i + batch.length;
      
      // Only update job status periodically to reduce DynamoDB writes
      if (processedSoFar % STATUS_UPDATE_INTERVAL < BATCH_SIZE || processedSoFar >= parsedData.rows.length) {
        await updateJobStatus(tenantId, jobId, 'VALIDATING', {
          processedRows: processedSoFar,
        });
      }
      
      logger.info('Validated batch', { 
        jobId, 
        batchStart: i, 
        batchEnd: processedSoFar,
        batchIssues: batchResults.reduce((sum, r) => sum + r.validationIssues.length, 0),
      });
    }
    
    // Create batches for enrichment step
    const rowIndices = allProcessedRows.map(r => r.rowIndex);
    const rowBatches: number[][] = [];
    for (let i = 0; i < rowIndices.length; i += ENRICHMENT_BATCH_SIZE) {
      rowBatches.push(rowIndices.slice(i, i + ENRICHMENT_BATCH_SIZE));
    }
    
    // Store total enrichment batches in the job record for progress tracking
    await updateJobStatus(tenantId, jobId, 'VALIDATING', {
      enrichmentBatchesTotal: rowBatches.length,
      enrichmentBatchesCompleted: 0,
    });
    
    logger.info('Validation completed', {
      jobId,
      totalRows: allProcessedRows.length,
      totalIssues,
      errorCount,
      warningCount,
      aiValidatedRows,
      aiValidationCapped: aiValidatedRows >= MAX_AI_VALIDATED_ROWS,
      enrichmentBatches: rowBatches.length,
    });
    
    return {
      ...event,
      rowBatches,
      validationSummary: {
        totalIssues,
        errorCount,
        warningCount,
      },
    };
  } catch (error) {
    logger.error('Error validating rows', { error, jobId });
    await updateJobStatus(tenantId, jobId, 'FAILED', {
      errorMessage: error instanceof Error ? error.message : 'Unknown error during validation',
    });
    throw error;
  }
}
