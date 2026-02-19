import { 
  BedrockRuntimeClient, 
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import type { 
  InferredSchema, 
  ColumnMapping, 
  ValidationIssue, 
  FieldChange,
  EnrichmentSource,
} from '../types/index.js';

const bedrockClient = new BedrockRuntimeClient({ 
  region: process.env.AWS_REGION || 'eu-central-1' 
});

// Using Claude 4.5 Haiku via EU inference profile - fast, capable, and cost-effective
const MODEL_ID = 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

// Cache version - increment this when model or prompts change to invalidate old cached results
export const ENRICHMENT_CACHE_VERSION = 'v10-vies-address-master';

interface ClaudeResponse {
  content: Array<{ type: string; text: string }>;
}

async function invokeModel<T>(prompt: string, systemPrompt: string): Promise<T> {
  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 4096,
    temperature: 0.2,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  };

  const command = new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(payload),
  });

  const response = await bedrockClient.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body)) as ClaudeResponse;
  const text = responseBody.content[0].text;
  
  // Extract JSON from response
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Failed to parse JSON from response: ${text}`);
  }
  
  const jsonStr = jsonMatch[1] || jsonMatch[0];
  return JSON.parse(jsonStr) as T;
}

// Schema inference prompt and function
const SCHEMA_INFERENCE_SYSTEM_PROMPT = `You are a data schema analyst. Your task is to analyze CSV column headers and sample data to map them to canonical business entity fields.

Canonical fields are:
- company_name: The official name of the company/organization
- address_line1: Street address, first line
- address_line2: Street address, second line (suite, floor, etc.)
- city: City name
- state_province: State, province, or region
- postal_code: ZIP code or postal code
- country: Country (prefer ISO 3166-1 alpha-2 codes)
- website: Company website URL
- email: Contact email address
- phone: Phone number
- vat_id: VAT registration number
- registration_id: Company registration/incorporation number
- industry: Business industry or sector

Respond ONLY with valid JSON matching the specified schema. Do not include any explanation outside the JSON.`;

interface SchemaInferenceInput {
  headers: string[];
  sampleRows: string[][];
}

interface SchemaInferenceOutput {
  mappings: ColumnMapping[];
  unmappedColumns: string[];
}

export async function inferSchema(input: SchemaInferenceInput): Promise<SchemaInferenceOutput> {
  const prompt = `Analyze these CSV headers and sample data to map columns to canonical fields.

Headers: ${JSON.stringify(input.headers)}

Sample rows (first 5):
${input.sampleRows.slice(0, 5).map((row, i) => `Row ${i + 1}: ${JSON.stringify(row)}`).join('\n')}

Respond with JSON matching this schema:
{
  "mappings": [
    {
      "sourceColumn": "original column name",
      "canonicalField": "canonical field name or 'UNMAPPED'",
      "confidence": 0.0-1.0,
      "reasoning": "brief explanation"
    }
  ],
  "unmappedColumns": ["columns that don't match any canonical field"]
}`;

  return invokeModel<SchemaInferenceOutput>(prompt, SCHEMA_INFERENCE_SYSTEM_PROMPT);
}

// Validation prompt and function
const VALIDATION_SYSTEM_PROMPT = `You are a data quality analyst. Your task is to validate business entity data and identify issues.

Validation rules:
- company_name: Required, should be a plausible business name
- country: Must be ISO 3166-1 alpha-2 or can be converted to it
- email: Must be valid email format if present
- website: Must be valid URL format if present
- postal_code: Should match country's format when possible
- vat_id: Should match country's VAT format when possible
- phone: Should be plausible phone number format

Issue types:
- MISSING: Required field is empty
- INVALID: Field value doesn't match expected format
- SUSPICIOUS: Value seems incorrect but might be valid
- FORMAT_ERROR: Value format is incorrect

Severity levels:
- ERROR: Must be fixed
- WARNING: Should be reviewed
- INFO: Minor issue

Focus only on business data quality. Do not flag personal data or make assumptions about individuals.
Respond ONLY with valid JSON. Do not include explanations outside JSON.`;

interface ValidationInput {
  rowIndex: number;
  data: Record<string, string | null>;
}

interface ValidationOutput {
  issues: ValidationIssue[];
}

export async function validateRow(input: ValidationInput): Promise<ValidationOutput> {
  const prompt = `Validate this business entity data for row ${input.rowIndex}:

${JSON.stringify(input.data, null, 2)}

Respond with JSON matching this schema:
{
  "issues": [
    {
      "field": "field name",
      "originalValue": "current value or null",
      "issueType": "MISSING|INVALID|SUSPICIOUS|FORMAT_ERROR",
      "severity": "ERROR|WARNING|INFO",
      "message": "description of the issue",
      "suggestedValue": "optional suggested correction"
    }
  ]
}

If no issues found, return {"issues": []}`;

  return invokeModel<ValidationOutput>(prompt, VALIDATION_SYSTEM_PROMPT);
}

// Batch validation for efficiency
export async function validateRowsBatch(rows: ValidationInput[]): Promise<ValidationOutput[]> {
  const prompt = `Validate these business entity data rows:

${rows.map((row, i) => `Row ${row.rowIndex}:\n${JSON.stringify(row.data, null, 2)}`).join('\n\n')}

Respond with JSON array where each element matches:
{
  "rowIndex": number,
  "issues": [
    {
      "field": "field name",
      "originalValue": "current value or null",
      "issueType": "MISSING|INVALID|SUSPICIOUS|FORMAT_ERROR",
      "severity": "ERROR|WARNING|INFO",
      "message": "description of the issue",
      "suggestedValue": "optional suggested correction"
    }
  ]
}`;

  const results = await invokeModel<Array<{ rowIndex: number; issues: ValidationIssue[] }>>(
    prompt, 
    VALIDATION_SYSTEM_PROMPT
  );
  
  return results.map(r => ({ issues: r.issues }));
}

// Enrichment prompt and function
const ENRICHMENT_SYSTEM_PROMPT = `You are a business data enrichment analyst. Enrich and correct business entity data using your knowledge.

ENRICHMENT TASKS:
1. ADD missing websites for recognized brands (e.g., Holiday Inn → ihg.com, Hilton → hilton.com)
2. ADD missing city if derivable from location codes in the name
3. CORRECT invalid country codes (e.g., UK → GB, SZ for Switzerland → CH)
4. RESOLVE missing company_name from tax IDs: if company_name is empty/unknown but vat_id or registration_id is present, use the ID to identify the company. Tax ID formats: EU VAT IDs start with a 2-letter country code (e.g., ESB66725649 = Spain, DE123456789 = Germany, GB123456789 = UK, NO912345678MVA = Norway, DK12345678 = Denmark). Use your knowledge of well-known companies and their tax IDs to resolve the name.

COUNTRY CODE RULES:
- Use ISO 3166-1 alpha-2 codes
- UK is invalid → use GB
- SZ = Eswatini, NOT Switzerland (Switzerland = CH)
- Only correct a country code if it's actually wrong - verify against the city name
- If the city clearly belongs to the stated country, DO NOT change the country code

IMPORTANT: Use your geographic knowledge accurately. Major global brands (Holiday Inn, Hilton, Marriott, etc.) operate worldwide - their presence doesn't indicate a specific country.

Set needsManualReview to FALSE unless the business is completely unidentifiable.

Respond ONLY with valid JSON.`;

interface EnrichmentInput {
  rowIndex: number;
  currentData: Record<string, string | null>;
  validationIssues: ValidationIssue[];
  webSearchResults?: Array<{
    query: string;
    results: Array<{
      title: string;
      url: string;
      snippet: string;
    }>;
  }>;
  registryData?: Record<string, unknown>;
  viesResult?: { valid: boolean; name?: string; address?: string } | null;
}

interface EnrichmentOutput {
  fieldChanges: FieldChange[];
  entityCandidates?: Array<{
    name: string;
    confidence: number;
    matchReason: string;
  }>;
  needsManualReview: boolean;
  reviewReason?: string;
}

export async function enrichRow(input: EnrichmentInput): Promise<EnrichmentOutput> {
  const companyName = input.currentData.company_name || 'Unknown';
  const country = input.currentData.country || '';
  const city = input.currentData.city || '';
  const address = input.currentData.address_line1 || '';
  
  // Build web search context section if we have results
  let webSearchContext = '';
  if (input.webSearchResults && input.webSearchResults.length > 0) {
    const hasResults = input.webSearchResults.some(r => r.results.length > 0);
    if (hasResults) {
      webSearchContext = `\nWeb search results (use these to verify and add information):\n`;
      for (const search of input.webSearchResults) {
        if (search.results.length > 0) {
          webSearchContext += `\nQuery: "${search.query}"\n`;
          for (const result of search.results) {
            webSearchContext += `- ${result.title}: ${result.url}\n  ${result.snippet}\n`;
          }
        }
      }
      webSearchContext += `\nUse these search results as sources. For website fields, prefer the official domain from search results.\n`;
    }
  }

  // Build VIES context if available
  let viesContext = '';
  if (input.viesResult) {
    if (input.viesResult.name) {
      viesContext = `\nVIES VAT Registry lookup result: VALID - Legal entity name: "${input.viesResult.name}"${input.viesResult.address ? `, Address: "${input.viesResult.address}"` : ''}`;
      viesContext += `\nIMPORTANT: The VIES name is the official legal entity name. Use it as the authoritative company_name.\n`;
    } else if (!input.viesResult.valid) {
      viesContext = `\nVIES VAT Registry lookup: VAT number is INVALID or EXPIRED. No name returned. Be cautious about assumptions based on the trade name alone.\n`;
    } else {
      viesContext = `\nVIES VAT Registry lookup: VAT is valid but no name was returned by the registry.\n`;
    }
  }

  const prompt = `Enrich this business entity data:

Company: "${companyName}"
City: "${city}"
Country code: "${country}"
Address: "${address}"

Full data:
${JSON.stringify(input.currentData, null, 2)}

${input.validationIssues.length > 0 ? `Validation issues to address:\n${JSON.stringify(input.validationIssues, null, 2)}` : ''}
${viesContext}${webSearchContext}
Tasks:
1. If you recognize the brand, add the parent company website
2. If the country code is invalid (like UK instead of GB), correct it
3. If city and country code don't match geographically, correct the country code
4. Add missing industry/sector if you can identify it
5. If company_name is missing/empty but vat_id or registration_id is present, try to identify the company from the ID. Use the country prefix in VAT IDs (e.g., ES = Spain, DE = Germany) and your knowledge of company registrations to propose the company name.
6. Only make changes you're confident about
7. If web search results are provided, use the URLs as sources and extract factual data from snippets

Respond with JSON:
{
  "fieldChanges": [
    {
      "field": "field_name",
      "originalValue": "original or null",
      "proposedValue": "new value",
      "confidence": 0.0-1.0,
      "reasoning": "brief explanation",
      "sources": [{"url": "source URL or N/A", "type": "LLM_KNOWLEDGE or SEARCH_RESULT or OFFICIAL_WEBSITE", "retrievedAt": "${new Date().toISOString()}", "snippet": "knowledge source"}],
      "action": "ADDED or CORRECTED"
    }
  ],
  "entityCandidates": [],
  "needsManualReview": false,
  "reviewReason": ""
}`;

  return invokeModel<EnrichmentOutput>(prompt, ENRICHMENT_SYSTEM_PROMPT);
}

// Country code normalization
const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  'germany': 'DE',
  'deutschland': 'DE',
  'france': 'FR',
  'united states': 'US',
  'usa': 'US',
  'united kingdom': 'GB',
  'uk': 'GB',
  'great britain': 'GB',
  'england': 'GB',
  'netherlands': 'NL',
  'holland': 'NL',
  'belgium': 'BE',
  'austria': 'AT',
  'switzerland': 'CH',
  'swiss': 'CH',
  'suisse': 'CH',
  'schweiz': 'CH',
  'spain': 'ES',
  'italy': 'IT',
  'portugal': 'PT',
  'poland': 'PL',
  'czech republic': 'CZ',
  'czechia': 'CZ',
  'china': 'CN',
  'japan': 'JP',
  'australia': 'AU',
  'canada': 'CA',
  'mexico': 'MX',
  'brazil': 'BR',
  'india': 'IN',
  'singapore': 'SG',
  'hong kong': 'HK',
  'taiwan': 'TW',
  'south korea': 'KR',
  'korea': 'KR',
};

// Common country code mistakes that need correction
const SUSPICIOUS_COUNTRY_CODES: Record<string, { correctCode: string; reason: string }> = {
  'SZ': { correctCode: 'CH', reason: 'SZ is Eswatini (Swaziland), not Switzerland. Switzerland is CH.' },
  'UK': { correctCode: 'GB', reason: 'UK is not a valid ISO code. United Kingdom is GB.' },
  'EN': { correctCode: 'GB', reason: 'EN is not a valid country code. England/UK is GB.' },
  'SW': { correctCode: 'CH', reason: 'SW is not a valid country code. If Switzerland intended, use CH.' },
  'GER': { correctCode: 'DE', reason: 'GER is not a valid ISO code. Germany is DE.' },
  'FRA': { correctCode: 'FR', reason: 'FRA is not a valid ISO code. France is FR.' },
  'SWE': { correctCode: 'SE', reason: 'SWE is not a valid ISO code. Sweden is SE.' },
  'AUS': { correctCode: 'AU', reason: 'AUS is not a valid ISO code. Australia is AU.' },
  'NOR': { correctCode: 'NO', reason: 'NOR is not a valid ISO code. Norway is NO.' },
  'DEN': { correctCode: 'DK', reason: 'DEN is not a valid ISO code. Denmark is DK.' },
  'FIN': { correctCode: 'FI', reason: 'FIN is not a valid ISO code. Finland is FI.' },
  'JAP': { correctCode: 'JP', reason: 'JAP is not a valid ISO code. Japan is JP.' },
  'CHN': { correctCode: 'CN', reason: 'CHN is not a valid ISO code. China is CN.' },
  'KOR': { correctCode: 'KR', reason: 'KOR is not a valid ISO code. South Korea is KR.' },
  'RUS': { correctCode: 'RU', reason: 'RUS is not a valid ISO code. Russia is RU.' },
  'BRA': { correctCode: 'BR', reason: 'BRA is not a valid ISO code. Brazil is BR.' },
  'MEX': { correctCode: 'MX', reason: 'MEX is not a valid ISO code. Mexico is MX.' },
  'ITA': { correctCode: 'IT', reason: 'ITA is not a valid ISO code. Italy is IT.' },
  'ESP': { correctCode: 'ES', reason: 'ESP is not a valid ISO code. Spain is ES.' },
  'POR': { correctCode: 'PT', reason: 'POR is not a valid ISO code. Portugal is PT.' },
  'NED': { correctCode: 'NL', reason: 'NED is not a valid ISO code. Netherlands is NL.' },
  'HOL': { correctCode: 'NL', reason: 'HOL is not a valid ISO code. Netherlands is NL.' },
  'BEL': { correctCode: 'BE', reason: 'BEL is not a valid ISO code. Belgium is BE.' },
  'SUI': { correctCode: 'CH', reason: 'SUI is not a valid ISO code. Switzerland is CH.' },
};

// Postal code patterns by country (regex + expected country)
// Used to detect mismatched postal code / country combinations
export const POSTAL_CODE_PATTERNS: Record<string, { regex: RegExp; country: string; countryName: string }> = {
  CH: { regex: /^[1-9]\d{3}$/, country: 'CH', countryName: 'Switzerland' },
  DE: { regex: /^\d{5}$/, country: 'DE', countryName: 'Germany' },
  AT: { regex: /^\d{4}$/, country: 'AT', countryName: 'Austria' },
  NL: { regex: /^\d{4}\s?[A-Z]{2}$/, country: 'NL', countryName: 'Netherlands' },
  BE: { regex: /^\d{4}$/, country: 'BE', countryName: 'Belgium' },
  FR: { regex: /^\d{5}$/, country: 'FR', countryName: 'France' },
  IT: { regex: /^\d{5}$/, country: 'IT', countryName: 'Italy' },
  ES: { regex: /^\d{5}$/, country: 'ES', countryName: 'Spain' },
  PT: { regex: /^\d{4}(-\d{3})?$/, country: 'PT', countryName: 'Portugal' },
  SE: { regex: /^\d{3}\s?\d{2}$/, country: 'SE', countryName: 'Sweden' },
  DK: { regex: /^\d{4}$/, country: 'DK', countryName: 'Denmark' },
  NO: { regex: /^\d{4}$/, country: 'NO', countryName: 'Norway' },
  FI: { regex: /^\d{5}$/, country: 'FI', countryName: 'Finland' },
  PL: { regex: /^\d{2}-\d{3}$/, country: 'PL', countryName: 'Poland' },
  CZ: { regex: /^\d{3}\s?\d{2}$/, country: 'CZ', countryName: 'Czech Republic' },
  US: { regex: /^\d{5}(-\d{4})?$/, country: 'US', countryName: 'United States' },
  CA: { regex: /^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/, country: 'CA', countryName: 'Canada' },
  GB: { regex: /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/, country: 'GB', countryName: 'United Kingdom' },
  JP: { regex: /^\d{3}-?\d{4}$/, country: 'JP', countryName: 'Japan' },
  AU: { regex: /^\d{4}$/, country: 'AU', countryName: 'Australia' },
  SG: { regex: /^\d{6}$/, country: 'SG', countryName: 'Singapore' },
  CN: { regex: /^\d{6}$/, country: 'CN', countryName: 'China' },
  IN: { regex: /^\d{6}$/, country: 'IN', countryName: 'India' },
  BR: { regex: /^\d{5}-?\d{3}$/, country: 'BR', countryName: 'Brazil' },
};

/**
 * Validate a postal code against a country's expected format.
 * Returns the likely correct country if there's a mismatch.
 */
export function validatePostalCodeCountry(
  postalCode: string | null,
  country: string | null
): { valid: boolean; likelyCountry?: string; likelyCountryName?: string; reason?: string } {
  if (!postalCode || !country) return { valid: true };

  const cleanPostal = postalCode.trim().toUpperCase();
  const upperCountry = country.toUpperCase().trim();

  // Check if postal code matches the stated country
  const countryPattern = POSTAL_CODE_PATTERNS[upperCountry];
  if (countryPattern && countryPattern.regex.test(cleanPostal)) {
    return { valid: true }; // Postal code matches country format
  }

  // Check Swiss-specific ranges (1000-9999, 4 digits)
  if (/^[1-9]\d{3}$/.test(cleanPostal)) {
    const num = parseInt(cleanPostal, 10);
    // Swiss postal codes: 1000-9658
    if (num >= 1000 && num <= 9658 && upperCountry !== 'CH' && upperCountry !== 'AT') {
      // Could be Swiss or Austrian (AT also uses 4 digits 1010-9992)
      // If stated country doesn't use 4-digit codes, likely Swiss or Austrian
      if (!countryPattern || !countryPattern.regex.test(cleanPostal)) {
        return {
          valid: false,
          likelyCountry: 'CH',
          likelyCountryName: 'Switzerland',
          reason: `Postal code ${cleanPostal} looks like a Swiss postal code but country is ${upperCountry}`,
        };
      }
    }
  }

  // Check if postal code matches any other known country format
  if (countryPattern && !countryPattern.regex.test(cleanPostal)) {
    for (const [code, pattern] of Object.entries(POSTAL_CODE_PATTERNS)) {
      if (code !== upperCountry && pattern.regex.test(cleanPostal)) {
        return {
          valid: false,
          likelyCountry: pattern.country,
          likelyCountryName: pattern.countryName,
          reason: `Postal code ${cleanPostal} doesn't match ${upperCountry} format but matches ${pattern.countryName} (${pattern.country})`,
        };
      }
    }
    return {
      valid: false,
      reason: `Postal code ${cleanPostal} doesn't match expected format for ${upperCountry}`,
    };
  }

  return { valid: true };
}

/**
 * Auto-fix common website URL issues.
 * Returns the fixed URL or null if unfixable.
 */
export function normalizeWebsiteUrl(url: string | null): { url: string; wasFixed: boolean } | null {
  if (!url) return null;

  let cleaned = url.trim();
  let wasFixed = false;

  // Remove trailing slashes, whitespace
  cleaned = cleaned.replace(/\/+$/, '').trim();

  // Add protocol if missing
  if (!/^https?:\/\//i.test(cleaned)) {
    cleaned = `https://${cleaned}`;
    wasFixed = true;
  }

  // Fix http:// to https:// (prefer secure)
  if (/^http:\/\//i.test(cleaned)) {
    cleaned = cleaned.replace(/^http:\/\//i, 'https://');
    wasFixed = true;
  }

  // Validate the result
  try {
    new URL(cleaned);
    return { url: cleaned, wasFixed };
  } catch {
    return null;
  }
}

/**
 * Normalize phone number towards E.164 format.
 * Returns cleaned phone or original if it can't be parsed.
 */
export function normalizePhone(phone: string | null, country?: string | null): { phone: string; wasFixed: boolean } | null {
  if (!phone) return null;

  let cleaned = phone.trim();
  const original = cleaned;

  // Remove common decorative characters
  cleaned = cleaned.replace(/[\(\)\s\-\.]/g, '');

  // Already starts with +, just clean formatting
  if (cleaned.startsWith('+')) {
    const wasFixed = cleaned !== original.replace(/\s/g, '');
    return { phone: cleaned, wasFixed };
  }

  // Country-specific prefix mapping
  const COUNTRY_DIAL_CODES: Record<string, string> = {
    'DE': '+49', 'FR': '+33', 'GB': '+44', 'US': '+1', 'CH': '+41',
    'AT': '+43', 'NL': '+31', 'BE': '+32', 'IT': '+39', 'ES': '+34',
    'PT': '+351', 'SE': '+46', 'DK': '+45', 'NO': '+47', 'FI': '+358',
    'PL': '+48', 'CZ': '+420', 'JP': '+81', 'CN': '+86', 'AU': '+61',
    'CA': '+1', 'BR': '+55', 'IN': '+91', 'SG': '+65', 'KR': '+82',
    'MX': '+52', 'IE': '+353', 'HK': '+852', 'TW': '+886', 'RU': '+7',
  };

  // If starts with 00, replace with +
  if (cleaned.startsWith('00')) {
    cleaned = '+' + cleaned.substring(2);
    return { phone: cleaned, wasFixed: true };
  }

  // If starts with 0 and we know the country, add the country code
  if (cleaned.startsWith('0') && country) {
    const dialCode = COUNTRY_DIAL_CODES[country.toUpperCase()];
    if (dialCode) {
      cleaned = dialCode + cleaned.substring(1);
      return { phone: cleaned, wasFixed: true };
    }
  }

  // Return cleaned version
  const wasFixed = cleaned !== original;
  return { phone: cleaned, wasFixed };
}

export function normalizeCountryCode(country: string | null): string | null {
  if (!country) return null;
  
  const upper = country.toUpperCase().trim();
  // Already ISO code
  if (upper.length === 2 && /^[A-Z]{2}$/.test(upper)) {
    return upper;
  }
  
  const lower = country.toLowerCase().trim();
  return COUNTRY_NAME_TO_CODE[lower] || null;
}

// Check if a country code is commonly misused
export function checkSuspiciousCountryCode(countryCode: string | null): { isSuspicious: boolean; suggestion?: string; reason?: string } {
  if (!countryCode) return { isSuspicious: false };
  
  const upper = countryCode.toUpperCase().trim();
  const suspiciousEntry = SUSPICIOUS_COUNTRY_CODES[upper];
  
  if (suspiciousEntry) {
    return {
      isSuspicious: true,
      suggestion: suspiciousEntry.correctCode,
      reason: suspiciousEntry.reason,
    };
  }
  
  return { isSuspicious: false };
}

// Email validation
export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// URL validation
export function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

// Phone validation (basic)
export function isValidPhone(phone: string): boolean {
  // Remove common separators and check for digits
  const digits = phone.replace(/[\s\-\(\)\+\.]/g, '');
  return /^\d{7,15}$/.test(digits);
}
