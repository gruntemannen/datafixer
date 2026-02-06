# Architecture Documentation

## Overview

DataFixer is a serverless AI-powered data validation and enrichment service built on AWS. It processes uploaded CSV files through a multi-stage pipeline that validates, auto-corrects, and enriches business entity data using AWS Bedrock (Claude 3.5 Sonnet).

## AWS Resources Created

### Storage Stack
| Resource | Type | Purpose |
|----------|------|---------|
| DataBucket | S3 Bucket | Stores raw uploads, parsed data, and output files |
| JobsTable | DynamoDB Table | Tracks job metadata and status |
| RowsTable | DynamoDB Table | Stores individual row data and processing results |
| EnrichmentCacheTable | DynamoDB Table | Caches enrichment results for reuse |
| EncryptionKey | KMS Key | Encrypts all data at rest |

### Auth Stack
| Resource | Type | Purpose |
|----------|------|---------|
| UserPool | Cognito User Pool | User authentication and management |
| UserPoolClient | Cognito Client | Web application authentication |
| UserPoolDomain | Cognito Domain | Hosted UI (optional) |

### Processing Stack
| Resource | Type | Purpose |
|----------|------|---------|
| ParseCsvFunction | Lambda | Parses CSV, detects delimiter, extracts rows |
| InferSchemaFunction | Lambda | Uses Bedrock to map columns to canonical fields |
| ValidateRowsFunction | Lambda | Validates data quality using rules + AI, applies auto-corrections |
| EnrichRowFunction | Lambda | Multi-source enrichment: VIES, registries, web search, AI, cross-row |
| GenerateOutputsFunction | Lambda | Creates cleaned CSV and JSON report |
| CompleteJobFunction | Lambda | Marks job as complete, updates metadata |
| ProcessingStateMachine | Step Functions | Orchestrates the processing pipeline |

### API Stack
| Resource | Type | Purpose |
|----------|------|---------|
| HttpApi | API Gateway | REST API for frontend |
| GetUploadUrlFunction | Lambda | Generates pre-signed S3 upload URLs |
| CreateJobFunction | Lambda | Creates jobs and starts processing |
| GetJobStatusFunction | Lambda | Returns job status and progress |
| ListJobsFunction | Lambda | Lists user's jobs |
| GetJobResultsFunction | Lambda | Returns processed row data with filtering |
| GetDownloadUrlFunction | Lambda | Generates pre-signed download URLs |
| DeleteJobFunction | Lambda | Deletes job and all associated data |

### Frontend Stack
| Resource | Type | Purpose |
|----------|------|---------|
| FrontendBucket | S3 Bucket | Hosts static website files |
| Distribution | CloudFront | CDN for frontend delivery |

## Data Flow

```
1. USER uploads CSV
   │
   ▼
2. Frontend gets pre-signed URL from API
   │
   ▼
3. Frontend uploads file directly to S3
   │
   ▼
4. Frontend creates job via API
   │
   ▼
5. API starts Step Functions execution
   │
   ▼
6. Step Functions pipeline:
   │
   ├──▶ ParseCSV Lambda
   │    - Detect delimiter
   │    - Parse rows
   │    - Save to S3 as JSON
   │
   ├──▶ InferSchema Lambda
   │    - Call Bedrock to map columns
   │    - Return canonical field mappings
   │
   ├──▶ ValidateRows Lambda
   │    - Apply deterministic rules (country codes, postal codes, URLs, phones)
   │    - Auto-correct obvious errors (20+ country codes, URL protocols, phone formats)
   │    - Cross-validate postal codes against country formats
   │    - Call Bedrock for AI validation on flagged rows
   │    - Save rows to DynamoDB
   │
   ├──▶ EnrichRows (Map State, 5 concurrent)
   │    - Check enrichment cache
   │    - EU VIES VAT validation (free, no key)
   │    - Company register lookups (Brreg, CVR, Companies House, OpenCorporates)
   │    - Web search via Tavily (optional)
   │    - Cross-row consistency fill
   │    - AI enrichment via Bedrock (Claude 3.5 Sonnet)
   │    - Merge results by confidence, filter no-op changes
   │    - Cache results for 7 days
   │    - Update rows in DynamoDB
   │
   ├──▶ GenerateOutputs Lambda
   │    - Read all rows from DynamoDB
   │    - Retrieve original headers from parsed raw data on S3
   │    - Build reverse mapping (canonical field → source column)
   │    - Generate clean CSV preserving original structure:
   │      · Same columns in same order (including unmapped columns)
   │      · Corrected/enriched values written back into source columns
   │      · Unmapped columns passed through unchanged
   │      · No synthetic columns added
   │    - Generate JSON report with full enrichment detail
   │    - Calculate summary: fieldsFilled, fieldsCorrected, fieldsDiscovered
   │    - Save both to S3
   │
   └──▶ CompleteJob Lambda
        - Update job status
        - Store summary metrics
```

## Database Schema

### Jobs Table
```
Primary Key: pk (TENANT#<tenantId>), sk (JOB#<jobId>)

Attributes:
- jobId: string
- tenantId: string
- userId: string
- status: PENDING|PARSING|INFERRING_SCHEMA|VALIDATING|ENRICHING|GENERATING_OUTPUTS|COMPLETED|FAILED
- fileName: string
- fileKey: string
- fileSizeBytes: number
- totalRows: number
- processedRows: number
- schema: object (inferred schema)
- outputCsvKey: string (clean CSV preserving original file structure)
- outputReportKey: string (JSON report with enrichment detail)
- summary: object
  - totalRows, validRows, rowsWithIssues, rowsEnriched
  - fieldsFilled: empty values in original CSV columns that were populated
  - fieldsCorrected: existing values that were improved
  - fieldsDiscovered: enrichments for fields with no column in original file (report-only)
- errorMessage: string
- createdAt: string (ISO timestamp)
- updatedAt: string (ISO timestamp)
- completedAt: string (ISO timestamp)
- ttl: number (epoch seconds for cleanup)

GSIs:
- status-index: status, createdAt
- user-index: userId, createdAt
```

### Rows Table
```
Primary Key: pk (JOB#<jobId>), sk (ROW#<paddedIndex>)

Attributes:
- rowIndex: number
- jobId: string
- rowStatus: PENDING|VALIDATED|ENRICHED|NEEDS_REVIEW|ERROR
- originalData: object (original field values)
- canonicalData: object (mapped canonical fields)
- validationIssues: array (validation problems found)
- enrichmentResults: array (field changes proposed)
- entityCandidates: array (possible entity matches)
- errorMessage: string
- ttl: number

GSIs:
- status-index: jobId, rowStatus
```

### Enrichment Cache Table
```
Primary Key: pk (ENTITY#<normalizedKey>), sk (SOURCE#<sourceType>)

Attributes:
- normalizedKey: string (normalized company name + country)
- sourceType: string (ENRICHMENT, REGISTRY, WEB)
- data: object (cached enrichment data)
- retrievedAt: string (ISO timestamp)
- ttl: number (7 days from creation)
```

## Output Format

### Clean CSV
The output CSV preserves the original file structure exactly:
- **Same columns** in the same order, including unmapped columns
- **Corrected values** written back into the corresponding source columns via reverse canonical mapping
- **Enriched values** for empty source columns populated from VIES, registries, web search, and AI
- **Unmapped columns** passed through unchanged
- **No synthetic columns** (no row_index, canonical_*, confidence, or status columns)

The output is designed to be a drop-in replacement for the input file.

### JSON Report (v2.0)
The report contains everything not in the CSV:
- `outputFormat` -- original headers, column mappings, unmapped columns, report-only fields
- `summary` -- aggregate counts by type (issues, enrichments, actions)
- `rows[]` -- per-row detail:
  - `originalData` -- original field values
  - `canonicalData` -- mapped canonical field values
  - `validationIssues[]` -- field, sourceColumn, severity, message, suggestedValue
  - `enrichmentResults[]` -- field, sourceColumn, `writtenBackToCsv`, confidence, reasoning, sources

Each enrichment result includes `writtenBackToCsv: true|false` to indicate whether the value was applied to the CSV or is available only in the report (because the original file had no column for that canonical field).

### Backward Compatibility
The API normalizes old job summaries (from before the schema change) that stored `fieldsAdded` to the new `fieldsFilled` / `fieldsDiscovered` fields. This is handled in the `normalizeSummary()` utility used by both `get-job-status` and `list-jobs` API handlers.

## Security Model

### Authentication
- Cognito User Pool with email-based authentication
- JWT tokens with 1-hour validity
- Refresh tokens with 30-day validity
- MFA optional (TOTP)

### Authorization
- API Gateway JWT authorizer validates all requests
- Lambda functions extract userId from JWT claims
- All data queries filter by tenantId/userId

### Data Protection
- KMS customer-managed key for encryption
- S3 bucket encryption at rest
- DynamoDB encryption at rest
- Enforced SSL/TLS for all traffic
- No public S3 buckets
- VPC not required (all serverless with IAM)

### IAM Principles
- Least-privilege policies for all Lambda functions
- Bedrock access restricted to EU regions (eu-* via inference profile)
- S3 access scoped to specific bucket
- DynamoDB access scoped to specific tables

## Cost Considerations

### Per-Request Costs
- API Gateway: ~$1 per million requests
- Lambda: Based on memory and duration
- Bedrock (Claude 3.5 Sonnet via EU inference profile): Intelligent data enrichment
- S3: Storage + requests
- DynamoDB: On-demand pricing

### Optimization Strategies
1. **Batch Bedrock calls**: 10 rows per validation request
2. **Cache enrichments**: 7-day TTL in DynamoDB
3. **Map state concurrency**: Limited to 5 parallel enrichments
4. **S3 lifecycle rules**: Move old data to IA after 90 days
5. **On-demand DynamoDB**: No minimum capacity charges

## Multi-Tenancy Design

Current MVP uses userId as tenantId. For true multi-tenancy:

1. **Data Isolation**: All queries include tenantId in partition key
2. **S3 Paths**: Organized by tenantId (uploads/{tenantId}/...)
3. **Cognito Groups**: Can map to tenant roles
4. **Custom Claims**: tenantId stored in JWT custom attribute

Future enhancements:
- Tenant management API
- Per-tenant quotas and rate limits
- Tenant-specific enrichment connector configs
- Cross-tenant data sharing (opt-in)

## Enrichment Sources

### Active (no API key required)
| Source | File | Description |
|--------|------|-------------|
| EU VIES | `utils/vies.ts` | Validates EU VAT numbers, returns registered name and address |
| Norway Brreg | `utils/registries.ts` | Norwegian company register (Enhetsregisteret) |
| Denmark CVR | `utils/registries.ts` | Danish company register (CVR) |
| AI (Bedrock) | `utils/bedrock.ts` | Claude 3.5 Sonnet for brand recognition and data correction |
| Cross-Row | `handlers/enrich-row.ts` | Fills gaps using other rows for the same company |

### Optional (API key via CDK context)
| Source | File | CDK Context Key | Registration |
|--------|------|-----------------|-------------|
| UK Companies House | `utils/registries.ts` | `companiesHouseApiKey` | https://developer.company-information.service.gov.uk/ |
| OpenCorporates | `utils/registries.ts` | `opencorporatesApiKey` | https://api.opencorporates.com/ |
| Tavily Web Search | `utils/search.ts` | `searchApiKey` | https://tavily.com |

### Adding New Registries
Add new country registries in `backend/src/utils/registries.ts`:
1. Create an async function that calls the registry API
2. Return results as `RegistryResult[]`
3. Add the call to `searchRegistries()` with country routing

## Extensibility Points

### Validation Rules
Located in `backend/src/handlers/validate-rows.ts` and `backend/src/utils/bedrock.ts`:
- Add country code mappings to `COUNTRY_NAME_TO_CODE` and `SUSPICIOUS_COUNTRY_CODES`
- Add postal code patterns to `POSTAL_CODE_PATTERNS`
- Add custom validation functions in `validateRowDeterministic()`

### Schema Mappings
Located in `backend/src/utils/bedrock.ts`:
- Extend `CanonicalFields` array in `types/index.ts`
- Add domain-specific fields
- Customize Bedrock prompts

## Monitoring & Observability

### CloudWatch Logs
- All Lambda functions log to CloudWatch
- Step Functions execution logs enabled
- API Gateway access logs available

### X-Ray Tracing
- Enabled on all Lambda functions
- Traces API → Lambda → DynamoDB/S3/Bedrock

### Metrics
- Step Functions: ExecutionTime, ExecutionsFailed
- Lambda: Duration, Errors, Throttles
- DynamoDB: ReadCapacityUnits, WriteCapacityUnits
- Bedrock: ModelInvocations (via CloudWatch)

### Recommended Alarms
- Lambda error rate > 5%
- Step Functions failure rate > 1%
- API Gateway 5xx errors > 1%
- Lambda duration approaching timeout
