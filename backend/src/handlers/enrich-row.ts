import { getRow, saveRow, getCachedEnrichment, setCachedEnrichment, normalizeCompanyKey, updateJobStatus, incrementEnrichmentBatchCompleted, getRowsByCompanyName } from '../utils/dynamodb.js';
import { enrichRow as enrichRowAI, ENRICHMENT_CACHE_VERSION } from '../utils/bedrock.js';
import { validateVat, parseVatId, parseViesAddress } from '../utils/vies.js';
import { searchCompanyWebsite, searchCompanyInfo } from '../utils/search.js';
import { searchRegistries, searchRegistriesByTaxId, type RegistryResult } from '../utils/registries.js';
import type { EnrichRowInput, EnrichRowOutput, ProcessedRow, FieldChange, EnrichmentSource } from '../types/index.js';
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'enrich-row' });

/**
 * Enrich a row using VIES VAT validation.
 * Returns field changes derived from authoritative EU VAT registry data.
 */
async function enrichFromVies(
  row: ProcessedRow,
): Promise<FieldChange[]> {
  // Try vat_id first; fall back to registration_id if it looks like an EU VAT number
  const vatId = row.canonicalData.vat_id
    || (row.canonicalData.registration_id && parseVatId(row.canonicalData.registration_id)
      ? row.canonicalData.registration_id : null);
  if (!vatId) return [];

  const viesResult = await validateVat(vatId);
  if (!viesResult) return [];

  const changes: FieldChange[] = [];
  const now = new Date().toISOString();
  const viesSource: EnrichmentSource = {
    url: 'https://ec.europa.eu/taxation_customs/vies/',
    type: 'PUBLIC_DATABASE',
    retrievedAt: now,
    snippet: `VIES validation: ${viesResult.valid ? 'Valid' : 'Invalid'} VAT ${viesResult.countryCode}${viesResult.vatNumber}`,
  };

  // VAT validity check
  if (!viesResult.valid) {
    changes.push({
      field: 'vat_id',
      originalValue: vatId,
      proposedValue: vatId,
      confidence: 0.95,
      reasoning: 'VAT number is registered as INVALID in the EU VIES system',
      sources: [viesSource],
      action: 'VERIFIED',
    });
  }

  // If VIES returned a company name and we can use it for verification/enrichment
  if (viesResult.name) {
    const currentName = row.canonicalData.company_name || '';
    if (!currentName) {
      changes.push({
        field: 'company_name',
        originalValue: null,
        proposedValue: viesResult.name,
        confidence: 0.95,
        reasoning: `Company name from EU VIES VAT registry`,
        sources: [viesSource],
        action: 'ADDED',
      });
    }
  }

  // Country from VAT registration
  if (viesResult.countryCode && !row.canonicalData.country) {
    changes.push({
      field: 'country',
      originalValue: null,
      proposedValue: viesResult.countryCode,
      confidence: 0.98,
      reasoning: `Country derived from VAT registration in VIES`,
      sources: [viesSource],
      action: 'ADDED',
    });
  }

  // Address parsing from VIES
  if (viesResult.address) {
    const parsed = parseViesAddress(viesResult.address);

    if (parsed.streetAddress && !row.canonicalData.address_line1) {
      changes.push({
        field: 'address_line1',
        originalValue: null,
        proposedValue: parsed.streetAddress,
        confidence: 0.90,
        reasoning: `Address from EU VIES VAT registry`,
        sources: [viesSource],
        action: 'ADDED',
      });
    }

    if (parsed.city && !row.canonicalData.city) {
      changes.push({
        field: 'city',
        originalValue: null,
        proposedValue: parsed.city,
        confidence: 0.90,
        reasoning: `City from EU VIES VAT registry`,
        sources: [viesSource],
        action: 'ADDED',
      });
    }

    if (parsed.postalCode && !row.canonicalData.postal_code) {
      changes.push({
        field: 'postal_code',
        originalValue: null,
        proposedValue: parsed.postalCode,
        confidence: 0.90,
        reasoning: `Postal code from EU VIES VAT registry`,
        sources: [viesSource],
        action: 'ADDED',
      });
    }
  }

  logger.info('VIES enrichment completed', {
    rowIndex: row.rowIndex,
    valid: viesResult.valid,
    changesCount: changes.length,
  });

  return changes;
}

/**
 * Enrich a row using web search results.
 * Passes search results to the AI for structured extraction.
 */
async function enrichFromWebSearch(
  companyName: string,
  country: string | null,
): Promise<Array<{ query: string; results: Array<{ title: string; url: string; snippet: string }> }>> {
  const [websiteResults, infoResults] = await Promise.all([
    searchCompanyWebsite(companyName, country || undefined),
    searchCompanyInfo(companyName, country || undefined),
  ]);

  const searchResults = [];

  if (websiteResults.length > 0) {
    searchResults.push({
      query: `${companyName} official website`,
      results: websiteResults,
    });
  }

  if (infoResults.length > 0) {
    searchResults.push({
      query: `${companyName} ${country || ''} company information`,
      results: infoResults,
    });
  }

  return searchResults;
}

/**
 * Enrich a row using company register data (Brreg, CVR, Companies House, OpenCorporates).
 * Searches for the company by name and returns field changes from the best match.
 */
async function enrichFromRegistries(
  row: ProcessedRow,
): Promise<FieldChange[]> {
  const companyName = row.canonicalData.company_name;
  if (!companyName) return [];

  const country = row.canonicalData.country || null;
  const results = await searchRegistries(companyName, country);

  if (results.length === 0) return [];

  // Take the best match (highest confidence)
  const best = results[0];

  // Only use results with reasonable confidence
  if (best.confidence < 0.6) {
    logger.info('Registry match confidence too low', {
      companyName,
      bestMatch: best.companyName,
      confidence: best.confidence,
      source: best.source,
    });
    return [];
  }

  const changes: FieldChange[] = [];
  const now = new Date().toISOString();
  const registrySource: EnrichmentSource = {
    url: best.sourceUrl,
    type: 'BUSINESS_REGISTRY',
    retrievedAt: now,
    snippet: `${best.source}: ${best.companyName} (${best.registrationId || 'N/A'})`,
  };

  // Fill missing fields from registry data
  if (best.vatId && !row.canonicalData.vat_id) {
    changes.push({
      field: 'vat_id',
      originalValue: null,
      proposedValue: best.vatId,
      confidence: best.confidence,
      reasoning: `VAT ID from ${best.source} company register`,
      sources: [registrySource],
      action: 'ADDED',
    });
  }

  if (best.registrationId && !row.canonicalData.registration_id) {
    changes.push({
      field: 'registration_id',
      originalValue: null,
      proposedValue: best.registrationId,
      confidence: best.confidence,
      reasoning: `Registration number from ${best.source} company register`,
      sources: [registrySource],
      action: 'ADDED',
    });
  }

  if (best.address && !row.canonicalData.address_line1) {
    changes.push({
      field: 'address_line1',
      originalValue: null,
      proposedValue: best.address,
      confidence: best.confidence * 0.9,
      reasoning: `Registered address from ${best.source}`,
      sources: [registrySource],
      action: 'ADDED',
    });
  }

  if (best.postalCode && !row.canonicalData.postal_code) {
    changes.push({
      field: 'postal_code',
      originalValue: null,
      proposedValue: best.postalCode,
      confidence: best.confidence * 0.9,
      reasoning: `Postal code from ${best.source} registered address`,
      sources: [registrySource],
      action: 'ADDED',
    });
  }

  if (best.city && !row.canonicalData.city) {
    changes.push({
      field: 'city',
      originalValue: null,
      proposedValue: best.city,
      confidence: best.confidence * 0.9,
      reasoning: `City from ${best.source} registered address`,
      sources: [registrySource],
      action: 'ADDED',
    });
  }

  if (best.country && !row.canonicalData.country) {
    changes.push({
      field: 'country',
      originalValue: null,
      proposedValue: best.country,
      confidence: best.confidence,
      reasoning: `Country from ${best.source} jurisdiction`,
      sources: [registrySource],
      action: 'ADDED',
    });
  }

  if (best.industry && !row.canonicalData.industry) {
    changes.push({
      field: 'industry',
      originalValue: null,
      proposedValue: best.industry,
      confidence: best.confidence * 0.85,
      reasoning: `Industry classification from ${best.source}`,
      sources: [registrySource],
      action: 'ADDED',
    });
  }

  if (best.website && !row.canonicalData.website) {
    changes.push({
      field: 'website',
      originalValue: null,
      proposedValue: best.website.startsWith('http') ? best.website : `https://${best.website}`,
      confidence: best.confidence * 0.85,
      reasoning: `Website from ${best.source} register`,
      sources: [registrySource],
      action: 'ADDED',
    });
  }

  if (best.phone && !row.canonicalData.phone) {
    changes.push({
      field: 'phone',
      originalValue: null,
      proposedValue: best.phone,
      confidence: best.confidence * 0.8,
      reasoning: `Phone from ${best.source} register`,
      sources: [registrySource],
      action: 'ADDED',
    });
  }

  if (best.email && !row.canonicalData.email) {
    changes.push({
      field: 'email',
      originalValue: null,
      proposedValue: best.email,
      confidence: best.confidence * 0.8,
      reasoning: `Email from ${best.source} register`,
      sources: [registrySource],
      action: 'ADDED',
    });
  }

  if (changes.length > 0) {
    logger.info('Registry enrichment completed', {
      rowIndex: row.rowIndex,
      companyName,
      source: best.source,
      matchName: best.companyName,
      confidence: best.confidence,
      changesCount: changes.length,
    });
  }

  return changes;
}

/**
 * Enrich a row using data from other rows in the same job with the same company name.
 * If another row for the same company has data this row is missing, fill it in.
 */
async function enrichFromCrossRowConsistency(
  jobId: string,
  row: ProcessedRow,
): Promise<FieldChange[]> {
  const companyName = row.canonicalData.company_name;
  if (!companyName) return [];

  const siblingRows = await getRowsByCompanyName(jobId, companyName);

  // Filter out the current row and rows with no enrichment value
  const otherRows = siblingRows.filter(r => r.rowIndex !== row.rowIndex);
  if (otherRows.length === 0) return [];

  const changes: FieldChange[] = [];
  const now = new Date().toISOString();
  const fieldsToCheck = [
    'website', 'email', 'phone', 'city', 'state_province',
    'postal_code', 'country', 'address_line1', 'vat_id', 'industry',
  ];

  for (const field of fieldsToCheck) {
    // Skip if current row already has this field
    if (row.canonicalData[field]) continue;

    // Find the best value from sibling rows
    const candidateValues: Record<string, number> = {};
    for (const sibling of otherRows) {
      const value = sibling.canonicalData[field];
      if (value) {
        candidateValues[value] = (candidateValues[value] || 0) + 1;
      }
    }

    // Pick the most common value
    const entries = Object.entries(candidateValues);
    if (entries.length === 0) continue;

    entries.sort((a, b) => b[1] - a[1]);
    const [bestValue, count] = entries[0];

    // Confidence based on how many siblings agree
    const confidence = Math.min(0.85, 0.6 + (count / otherRows.length) * 0.25);

    changes.push({
      field,
      originalValue: null,
      proposedValue: bestValue,
      confidence,
      reasoning: `Filled from ${count} other row(s) for the same company "${companyName}"`,
      sources: [{
        url: 'N/A',
        type: 'LLM_KNOWLEDGE', // Using LLM_KNOWLEDGE as the closest matching type
        retrievedAt: now,
        snippet: `Cross-row consistency: value found in ${count} sibling row(s)`,
      }],
      action: 'ADDED',
    });
  }

  if (changes.length > 0) {
    logger.info('Cross-row consistency enrichment', {
      rowIndex: row.rowIndex,
      companyName,
      siblingCount: otherRows.length,
      changesCount: changes.length,
    });
  }

  return changes;
}

/**
 * Filter out "enrichments" that don't actually change anything.
 * The AI sometimes returns the existing value as a "verification" -- these aren't real enrichments.
 */
function filterNoOpChanges(
  changes: FieldChange[],
  currentData: Record<string, string | null>,
): FieldChange[] {
  return changes.filter(change => {
    const currentValue = (currentData[change.field] || '').trim().toLowerCase();
    const proposedValue = (change.proposedValue || '').trim().toLowerCase();

    // If the proposed value is the same as the current value, it's not a real change
    if (currentValue && proposedValue === currentValue) {
      return false;
    }

    // Also check originalValue === proposedValue (AI confirming what's already there)
    const originalValue = (change.originalValue || '').trim().toLowerCase();
    if (originalValue && proposedValue === originalValue) {
      return false;
    }

    return true;
  });
}

/**
 * Merge field changes from multiple sources, preferring higher-confidence sources.
 * VIES (authoritative) > Web Search (factual) > Cross-row > AI (knowledge-based)
 */
function mergeFieldChanges(
  currentData: Record<string, string | null>,
  ...changeSets: FieldChange[][]
): FieldChange[] {
  const merged = new Map<string, FieldChange>();

  for (const changes of changeSets) {
    // Filter out no-op changes before merging
    const realChanges = filterNoOpChanges(changes, currentData);
    for (const change of realChanges) {
      const existing = merged.get(change.field);
      if (!existing || change.confidence > existing.confidence) {
        merged.set(change.field, change);
      }
    }
  }

  return Array.from(merged.values());
}

export async function handler(event: EnrichRowInput): Promise<EnrichRowOutput> {
  const { jobId, tenantId, schema, batch, batchIndex } = event;
  
  logger.info('Starting enrichment batch', { jobId, batchIndex, rowCount: batch.length });
  
  // Determine which canonical fields are actually mapped in the schema.
  // Enrichment should only add/modify fields the user chose to include.
  // Fields not in the schema were either excluded or don't exist in the CSV.
  const mappedCanonicalFields = new Set(
    schema.mappings
      .filter(m => m.canonicalField !== 'UNMAPPED')
      .map(m => m.canonicalField)
  );
  logger.info('Mapped canonical fields for enrichment scope', {
    mappedFields: [...mappedCanonicalFields],
  });
  
  // Update job status to ENRICHING (idempotent - safe if multiple batches do this)
  try {
    await updateJobStatus(tenantId, jobId, 'ENRICHING');
  } catch (error) {
    logger.warn('Failed to update job status', { error });
  }
  
  let processedCount = 0;
  let enrichedCount = 0;
  let errorCount = 0;
  
  for (const rowIndex of batch) {
    try {
      // Get row data from DynamoDB
      const row = await getRow(jobId, rowIndex);
      if (!row) {
        logger.warn('Row not found', { jobId, rowIndex });
        errorCount++;
        continue;
      }
      
      // Skip if row already enriched
      if (row.status === 'ENRICHED') {
        processedCount++;
        continue;
      }
      
      // Determine if enrichment is needed
      const hasImportantMissingFields = !row.canonicalData.company_name ||
        !row.canonicalData.website ||
        !row.canonicalData.country ||
        !row.canonicalData.city;
      
      const needsEnrichment = row.validationIssues.length > 0 || hasImportantMissingFields;
      
      if (!needsEnrichment && row.status === 'VALIDATED') {
        // Data is complete and valid - no enrichment needed, keep VALIDATED status
        row.enrichmentResults = [];
        await saveRow(jobId, row);
        processedCount++;
        continue;
      }
      
      // Pre-resolution: if company_name is missing but we have a tax/registration ID,
      // try to resolve the name via direct registry ID lookups + VIES before full enrichment.
      let preResolveChanges: FieldChange[] = [];
      if (!row.canonicalData.company_name) {
        const vatId = row.canonicalData.vat_id || undefined;
        const regId = row.canonicalData.registration_id || undefined;
        const rowCountry = row.canonicalData.country || undefined;

        if (vatId || regId) {
          logger.info('Attempting name pre-resolution from tax ID', { rowIndex, vatId, regId, country: rowCountry });

          // If registration_id looks like a VAT ID (EU country prefix + digits), try VIES with it too
          const viesCandidate = vatId || (regId && parseVatId(regId) ? regId : undefined);

          // Try VIES first (authoritative for EU VAT), then registry ID lookups, in parallel
          const [viesResult, registryResult] = await Promise.all([
            viesCandidate ? validateVat(viesCandidate) : Promise.resolve(null),
            searchRegistriesByTaxId(vatId, regId, rowCountry),
          ]);

          const now = new Date().toISOString();
          let resolvedName: string | null = null;

          if (viesResult?.name) {
            resolvedName = viesResult.name;
            preResolveChanges.push({
              field: 'company_name',
              originalValue: null,
              proposedValue: viesResult.name,
              confidence: 0.95,
              reasoning: `Company name resolved from VAT ID ${vatId} via EU VIES registry`,
              sources: [{
                url: 'https://ec.europa.eu/taxation_customs/vies/',
                type: 'PUBLIC_DATABASE',
                retrievedAt: now,
                snippet: `VIES: ${viesResult.name} (${viesResult.countryCode}${viesResult.vatNumber})`,
              }],
              action: 'ADDED',
            });
          } else if (registryResult) {
            resolvedName = registryResult.companyName;
            preResolveChanges.push({
              field: 'company_name',
              originalValue: null,
              proposedValue: registryResult.companyName,
              confidence: registryResult.confidence,
              reasoning: `Company name resolved from ${vatId ? 'tax ID' : 'registration ID'} via ${registryResult.source} registry`,
              sources: [{
                url: registryResult.sourceUrl,
                type: 'BUSINESS_REGISTRY',
                retrievedAt: now,
                snippet: `${registryResult.source}: ${registryResult.companyName} (${registryResult.registrationId || 'N/A'})`,
              }],
              action: 'ADDED',
            });

            // Also pick up any extra fields the registry returned
            if (registryResult.address && !row.canonicalData.address_line1) {
              preResolveChanges.push({ field: 'address_line1', originalValue: null, proposedValue: registryResult.address, confidence: registryResult.confidence * 0.9, reasoning: `Address from ${registryResult.source} ID lookup`, sources: [{ url: registryResult.sourceUrl, type: 'BUSINESS_REGISTRY', retrievedAt: now, snippet: registryResult.address }], action: 'ADDED' });
            }
            if (registryResult.city && !row.canonicalData.city) {
              preResolveChanges.push({ field: 'city', originalValue: null, proposedValue: registryResult.city, confidence: registryResult.confidence * 0.9, reasoning: `City from ${registryResult.source} ID lookup`, sources: [{ url: registryResult.sourceUrl, type: 'BUSINESS_REGISTRY', retrievedAt: now, snippet: registryResult.city }], action: 'ADDED' });
            }
            if (registryResult.country && !row.canonicalData.country) {
              preResolveChanges.push({ field: 'country', originalValue: null, proposedValue: registryResult.country, confidence: registryResult.confidence, reasoning: `Country from ${registryResult.source} ID lookup`, sources: [{ url: registryResult.sourceUrl, type: 'BUSINESS_REGISTRY', retrievedAt: now, snippet: registryResult.country }], action: 'ADDED' });
            }
            if (registryResult.postalCode && !row.canonicalData.postal_code) {
              preResolveChanges.push({ field: 'postal_code', originalValue: null, proposedValue: registryResult.postalCode, confidence: registryResult.confidence * 0.9, reasoning: `Postal code from ${registryResult.source} ID lookup`, sources: [{ url: registryResult.sourceUrl, type: 'BUSINESS_REGISTRY', retrievedAt: now, snippet: registryResult.postalCode }], action: 'ADDED' });
            }
          }

          if (resolvedName) {
            row.canonicalData.company_name = resolvedName;
            logger.info('Pre-resolved company name from tax ID', { rowIndex, resolvedName, source: viesResult?.name ? 'VIES' : registryResult?.source });
          }
        }
      }

      // Check cache for this entity
      const companyName = row.canonicalData.company_name || '';
      const country = row.canonicalData.country || undefined;
      const cacheKey = normalizeCompanyKey(companyName, country);
      
      let cachedData = null;
      const cacheSourceType = `ENRICHMENT#${ENRICHMENT_CACHE_VERSION}`;
      if (cacheKey) {
        cachedData = await getCachedEnrichment(cacheKey, cacheSourceType);
      }
      
      let enrichmentResults: FieldChange[] = [];
      
      if (cachedData && cachedData.data) {
        // Use cached enrichment, but filter to only mapped canonical fields
        enrichmentResults = (cachedData.data.fieldChanges as FieldChange[]).filter(
          change => mappedCanonicalFields.has(change.field)
        );
        logger.info('Using cached enrichment', { rowIndex, cacheKey, filteredCount: enrichmentResults.length });
      } else {
        // Perform multi-source enrichment
        try {
          // Run all enrichment sources in parallel where possible
          const [viesChanges, registryChanges, crossRowChanges, webSearchResults] = await Promise.all([
            // 1. VIES VAT validation (authoritative EU data)
            enrichFromVies(row),
            // 2. Company register lookups (Brreg, CVR, Companies House, OpenCorporates)
            enrichFromRegistries(row),
            // 3. Cross-row consistency
            enrichFromCrossRowConsistency(jobId, row),
            // 4. Web search (if API key configured)
            enrichFromWebSearch(companyName, country || null),
          ]);

          // 4. AI enrichment (with web search results injected)
          let aiChanges: FieldChange[] = [];
          try {
            const aiResult = await enrichRowAI({
              rowIndex,
              currentData: row.canonicalData as Record<string, string | null>,
              validationIssues: row.validationIssues,
              webSearchResults: webSearchResults.length > 0 ? webSearchResults : undefined,
            });
            
            aiChanges = aiResult.fieldChanges;
            
            // Update row with entity candidates if found
            if (aiResult.entityCandidates && aiResult.entityCandidates.length > 0) {
              row.entityCandidates = aiResult.entityCandidates.slice(0, 3).map(c => ({
                name: c.name,
                confidence: c.confidence,
                sources: [],
              }));
            }
            
            // Only mark for manual review if AI explicitly says it couldn't identify the company
            if (aiResult.needsManualReview) {
              row.status = 'NEEDS_REVIEW';
              logger.info('Row marked for review', { rowIndex, reason: aiResult.reviewReason });
            }
          } catch (error) {
            logger.warn('AI enrichment failed, using other sources', { error, rowIndex });
          }

          // Merge all sources: VIES > Registry > cross-row > AI (higher confidence wins)
          // Also filters out no-op "enrichments" where proposed value = current value
          enrichmentResults = mergeFieldChanges(
            row.canonicalData as Record<string, string | null>,
            viesChanges, registryChanges, crossRowChanges, aiChanges,
          );
          
          // Only keep enrichments for canonical fields that are mapped in the schema.
          // If a user didn't include a column (e.g., industry), don't enrich it.
          const preFilterCount = enrichmentResults.length;
          const droppedFields = enrichmentResults
            .filter(c => !mappedCanonicalFields.has(c.field))
            .map(c => c.field);
          enrichmentResults = enrichmentResults.filter(change =>
            mappedCanonicalFields.has(change.field)
          );
          if (droppedFields.length > 0) {
            logger.info('Filtered out-of-scope enrichments', {
              rowIndex,
              before: preFilterCount,
              after: enrichmentResults.length,
              droppedFields,
            });
          }
          
          logger.info('Multi-source enrichment completed', {
            rowIndex,
            viesChanges: viesChanges.length,
            registryChanges: registryChanges.length,
            crossRowChanges: crossRowChanges.length,
            webSearchResultSets: webSearchResults.length,
            aiChanges: aiChanges.length,
            mergedTotal: enrichmentResults.length,
          });

          // Cache the results for known entities
          if (cacheKey && enrichmentResults.length > 0) {
            await setCachedEnrichment({
              normalizedKey: cacheKey,
              sourceType: cacheSourceType,
              data: { fieldChanges: enrichmentResults },
              retrievedAt: new Date().toISOString(),
              ttl: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
            });
            logger.info('Cached enrichment results', { cacheKey, cacheVersion: ENRICHMENT_CACHE_VERSION, changesCount: enrichmentResults.length });
          }
        } catch (error) {
          logger.error('Enrichment failed', { error, rowIndex });
          row.status = 'NEEDS_REVIEW';
          row.errorMessage = 'Enrichment failed - manual review required';
        }
      }
      
      // Prepend pre-resolution changes (these have already been applied to canonicalData
      // for company_name so the full pipeline could use them, but we still want them in
      // the enrichmentResults list so the UI shows what was resolved).
      if (preResolveChanges.length > 0) {
        const preResolveFiltered = preResolveChanges.filter(c => mappedCanonicalFields.has(c.field));
        const existingFields = new Set(enrichmentResults.map(r => r.field));
        for (const change of preResolveFiltered) {
          if (!existingFields.has(change.field)) {
            enrichmentResults.unshift(change);
          }
        }
      }

      // Apply enrichment results to canonical data
      for (const change of enrichmentResults) {
        if (change.confidence >= 0.7) {
          row.canonicalData[change.field] = change.proposedValue;
        }
      }
      
      row.enrichmentResults = enrichmentResults;
      
      // Update row status — only mark as ENRICHED if there are actual enrichment results.
      // Rows with no enrichments keep their current status (VALIDATED) so the UI
      // doesn't misleadingly show them as "enriched" with no details.
      if (row.status !== 'NEEDS_REVIEW' && enrichmentResults.length > 0) {
        row.status = 'ENRICHED';
      }
      
      // Save updated row
      await saveRow(jobId, row);
      
      processedCount++;
      if (enrichmentResults.length > 0) {
        enrichedCount++;
      }
      
      logger.info('Row enriched', { 
        rowIndex, 
        changesCount: enrichmentResults.length,
        status: row.status,
      });
      
    } catch (error) {
      logger.error('Error enriching row', { error, rowIndex });
      errorCount++;
      
      // Update row status to error
      try {
        const row = await getRow(jobId, rowIndex);
        if (row) {
          row.status = 'ERROR';
          row.errorMessage = error instanceof Error ? error.message : 'Unknown enrichment error';
          await saveRow(jobId, row);
        }
      } catch {
        // Ignore save error
      }
    }
  }
  
  // Increment batch completion counter for progress tracking
  try {
    await incrementEnrichmentBatchCompleted(tenantId, jobId);
  } catch (error) {
    logger.warn('Failed to increment batch counter', { error });
  }
  
  logger.info('Enrichment batch completed', { 
    jobId, 
    batchIndex, 
    processedCount, 
    enrichedCount, 
    errorCount,
  });
  
  return {
    batchIndex,
    processedCount,
    enrichedCount,
    errorCount,
  };
}
