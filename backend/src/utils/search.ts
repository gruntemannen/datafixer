import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'search' });

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Search the web using Tavily API (optimized for AI agents).
 * Falls back gracefully to empty results if no API key is configured.
 * Get a key at https://tavily.com (free tier: 1000 searches/month).
 */
export async function searchWeb(query: string): Promise<SearchResult[]> {
  const apiKey = process.env.SEARCH_API_KEY;

  if (!apiKey) {
    logger.debug('No SEARCH_API_KEY configured, skipping web search', { query });
    return [];
  }

  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: 'basic',
        max_results: 3,
        include_answer: false,
      }),
      signal: AbortSignal.timeout(15000), // 15s timeout
    });

    if (!response.ok) {
      logger.warn('Tavily API returned non-OK status', {
        status: response.status,
        query,
      });
      return [];
    }

    const data = await response.json() as {
      results?: Array<{
        title: string;
        url: string;
        content: string;
      }>;
    };

    const results: SearchResult[] = (data.results || []).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.content?.substring(0, 500) || '',
    }));

    logger.info('Web search completed', { query, resultCount: results.length });
    return results;
  } catch (error) {
    logger.warn('Web search failed', { error, query });
    return [];
  }
}

/**
 * Search for a company's official website.
 */
export async function searchCompanyWebsite(
  companyName: string,
  country?: string
): Promise<SearchResult[]> {
  const location = country ? ` ${country}` : '';
  return searchWeb(`${companyName}${location} official website`);
}

/**
 * Search for company registration/business information.
 */
export async function searchCompanyInfo(
  companyName: string,
  country?: string
): Promise<SearchResult[]> {
  const location = country ? ` ${country}` : '';
  return searchWeb(`${companyName}${location} company information address`);
}
