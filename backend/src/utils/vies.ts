import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'vies' });

// EU VIES VAT Validation API - free, no API key required
// https://ec.europa.eu/taxation_customs/vies/
const VIES_REST_URL = 'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number';

export interface ViesResult {
  valid: boolean;
  countryCode: string;
  vatNumber: string;
  name?: string;
  address?: string;
  requestDate?: string;
}

// EU country codes that support VIES
const VIES_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'EL', 'ES',
  'FI', 'FR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT',
  'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'XI', // XI = Northern Ireland
]);

/**
 * Parse a VAT ID string into country code + number.
 * Handles formats like: DE123456789, DE 123.456.789, CHE-123.456.789
 */
export function parseVatId(vatId: string): { countryCode: string; number: string } | null {
  if (!vatId) return null;

  const cleaned = vatId.trim().toUpperCase();

  // Try to extract 2-letter country prefix
  const match = cleaned.match(/^([A-Z]{2,3})[\s\-.]?(.+)$/);
  if (!match) return null;

  let countryCode = match[1];
  let number = match[2].replace(/[\s\-.]/g, ''); // Strip separators

  // CHE prefix → CH for VIES
  if (countryCode === 'CHE') {
    return null; // Switzerland is not in the EU VIES system
  }

  // EL is Greece's VIES code
  if (countryCode === 'GR') {
    countryCode = 'EL';
  }

  if (!VIES_COUNTRIES.has(countryCode)) {
    return null; // Not an EU country
  }

  return { countryCode, number };
}

/**
 * Validate a VAT number against the EU VIES service.
 * Returns company name and address if the VAT is valid.
 */
export async function validateVat(vatId: string): Promise<ViesResult | null> {
  const parsed = parseVatId(vatId);
  if (!parsed) {
    logger.info('VAT ID not eligible for VIES validation', { vatId });
    return null;
  }

  try {
    const response = await fetch(VIES_REST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        countryCode: parsed.countryCode,
        vatNumber: parsed.number,
      }),
      signal: AbortSignal.timeout(10000), // 10s timeout
    });

    if (!response.ok) {
      logger.warn('VIES API returned non-OK status', { status: response.status, vatId });
      return null;
    }

    const data = await response.json() as {
      isValid: boolean;
      requestDate: string;
      countryCode: string;
      vatNumber: string;
      name?: string;
      address?: string;
    };

    const result: ViesResult = {
      valid: data.isValid,
      countryCode: data.countryCode === 'EL' ? 'GR' : data.countryCode,
      vatNumber: data.vatNumber,
      name: data.name && data.name !== '---' ? data.name : undefined,
      address: data.address && data.address !== '---' ? data.address : undefined,
      requestDate: data.requestDate,
    };

    logger.info('VIES validation result', {
      vatId,
      valid: result.valid,
      hasName: !!result.name,
      hasAddress: !!result.address,
    });

    return result;
  } catch (error) {
    // VIES is sometimes unavailable; don't fail the enrichment
    logger.warn('VIES API call failed', { error, vatId });
    return null;
  }
}

/**
 * Extract city and postal code from a VIES address string.
 * VIES returns addresses in various formats depending on the country.
 */
export function parseViesAddress(address: string): {
  streetAddress?: string;
  postalCode?: string;
  city?: string;
} {
  if (!address) return {};

  // VIES addresses are typically multi-line or comma-separated
  const lines = address.split(/\n|,/).map(l => l.trim()).filter(Boolean);

  if (lines.length === 0) return {};

  // Last line usually contains postal code + city
  const lastLine = lines[lines.length - 1];
  const postalCityMatch = lastLine.match(/^(\d{4,6})\s+(.+)$/) ||
    lastLine.match(/^([A-Z]{1,2}\d{1,2}\s?\d[A-Z]{2})\s+(.+)$/); // UK format

  const result: { streetAddress?: string; postalCode?: string; city?: string } = {};

  if (postalCityMatch) {
    result.postalCode = postalCityMatch[1];
    result.city = postalCityMatch[2];
    if (lines.length > 1) {
      result.streetAddress = lines.slice(0, -1).join(', ');
    }
  } else if (lines.length >= 2) {
    // First line is street, last is city/postal
    result.streetAddress = lines[0];
    result.city = lastLine;
  } else {
    // Single line, likely just the city
    result.city = lastLine;
  }

  return result;
}
