import { z } from 'zod';

// Job status enum
export const JobStatus = {
  PENDING: 'PENDING',
  PARSING: 'PARSING',
  INFERRING_SCHEMA: 'INFERRING_SCHEMA',
  VALIDATING: 'VALIDATING',
  ENRICHING: 'ENRICHING',
  GENERATING_OUTPUTS: 'GENERATING_OUTPUTS',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;

export type JobStatusType = typeof JobStatus[keyof typeof JobStatus];

// Row status enum
export const RowStatus = {
  PENDING: 'PENDING',
  VALIDATED: 'VALIDATED',
  ENRICHED: 'ENRICHED',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  ERROR: 'ERROR',
} as const;

export type RowStatusType = typeof RowStatus[keyof typeof RowStatus];

// Issue severity
export const IssueSeverity = {
  ERROR: 'ERROR',
  WARNING: 'WARNING',
  INFO: 'INFO',
} as const;

export type IssueSeverityType = typeof IssueSeverity[keyof typeof IssueSeverity];

// Canonical field names
export const CanonicalFields = [
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
] as const;

export type CanonicalFieldType = typeof CanonicalFields[number];

// Schema for column mapping
export const ColumnMappingSchema = z.object({
  sourceColumn: z.string(),
  canonicalField: z.string(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().optional(),
});

export type ColumnMapping = z.infer<typeof ColumnMappingSchema>;

// Schema for inferred schema
export const InferredSchemaSchema = z.object({
  mappings: z.array(ColumnMappingSchema),
  unmappedColumns: z.array(z.string()),
  detectedDelimiter: z.string(),
  hasHeader: z.boolean(),
  encoding: z.string(),
  totalRows: z.number(),
});

export type InferredSchema = z.infer<typeof InferredSchemaSchema>;

// Schema for validation issue
export const ValidationIssueSchema = z.object({
  field: z.string(),
  originalValue: z.string().nullable(),
  issueType: z.enum(['MISSING', 'INVALID', 'SUSPICIOUS', 'FORMAT_ERROR']),
  severity: z.enum(['ERROR', 'WARNING', 'INFO']),
  message: z.string(),
  suggestedValue: z.string().optional(),
});

export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

// Schema for enrichment source
export const EnrichmentSourceSchema = z.object({
  url: z.string(),
  type: z.enum(['OFFICIAL_WEBSITE', 'BUSINESS_REGISTRY', 'PUBLIC_DATABASE', 'SEARCH_RESULT', 'LLM_KNOWLEDGE']),
  retrievedAt: z.string(),
  snippet: z.string().optional(),
});

export type EnrichmentSource = z.infer<typeof EnrichmentSourceSchema>;

// Schema for field change
export const FieldChangeSchema = z.object({
  field: z.string(),
  originalValue: z.string().nullable(),
  proposedValue: z.string(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  sources: z.array(EnrichmentSourceSchema),
  action: z.enum(['ADDED', 'CORRECTED', 'VERIFIED']),
});

export type FieldChange = z.infer<typeof FieldChangeSchema>;

// Schema for processed row
export const ProcessedRowSchema = z.object({
  rowIndex: z.number(),
  originalData: z.record(z.string()),
  canonicalData: z.record(z.string().nullable()),
  validationIssues: z.array(ValidationIssueSchema),
  enrichmentResults: z.array(FieldChangeSchema).optional(),
  entityCandidates: z.array(z.object({
    name: z.string(),
    confidence: z.number(),
    sources: z.array(EnrichmentSourceSchema),
  })).optional(),
  status: z.enum(['PENDING', 'VALIDATED', 'ENRICHED', 'NEEDS_REVIEW', 'ERROR']),
  errorMessage: z.string().optional(),
});

export type ProcessedRow = z.infer<typeof ProcessedRowSchema>;

// Schema for job
export const JobSchema = z.object({
  jobId: z.string(),
  tenantId: z.string(),
  userId: z.string(),
  status: z.enum(['PENDING', 'PARSING', 'INFERRING_SCHEMA', 'VALIDATING', 'ENRICHING', 'GENERATING_OUTPUTS', 'COMPLETED', 'FAILED']),
  fileName: z.string(),
  fileKey: z.string(),
  fileSizeBytes: z.number(),
  totalRows: z.number().optional(),
  processedRows: z.number().optional(),
  enrichmentBatchesTotal: z.number().optional(),
  enrichmentBatchesCompleted: z.number().optional(),
  schema: InferredSchemaSchema.optional(),
  outputCsvKey: z.string().optional(),
  outputReportKey: z.string().optional(),
  summary: z.object({
    totalRows: z.number(),
    validRows: z.number(),
    rowsWithIssues: z.number(),
    rowsEnriched: z.number(),
    fieldsFilled: z.number(),
    fieldsCorrected: z.number(),
    fieldsDiscovered: z.number(),
  }).optional(),
  errorMessage: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
});

export type Job = z.infer<typeof JobSchema>;

// Step Functions input/output types
export interface StepFunctionInput {
  jobId: string;
  tenantId: string;
  userId: string;
  fileKey: string;
  fileName: string;
}

export interface ParseCsvOutput extends StepFunctionInput {
  totalRows: number;
  rawDataKey: string;
  detectedDelimiter: string;
  hasHeader: boolean;
}

export interface InferSchemaOutput extends ParseCsvOutput {
  schema: InferredSchema;
}

export interface ValidateRowsOutput extends InferSchemaOutput {
  rowBatches: number[][];
  validationSummary: {
    totalIssues: number;
    errorCount: number;
    warningCount: number;
  };
}

export interface EnrichRowInput {
  jobId: string;
  tenantId: string;
  schema: InferredSchema;
  batch: number[];
  batchIndex: number;
}

export interface EnrichRowOutput {
  batchIndex: number;
  processedCount: number;
  enrichedCount: number;
  errorCount: number;
}

export interface GenerateOutputsInput extends ValidateRowsOutput {
  enrichmentResults: EnrichRowOutput[];
}

export interface GenerateOutputsOutput extends StepFunctionInput {
  outputCsvKey: string;
  outputReportKey: string;
  summary: Job['summary'];
}

// API types
export interface ApiResponse<T = unknown> {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export interface CreateJobRequest {
  fileKey: string;
  fileName: string;
}

export interface UploadUrlResponse {
  uploadUrl: string;
  fileKey: string;
  expiresIn: number;
}

export interface JobResultsResponse {
  jobId: string;
  status: JobStatusType;
  rows: ProcessedRow[];
  totalRows: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}
