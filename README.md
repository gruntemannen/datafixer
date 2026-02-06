# DataFixer

AI-powered data validation and enrichment service built on AWS.

Upload a CSV with vendor, supplier, or company data and DataFixer will validate, auto-correct, and enrich it using multiple authoritative sources -- company registers, VAT registries, web search, and large language models.

## What it does

- **Validates** data quality: missing fields, invalid formats, suspicious values
- **Auto-corrects** deterministic errors: country codes, URLs, phone numbers, postal codes
- **Enriches** records from company registers, VAT registries, web search, and AI
- **Outputs a cleaned CSV that preserves the original file structure** -- same columns, same order, with corrected and enriched values written back into the corresponding source columns
- **Generates a detailed JSON report** with confidence scores, enrichment sources, and any additional discovered fields that don't map to the original columns

## Enrichment sources

DataFixer runs multiple enrichment sources in parallel and merges results by confidence:

| Source | Coverage | API key required | Data provided |
|--------|----------|------------------|---------------|
| AI (Claude 3.5 Sonnet) | Global | No (via Bedrock) | Brand recognition, geographic corrections, gap filling |
| EU VIES | 27 EU countries | No | VAT validation, registered name and address |
| Norway Brreg | Norway | No | Org number, VAT, address, industry code |
| Denmark CVR | Denmark | No | CVR number, VAT, address, phone, email, industry |
| UK Companies House | United Kingdom | Yes (free) | Company number, registered address, status |
| OpenCorporates | 140+ countries | Yes (free tier) | Company number, jurisdiction, address |
| Tavily web search | Global | Yes (free tier) | Company websites, general business info |
| Cross-row consistency | Within dataset | N/A | Fills gaps from duplicate company rows |

## Automatic corrections

Applied deterministically during validation (no AI cost):

- **Country codes** -- 20+ common mistakes fixed automatically (SZ to CH, UK to GB, GER to DE, etc.)
- **Postal codes** -- cross-validated against 25+ country-specific formats
- **Website URLs** -- protocol added, formatting normalised
- **Phone numbers** -- normalised to international format using country dial codes
- **Country names** -- full names resolved to ISO 3166-1 alpha-2 codes

## Output format

### Cleaned CSV

The output CSV is **structurally identical to the input file**. The original column names and order are preserved exactly -- including columns that DataFixer could not map to a canonical field (these are passed through unchanged). Corrected and enriched values are written back into the corresponding source columns.

No synthetic columns are added (no `row_index`, `canonical_*`, `confidence`, or `status` columns).

### JSON report

All enrichment detail lives in the report:

- **Column mappings** -- which source columns mapped to which canonical fields
- **Validation issues** -- per-row, per-field, with severity and suggested values
- **Enrichment results** -- per-row, per-field, with confidence, reasoning, and source URLs
- **Discovered fields** -- enrichments for canonical fields that have no column in the original file (e.g. a VAT ID discovered for a company whose CSV had no VAT column)

Each enrichment result includes a `writtenBackToCsv` flag indicating whether the value was applied to the output CSV or is report-only.

### Summary metrics

| Metric | Meaning |
|--------|---------|
| Fields Filled | Empty values in existing CSV columns that were populated with enriched data |
| Fields Corrected | Existing values in the CSV that were improved or normalised |
| Fields Discovered | Additional data found for canonical fields with no column in the original file (report-only) |

## Architecture

```
                        +------------------+
                        |   React SPA      |
                        |  (CloudFront)    |
                        +--------+---------+
                                 |
                        +--------v---------+
                        |   API Gateway    |
                        |  (HTTP + JWT)    |
                        +--------+---------+
                                 |
                  +--------------+--------------+
                  |                             |
         +--------v--------+          +--------v--------+
         | API Lambdas     |          | Step Functions   |
         | (CRUD + Auth)   |          | (Processing)     |
         +-----------------+          +--------+--------+
                                               |
                +----------+----------+--------+--------+
                |          |          |        |        |
            +---v--+  +---v---+  +---v----+ +-v-----+ +v--------+
            |Parse |  |Infer  |  |Validate| |Enrich | |Generate |
            |CSV   |  |Schema |  |Rows    | |Row    | |Outputs  |
            +------+  +-------+  +--------+ +---+---+ +---------+
                                                 |
                          +----------+-----------+----------+
                          |          |           |          |
                     +----v---+ +----v----+ +----v---+ +---v------+
                     |Bedrock | |VIES/CVR | |Brreg/  | |Web Search|
                     |Claude  | |Registry | |CompHse | |(Tavily)  |
                     +--------+ +---------+ +--------+ +----------+
```

**Storage**: S3 (files) + DynamoDB (metadata and row data) + KMS (encryption at rest)

## Tech stack

- **Frontend**: React 18, TypeScript, Tailwind CSS, TanStack Query
- **Backend**: Node.js 20, TypeScript, AWS Lambda
- **AI**: Amazon Bedrock (Claude 3.5 Sonnet via EU inference profile)
- **Infrastructure**: AWS CDK, Step Functions, API Gateway, DynamoDB, S3, CloudFront, Cognito

## Prerequisites

- Node.js 18 or later
- AWS CLI configured with credentials
- AWS CDK CLI (`npm install -g aws-cdk`)
- An AWS account with Bedrock model access enabled for Claude 3.5 Sonnet

## Getting started

### 1. Install dependencies

```bash
npm install
cd backend && npm install && cd ..
cd frontend && npm install && cd ..
cd infra && npm install && cd ..
```

### 2. Configure an AWS CLI profile

If you're deploying to a dedicated sub-account:

```bash
# Option A: create a new sub-account (requires AWS Organizations)
./scripts/create-subaccount.sh datafixer your+datafixer@example.com

# Option B: configure an existing profile manually
aws configure --profile datafixer-deploy
```

### 3. Enable Bedrock models

Open the [Amazon Bedrock console](https://console.aws.amazon.com/bedrock/) in your target region and request access to **Claude 3.5 Sonnet**.

### 4. Bootstrap CDK (first time only)

```bash
cd infra
npx cdk bootstrap --profile datafixer-deploy
```

### 5. Build and deploy

```bash
# Deploy all stacks (automatically builds the frontend first)
npm run deploy:subaccount
```

The deploy command rebuilds the frontend before running `cdk deploy`, so you never deploy stale assets. The CloudFront URL is printed in the stack outputs after deployment.

### 6. (Optional) Add API keys for extra enrichment

Set these in `infra/cdk.json` under `context`, then redeploy:

| Key | Source | Registration |
|-----|--------|-------------|
| `searchApiKey` | Tavily web search | https://tavily.com |
| `companiesHouseApiKey` | UK Companies House | https://developer.company-information.service.gov.uk/ |
| `opencorporatesApiKey` | OpenCorporates | https://api.opencorporates.com/ |

Norway Brreg, Denmark CVR, and EU VIES require no API keys and are always active.

## Project structure

```
datafixer/
├── backend/                 # Lambda functions
│   └── src/
│       ├── handlers/        # Lambda handlers
│       │   ├── api/         # REST API endpoints
│       │   ├── parse-csv.ts
│       │   ├── infer-schema.ts
│       │   ├── validate-rows.ts
│       │   ├── enrich-row.ts
│       │   ├── generate-outputs.ts
│       │   └── complete-job.ts
│       ├── types/           # TypeScript types and Zod schemas
│       └── utils/           # Shared utilities
│           ├── bedrock.ts   # AI invocation and deterministic rules
│           ├── dynamodb.ts  # Database operations
│           ├── registries.ts # Company register integrations
│           ├── search.ts    # Web search (Tavily)
│           ├── vies.ts      # EU VAT validation
│           ├── s3.ts        # File storage
│           └── response.ts  # API response helpers
├── frontend/                # React SPA
│   └── src/
│       ├── pages/           # Dashboard, JobDetails, Upload, Login, Register
│       ├── components/      # Layout and shared components
│       └── contexts/        # Auth context (Cognito)
├── infra/                   # AWS CDK infrastructure
│   └── lib/stacks/          # Storage, Auth, Processing, API, Frontend
├── docs/                    # Architecture documentation
├── samples/                 # Sample CSV files for testing
└── scripts/                 # Deployment helper scripts
```

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/upload-url` | Pre-signed URL for CSV upload |
| POST | `/jobs` | Create a processing job |
| GET | `/jobs` | List jobs for the authenticated user |
| GET | `/jobs/{jobId}` | Job status, progress, and summary |
| GET | `/jobs/{jobId}/results` | Processed rows (paginated, filterable) |
| GET | `/jobs/{jobId}/download` | Download URL for enriched CSV or JSON report |
| DELETE | `/jobs/{jobId}` | Delete a job and all associated data |

## Configuration

### CDK context variables (`infra/cdk.json`)

| Key | Default | Description |
|-----|---------|-------------|
| `projectName` | `datafixer` | Resource naming prefix |
| `environment` | `dev` | Environment name |
| `region` | `eu-central-1` | AWS region |
| `searchApiKey` | _(empty)_ | Tavily API key |
| `companiesHouseApiKey` | _(empty)_ | UK Companies House API key |
| `opencorporatesApiKey` | _(empty)_ | OpenCorporates API key |

### Environment variables (set automatically by CDK)

| Variable | Description |
|----------|-------------|
| `DATA_BUCKET` | S3 bucket for file storage |
| `JOBS_TABLE` | DynamoDB jobs table |
| `ROWS_TABLE` | DynamoDB rows table |
| `ENRICHMENT_CACHE_TABLE` | DynamoDB enrichment cache table |
| `SEARCH_API_KEY` | Tavily API key |
| `COMPANIES_HOUSE_API_KEY` | UK Companies House API key |
| `OPENCORPORATES_API_KEY` | OpenCorporates API key |

## Cost estimate

For a typical 1,000-row CSV file:

- **Bedrock** (Claude 3.5 Sonnet): ~$0.50--2.00 depending on data complexity
- **External APIs**: VIES, Brreg, and CVR are free; Companies House and OpenCorporates have free tiers
- **Lambda, DynamoDB, S3, CloudFront**: negligible at low volumes

Enrichment results are cached in DynamoDB for 7 days to avoid repeated API calls.

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m "Add my feature"`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

## License

MIT
