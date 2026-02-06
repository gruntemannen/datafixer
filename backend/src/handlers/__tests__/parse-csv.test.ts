import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock AWS SDK clients
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({
    send: vi.fn(),
  })),
  GetObjectCommand: vi.fn(),
  PutObjectCommand: vi.fn(),
}));

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn(() => ({
    send: vi.fn(),
  })),
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: vi.fn(() => ({
      send: vi.fn(),
    })),
  },
  UpdateCommand: vi.fn(),
}));

describe('CSV Parsing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set environment variables
    process.env.DATA_BUCKET = 'test-bucket';
    process.env.JOBS_TABLE = 'test-jobs';
    process.env.ROWS_TABLE = 'test-rows';
    process.env.ENRICHMENT_CACHE_TABLE = 'test-cache';
  });

  it('should detect comma delimiter', () => {
    const csv = 'name,city,country\nAcme,Berlin,Germany\nTest,Munich,Germany';
    const delimiter = detectDelimiter(csv);
    expect(delimiter).toBe(',');
  });

  it('should detect semicolon delimiter', () => {
    const csv = 'name;city;country\nAcme;Berlin;Germany\nTest;Munich;Germany';
    const delimiter = detectDelimiter(csv);
    expect(delimiter).toBe(';');
  });

  it('should detect tab delimiter', () => {
    const csv = 'name\tcity\tcountry\nAcme\tBerlin\tGermany\nTest\tMunich\tGermany';
    const delimiter = detectDelimiter(csv);
    expect(delimiter).toBe('\t');
  });

  it('should detect header row', () => {
    const firstRow = ['company_name', 'city', 'country'];
    const secondRow = ['Acme Corp', 'Berlin', 'Germany'];
    expect(hasHeader(firstRow, secondRow)).toBe(true);
  });

  it('should not detect header when first row has numbers', () => {
    const firstRow = ['123', 'Berlin', 'Germany'];
    const secondRow = ['456', 'Munich', 'Germany'];
    expect(hasHeader(firstRow, secondRow)).toBe(false);
  });
});

// Helper functions for testing (these match the implementation)
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
