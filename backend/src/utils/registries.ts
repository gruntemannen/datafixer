import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'registries' });

/**
 * Standardized result from any company register lookup.
 */
export interface RegistryResult {
  source: string;                // e.g. "BRREG", "CVR", "COMPANIES_HOUSE", "OPENCORPORATES"
  sourceUrl: string;             // URL to the registry
  companyName: string;
  registrationId?: string;       // Company/org number
  vatId?: string;
  address?: string;
  postalCode?: string;
  city?: string;
  country: string;               // ISO 2-letter code
  industry?: string;
  website?: string;
  phone?: string;
  email?: string;
  status?: string;               // Active, dissolved, etc.
  confidence: number;            // 0-1 match confidence
}

// ─────────────────────────────────────────────────────────
// Norway - Brreg (Enhetsregisteret)
// Completely free, no API key required
// https://data.brreg.no/enhetsregisteret/api/docs/
// ─────────────────────────────────────────────────────────

interface BrregUnit {
  organisasjonsnummer: string;
  navn: string;
  organisasjonsform?: { kode: string; beskrivelse: string };
  postadresse?: {
    adresse?: string[];
    postnummer?: string;
    poststed?: string;
    land?: string;
  };
  forretningsadresse?: {
    adresse?: string[];
    postnummer?: string;
    poststed?: string;
    land?: string;
  };
  naeringskode1?: { kode: string; beskrivelse: string };
  hjemmeside?: string;
  registrertIMvaregisteret?: boolean;
}

export async function searchBrreg(companyName: string): Promise<RegistryResult[]> {
  try {
    const url = `https://data.brreg.no/enhetsregisteret/api/enheter?navn=${encodeURIComponent(companyName)}&size=3`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      logger.warn('Brreg API error', { status: response.status });
      return [];
    }

    const data = await response.json() as {
      _embedded?: { enheter?: BrregUnit[] };
    };

    const units = data._embedded?.enheter || [];

    return units.map(unit => {
      const addr = unit.forretningsadresse || unit.postadresse;
      const nameLower = companyName.toLowerCase();
      const unitLower = unit.navn.toLowerCase();
      // Simple name match confidence
      const confidence = unitLower === nameLower ? 0.95 :
        unitLower.includes(nameLower) || nameLower.includes(unitLower) ? 0.80 : 0.60;

      return {
        source: 'BRREG',
        sourceUrl: `https://data.brreg.no/enhetsregisteret/oppslag/enheter/${unit.organisasjonsnummer}`,
        companyName: unit.navn,
        registrationId: unit.organisasjonsnummer,
        vatId: unit.registrertIMvaregisteret ? `NO${unit.organisasjonsnummer}MVA` : undefined,
        address: addr?.adresse?.join(', '),
        postalCode: addr?.postnummer,
        city: addr?.poststed,
        country: 'NO',
        industry: unit.naeringskode1?.beskrivelse,
        website: unit.hjemmeside || undefined,
        confidence,
      };
    });
  } catch (error) {
    logger.warn('Brreg search failed', { error, companyName });
    return [];
  }
}

// ─────────────────────────────────────────────────────────
// Denmark - CVR API
// Free, no API key required, User-Agent header needed
// https://cvrapi.dk/documentation
// ─────────────────────────────────────────────────────────

interface CvrResult {
  vat: number;
  name: string;
  address: string;
  zipcode: string;
  city: string;
  phone?: string;
  email?: string;
  industrycode?: number;
  industrydesc?: string;
  companydesc?: string;
  startdate?: string;
  enddate?: string;
}

export async function searchCvr(companyName: string): Promise<RegistryResult[]> {
  try {
    const url = `https://cvrapi.dk/api?search=${encodeURIComponent(companyName)}&country=dk`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'DataFixer/1.0 (data-enrichment-service)',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      logger.warn('CVR API error', { status: response.status });
      return [];
    }

    const data = await response.json() as CvrResult;

    // CVR API returns a single best match
    if (!data.vat || !data.name) return [];

    const nameLower = companyName.toLowerCase();
    const resultLower = data.name.toLowerCase();
    const confidence = resultLower === nameLower ? 0.95 :
      resultLower.includes(nameLower) || nameLower.includes(resultLower) ? 0.80 : 0.60;

    return [{
      source: 'CVR',
      sourceUrl: `https://datacvr.virk.dk/enhed/virksomhed/${data.vat}`,
      companyName: data.name,
      registrationId: String(data.vat),
      vatId: `DK${data.vat}`,
      address: data.address,
      postalCode: data.zipcode,
      city: data.city,
      country: 'DK',
      industry: data.industrydesc,
      phone: data.phone || undefined,
      email: data.email || undefined,
      confidence,
    }];
  } catch (error) {
    logger.warn('CVR search failed', { error, companyName });
    return [];
  }
}

// ─────────────────────────────────────────────────────────
// UK - Companies House
// Free with API key (register at https://developer.company-information.service.gov.uk/)
// ─────────────────────────────────────────────────────────

interface CompaniesHouseItem {
  title: string;
  company_number: string;
  company_status: string;
  company_type: string;
  address_snippet?: string;
  address?: {
    address_line_1?: string;
    address_line_2?: string;
    postal_code?: string;
    locality?: string;
    region?: string;
    country?: string;
  };
}

export async function searchCompaniesHouse(companyName: string): Promise<RegistryResult[]> {
  const apiKey = process.env.COMPANIES_HOUSE_API_KEY;
  if (!apiKey) {
    logger.debug('No COMPANIES_HOUSE_API_KEY configured, skipping');
    return [];
  }

  try {
    const url = `https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(companyName)}&items_per_page=3`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(apiKey + ':').toString('base64')}`,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      logger.warn('Companies House API error', { status: response.status });
      return [];
    }

    const data = await response.json() as { items?: CompaniesHouseItem[] };

    return (data.items || []).map(item => {
      const nameLower = companyName.toLowerCase();
      const itemLower = item.title.toLowerCase();
      const confidence = itemLower === nameLower ? 0.95 :
        itemLower.includes(nameLower) || nameLower.includes(itemLower) ? 0.80 : 0.60;

      return {
        source: 'COMPANIES_HOUSE',
        sourceUrl: `https://find-and-update.company-information.service.gov.uk/company/${item.company_number}`,
        companyName: item.title,
        registrationId: item.company_number,
        address: item.address?.address_line_1
          ? [item.address.address_line_1, item.address.address_line_2].filter(Boolean).join(', ')
          : undefined,
        postalCode: item.address?.postal_code,
        city: item.address?.locality,
        country: 'GB',
        status: item.company_status,
        confidence,
      };
    });
  } catch (error) {
    logger.warn('Companies House search failed', { error, companyName });
    return [];
  }
}

// ─────────────────────────────────────────────────────────
// OpenCorporates - Global company data (200M+ companies)
// Free with API key (register at https://api.opencorporates.com/)
// ─────────────────────────────────────────────────────────

interface OpenCorpCompany {
  name: string;
  company_number: string;
  jurisdiction_code: string;
  incorporation_date?: string;
  dissolution_date?: string;
  current_status?: string;
  registered_address_in_full?: string;
  opencorporates_url: string;
}

// Map OpenCorporates jurisdiction codes to ISO country codes
const JURISDICTION_TO_COUNTRY: Record<string, string> = {
  'gb': 'GB', 'us_de': 'US', 'us_ny': 'US', 'us_ca': 'US', 'us_tx': 'US',
  'de': 'DE', 'fr': 'FR', 'nl': 'NL', 'be': 'BE', 'ch': 'CH', 'at': 'AT',
  'it': 'IT', 'es': 'ES', 'se': 'SE', 'no': 'NO', 'dk': 'DK', 'fi': 'FI',
  'ie': 'IE', 'pl': 'PL', 'cz': 'CZ', 'pt': 'PT', 'au': 'AU', 'ca': 'CA',
  'jp': 'JP', 'sg': 'SG', 'hk': 'HK', 'in': 'IN', 'br': 'BR', 'mx': 'MX',
  'za': 'ZA', 'nz': 'NZ', 'lu': 'LU',
};

function jurisdictionToCountry(code: string): string | undefined {
  if (!code) return undefined;
  const lower = code.toLowerCase();
  // Direct match
  if (JURISDICTION_TO_COUNTRY[lower]) return JURISDICTION_TO_COUNTRY[lower];
  // Try the first 2 chars (e.g., "us_de" -> "us")
  const prefix = lower.split('_')[0];
  return JURISDICTION_TO_COUNTRY[prefix] || prefix.toUpperCase();
}

export async function searchOpenCorporates(
  companyName: string,
  country?: string,
): Promise<RegistryResult[]> {
  const apiKey = process.env.OPENCORPORATES_API_KEY;
  if (!apiKey) {
    logger.debug('No OPENCORPORATES_API_KEY configured, skipping');
    return [];
  }

  try {
    let url = `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(companyName)}&api_token=${apiKey}&per_page=3`;
    if (country) {
      // OpenCorporates uses lowercase jurisdiction codes
      url += `&jurisdiction_code=${country.toLowerCase()}`;
    }

    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      logger.warn('OpenCorporates API error', { status: response.status });
      return [];
    }

    const data = await response.json() as {
      results?: { companies?: Array<{ company: OpenCorpCompany }> };
    };

    return (data.results?.companies || []).map(({ company }) => {
      const nameLower = companyName.toLowerCase();
      const compLower = company.name.toLowerCase();
      const confidence = compLower === nameLower ? 0.90 :
        compLower.includes(nameLower) || nameLower.includes(compLower) ? 0.75 : 0.55;

      const countryCode = jurisdictionToCountry(company.jurisdiction_code);

      return {
        source: 'OPENCORPORATES',
        sourceUrl: company.opencorporates_url,
        companyName: company.name,
        registrationId: company.company_number,
        address: company.registered_address_in_full || undefined,
        country: countryCode || company.jurisdiction_code.toUpperCase(),
        status: company.current_status,
        confidence,
      };
    });
  } catch (error) {
    logger.warn('OpenCorporates search failed', { error, companyName });
    return [];
  }
}

// ─────────────────────────────────────────────────────────
// Direct ID-based lookups — more reliable than name search
// when a tax ID or registration number is known
// ─────────────────────────────────────────────────────────

async function lookupBrregById(orgNumber: string): Promise<RegistryResult | null> {
  try {
    const cleaned = orgNumber.replace(/\D/g, '');
    if (cleaned.length !== 9) return null;

    const url = `https://data.brreg.no/enhetsregisteret/api/enheter/${cleaned}`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return null;

    const unit = await response.json() as BrregUnit;
    if (!unit.navn) return null;

    const addr = unit.forretningsadresse || unit.postadresse;
    return {
      source: 'BRREG',
      sourceUrl: `https://data.brreg.no/enhetsregisteret/oppslag/enheter/${unit.organisasjonsnummer}`,
      companyName: unit.navn,
      registrationId: unit.organisasjonsnummer,
      vatId: unit.registrertIMvaregisteret ? `NO${unit.organisasjonsnummer}MVA` : undefined,
      address: addr?.adresse?.join(', '),
      postalCode: addr?.postnummer,
      city: addr?.poststed,
      country: 'NO',
      industry: unit.naeringskode1?.beskrivelse,
      website: unit.hjemmeside || undefined,
      confidence: 0.98,
    };
  } catch (error) {
    logger.warn('Brreg ID lookup failed', { error, orgNumber });
    return null;
  }
}

async function lookupCvrById(cvrNumber: string): Promise<RegistryResult | null> {
  try {
    const cleaned = cvrNumber.replace(/\D/g, '');
    if (cleaned.length < 7 || cleaned.length > 8) return null;

    const url = `https://cvrapi.dk/api?vat=${cleaned}&country=dk`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'DataFixer/1.0 (data-enrichment-service)',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return null;

    const data = await response.json() as CvrResult;
    if (!data.vat || !data.name) return null;

    return {
      source: 'CVR',
      sourceUrl: `https://datacvr.virk.dk/enhed/virksomhed/${data.vat}`,
      companyName: data.name,
      registrationId: String(data.vat),
      vatId: `DK${data.vat}`,
      address: data.address,
      postalCode: data.zipcode,
      city: data.city,
      country: 'DK',
      industry: data.industrydesc,
      phone: data.phone || undefined,
      email: data.email || undefined,
      confidence: 0.98,
    };
  } catch (error) {
    logger.warn('CVR ID lookup failed', { error, cvrNumber });
    return null;
  }
}

async function lookupCompaniesHouseById(companyNumber: string): Promise<RegistryResult | null> {
  const apiKey = process.env.COMPANIES_HOUSE_API_KEY;
  if (!apiKey) return null;

  try {
    const cleaned = companyNumber.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (cleaned.length < 6 || cleaned.length > 8) return null;

    const url = `https://api.company-information.service.gov.uk/company/${cleaned}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(apiKey + ':').toString('base64')}`,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return null;

    const item = await response.json() as {
      company_name: string;
      company_number: string;
      company_status: string;
      registered_office_address?: {
        address_line_1?: string;
        address_line_2?: string;
        postal_code?: string;
        locality?: string;
      };
    };

    if (!item.company_name) return null;

    return {
      source: 'COMPANIES_HOUSE',
      sourceUrl: `https://find-and-update.company-information.service.gov.uk/company/${item.company_number}`,
      companyName: item.company_name,
      registrationId: item.company_number,
      address: item.registered_office_address?.address_line_1
        ? [item.registered_office_address.address_line_1, item.registered_office_address.address_line_2].filter(Boolean).join(', ')
        : undefined,
      postalCode: item.registered_office_address?.postal_code,
      city: item.registered_office_address?.locality,
      country: 'GB',
      status: item.company_status,
      confidence: 0.98,
    };
  } catch (error) {
    logger.warn('Companies House ID lookup failed', { error, companyNumber });
    return null;
  }
}

/**
 * Infer which country a tax ID / registration number belongs to based on its format.
 * EU VAT IDs have a 2-letter country prefix; other formats use length/pattern heuristics.
 */
function inferCountryFromTaxId(taxId: string): string | null {
  const cleaned = taxId.replace(/[\s.-]/g, '').toUpperCase();
  // EU VAT format: 2-letter country code + digits/chars
  const euMatch = cleaned.match(/^([A-Z]{2})\d/);
  if (euMatch) {
    const code = euMatch[1] === 'EL' ? 'GR' : euMatch[1];
    return code;
  }
  return null;
}

/**
 * Resolve a company from a tax ID or registration number by doing direct
 * ID-based lookups against business registries. Returns the best match or null.
 */
export async function searchRegistriesByTaxId(
  taxId?: string | null,
  registrationId?: string | null,
  country?: string | null,
): Promise<RegistryResult | null> {
  const idToSearch = taxId || registrationId;
  if (!idToSearch) return null;

  const inferredCountry = country?.toUpperCase() || inferCountryFromTaxId(idToSearch);
  const cleaned = idToSearch.replace(/^[A-Z]{2}/, '').replace(/\D/g, '');

  logger.info('Registry ID lookup', { taxId, registrationId, inferredCountry, cleaned });

  const searches: Promise<RegistryResult | null>[] = [];

  // Route to the right registry based on country
  if (inferredCountry === 'NO' || (!inferredCountry && cleaned.length === 9)) {
    searches.push(lookupBrregById(cleaned));
  }
  if (inferredCountry === 'DK' || (!inferredCountry && (cleaned.length === 7 || cleaned.length === 8))) {
    searches.push(lookupCvrById(cleaned));
  }
  if (inferredCountry === 'GB') {
    searches.push(lookupCompaniesHouseById(registrationId || idToSearch));
  }

  // If no country-specific match, try all registries
  if (searches.length === 0) {
    searches.push(lookupBrregById(cleaned));
    searches.push(lookupCvrById(cleaned));
    searches.push(lookupCompaniesHouseById(idToSearch));
  }

  const results = await Promise.all(searches);
  const found = results.filter((r): r is RegistryResult => r !== null);

  if (found.length === 0) {
    logger.info('No registry match found by ID', { taxId, registrationId });
    return null;
  }

  found.sort((a, b) => b.confidence - a.confidence);
  logger.info('Registry ID lookup resolved', {
    taxId,
    registrationId,
    matchedName: found[0].companyName,
    source: found[0].source,
    confidence: found[0].confidence,
  });

  return found[0];
}

// ─────────────────────────────────────────────────────────
// Unified registry search - routes to the right register(s)
// based on the company's country
// ─────────────────────────────────────────────────────────

export async function searchRegistries(
  companyName: string,
  country?: string | null,
): Promise<RegistryResult[]> {
  if (!companyName) return [];

  const searches: Promise<RegistryResult[]>[] = [];

  // Always search OpenCorporates if available (global coverage)
  searches.push(searchOpenCorporates(companyName, country || undefined));

  // Country-specific free registries
  const upperCountry = country?.toUpperCase();

  if (!upperCountry || upperCountry === 'NO') {
    searches.push(searchBrreg(companyName));
  }

  if (!upperCountry || upperCountry === 'DK') {
    searches.push(searchCvr(companyName));
  }

  if (!upperCountry || upperCountry === 'GB') {
    searches.push(searchCompaniesHouse(companyName));
  }

  // Run all searches in parallel
  const allResults = await Promise.all(searches);
  const flattened = allResults.flat();

  // Sort by confidence descending
  flattened.sort((a, b) => b.confidence - a.confidence);

  logger.info('Registry search completed', {
    companyName,
    country,
    totalResults: flattened.length,
    sources: [...new Set(flattened.map(r => r.source))],
  });

  return flattened;
}
