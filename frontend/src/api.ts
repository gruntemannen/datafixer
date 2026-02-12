import { getConfig } from './config';

let apiEndpoint: string | null = null;
let getAuthToken: (() => Promise<string | null>) | null = null;

export function setAuthTokenGetter(getter: () => Promise<string | null>) {
  getAuthToken = getter;
}

async function getApiEndpoint(): Promise<string> {
  if (apiEndpoint) return apiEndpoint;
  const config = await getConfig();
  apiEndpoint = config.apiEndpoint;
  return apiEndpoint;
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const endpoint = await getApiEndpoint();
  const token = getAuthToken ? await getAuthToken() : null;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${endpoint}${path}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `Request failed: ${response.status}`);
  }

  return response.json();
}

// API Types
export interface Job {
  jobId: string;
  status: string;
  fileName: string;
  fileSizeBytes?: number;
  totalRows?: number;
  processedRows?: number;
  enrichmentBatchesTotal?: number;
  enrichmentBatchesCompleted?: number;
  summary?: {
    totalRows: number;
    validRows: number;
    rowsWithIssues: number;
    rowsEnriched: number;
    fieldsFilled: number;
    fieldsCorrected: number;
    fieldsDiscovered: number;
  };
  errorMessage?: string;
  createdAt: string;
  updatedAt?: string;
  completedAt?: string;
}

export interface UploadUrlResponse {
  uploadUrl: string;
  fileKey: string;
  jobId: string;
  expiresIn: number;
}

export interface ValidationIssue {
  field: string;
  originalValue: string | null;
  issueType: string;
  severity: string;
  message: string;
  suggestedValue?: string;
}

export interface FieldChange {
  field: string;
  originalValue: string | null;
  proposedValue: string;
  confidence: number;
  reasoning: string;
  action: string;
  sources: Array<{
    url: string;
    type: string;
    retrievedAt: string;
    snippet?: string;
  }>;
}

export interface ProcessedRow {
  rowIndex: number;
  originalData: Record<string, string>;
  canonicalData: Record<string, string | null>;
  validationIssues: ValidationIssue[];
  enrichmentResults?: FieldChange[];
  status: string;
  entityCandidates?: Array<{
    name: string;
    confidence: number;
    sources: unknown[];
  }>;
}

export interface JobResultsResponse {
  jobId: string;
  status: string;
  rows: ProcessedRow[];
  totalRows: number;
  pageSize: number;
  nextCursor?: string;
  hasMore: boolean;
}

// Column preview types
export interface ColumnPreview {
  headers: string[];
  sampleRows: Record<string, string>[];
  totalRows: number;
  hasHeader: boolean;
  detectedDelimiter: string;
}

// API Functions
export async function getUploadUrl(fileName: string): Promise<UploadUrlResponse> {
  return request(`/upload-url?fileName=${encodeURIComponent(fileName)}`);
}

export async function previewColumns(fileKey: string): Promise<ColumnPreview> {
  return request(`/preview-columns?fileKey=${encodeURIComponent(fileKey)}`);
}

export async function uploadFile(url: string, file: File): Promise<void> {
  const response = await fetch(url, {
    method: 'PUT',
    body: file,
    headers: {
      'Content-Type': 'text/csv',
      'x-amz-server-side-encryption': 'aws:kms',
    },
  });

  if (!response.ok) {
    throw new Error('Failed to upload file');
  }
}

export async function createJob(
  fileKey: string,
  fileName: string,
  excludedColumns?: string[]
): Promise<Job> {
  return request('/jobs', {
    method: 'POST',
    body: JSON.stringify({
      fileKey,
      fileName,
      ...(excludedColumns && excludedColumns.length > 0 && { excludedColumns }),
    }),
  });
}

export async function listJobs(cursor?: string): Promise<{ jobs: Job[]; nextCursor?: string; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  return request(`/jobs?${params.toString()}`);
}

export async function getJobStatus(jobId: string): Promise<Job> {
  return request(`/jobs/${jobId}`);
}

export async function getJobResults(
  jobId: string,
  options?: { pageSize?: number; cursor?: string; filter?: string }
): Promise<JobResultsResponse> {
  const params = new URLSearchParams();
  if (options?.pageSize) params.set('pageSize', options.pageSize.toString());
  if (options?.cursor) params.set('cursor', options.cursor);
  if (options?.filter) params.set('filter', options.filter);
  return request(`/jobs/${jobId}/results?${params.toString()}`);
}

export async function getDownloadUrl(
  jobId: string,
  type: 'csv' | 'report'
): Promise<{ downloadUrl: string; fileName: string; expiresIn: number }> {
  return request(`/jobs/${jobId}/download?type=${type}`);
}

export async function deleteJob(jobId: string): Promise<{ message: string; jobId: string }> {
  return request(`/jobs/${jobId}`, {
    method: 'DELETE',
  });
}
