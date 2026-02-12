import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getJobStatus, getJobResults, getDownloadUrl, ProcessedRow, FieldChange, ValidationIssue } from '../api';
import {
  ArrowLeft,
  Download,
  FileText,
  Loader2,
  CheckCircle,
  XCircle,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Filter,
} from 'lucide-react';

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    COMPLETED: 'bg-green-100 text-green-800',
    FAILED: 'bg-red-100 text-red-800',
    PENDING: 'bg-gray-100 text-gray-800',
    NEEDS_REVIEW: 'bg-amber-100 text-amber-800',
    VALIDATED: 'bg-blue-100 text-blue-800',
    ENRICHED: 'bg-green-100 text-green-800',
    ERROR: 'bg-red-100 text-red-800',
  };

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${styles[status] || 'bg-gray-100 text-gray-800'}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const styles: Record<string, string> = {
    ERROR: 'bg-red-100 text-red-800',
    WARNING: 'bg-amber-100 text-amber-800',
    INFO: 'bg-blue-100 text-blue-800',
  };

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${styles[severity] || 'bg-gray-100 text-gray-800'}`}>
      {severity}
    </span>
  );
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  let style = 'bg-red-100 text-red-800';
  if (confidence >= 0.9) style = 'bg-green-100 text-green-800';
  else if (confidence >= 0.7) style = 'bg-blue-100 text-blue-800';
  else if (confidence >= 0.5) style = 'bg-amber-100 text-amber-800';

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${style}`}>
      {Math.round(confidence * 100)}%
    </span>
  );
}

function IssueItem({ issue }: { issue: ValidationIssue }) {
  return (
    <div className="text-sm border-l-2 border-amber-400 pl-3 py-1">
      <div className="flex items-center gap-2">
        <span className="font-medium text-gray-900">{issue.field}</span>
        <SeverityBadge severity={issue.severity} />
      </div>
      <p className="text-gray-600">{issue.message}</p>
      {issue.originalValue && (
        <p className="text-xs text-gray-500">Original: {issue.originalValue}</p>
      )}
      {issue.suggestedValue && (
        <p className="text-xs text-green-600">Suggested: {issue.suggestedValue}</p>
      )}
    </div>
  );
}

function EnrichmentItem({ change }: { change: FieldChange }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="text-sm border-l-2 border-green-400 pl-3 py-1">
      <div className="flex items-center gap-2">
        <span className="font-medium text-gray-900">{change.field}</span>
        <ConfidenceBadge confidence={change.confidence} />
        <span className="text-xs text-gray-500">{change.action}</span>
      </div>
      <div className="flex items-center gap-2 mt-1">
        {change.originalValue && (
          <span className="text-gray-500 line-through">{change.originalValue}</span>
        )}
        <span className="text-green-700">{change.proposedValue}</span>
      </div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="mt-1 text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
      >
        {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        {expanded ? 'Hide details' : 'Show details'}
      </button>
      {expanded && (
        <div className="mt-2 p-2 bg-gray-50 rounded text-xs">
          <p className="text-gray-700">{change.reasoning}</p>
          {change.sources.length > 0 && (
            <div className="mt-2">
              <p className="font-medium text-gray-600">Sources:</p>
              <ul className="mt-1 space-y-1">
                {change.sources.map((source, i) => (
                  <li key={i} className="flex items-center gap-1">
                    <ExternalLink className="h-3 w-3 text-gray-400" />
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline truncate"
                    >
                      {source.url}
                    </a>
                    <span className="text-gray-400">({source.type})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RowCard({ row }: { row: ProcessedRow }) {
  const [expanded, setExpanded] = useState(false);
  const hasIssues = row.validationIssues.length > 0;
  const hasEnrichments = (row.enrichmentResults?.length || 0) > 0;

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full p-4 text-left hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-gray-500">Row {row.rowIndex + 1}</span>
            <StatusBadge status={row.status} />
          </div>
          <div className="flex items-center gap-4">
            {hasIssues && (
              <span className="flex items-center gap-1 text-xs text-amber-600">
                <AlertTriangle className="h-3 w-3" />
                {row.validationIssues.length} issues
              </span>
            )}
            {hasEnrichments && (
              <span className="flex items-center gap-1 text-xs text-green-600">
                <CheckCircle className="h-3 w-3" />
                {row.enrichmentResults?.length} enrichments
              </span>
            )}
            {expanded ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
          </div>
        </div>
        <div className="mt-2 text-sm text-gray-600">
          <span className="font-medium">{row.canonicalData.company_name || 'Unknown Company'}</span>
          {row.canonicalData.country && <span className="ml-2 text-gray-400">({row.canonicalData.country})</span>}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-gray-200 p-4 space-y-4">
          {/* Original Data */}
          <div>
            <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Original Data</h4>
            <div className="grid grid-cols-2 gap-2 text-sm">
              {Object.entries(row.originalData).map(([key, value]) => (
                <div key={key}>
                  <span className="text-gray-500">{key}:</span>{' '}
                  <span className="text-gray-900">{value || '-'}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Canonical Data */}
          <div>
            <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Canonical Data</h4>
            <div className="grid grid-cols-2 gap-2 text-sm">
              {Object.entries(row.canonicalData).map(([key, value]) => (
                <div key={key}>
                  <span className="text-gray-500">{key}:</span>{' '}
                  <span className="text-gray-900">{value || '-'}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Validation Issues */}
          {hasIssues && (
            <div>
              <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Validation Issues</h4>
              <div className="space-y-2">
                {row.validationIssues.map((issue, i) => (
                  <IssueItem key={i} issue={issue} />
                ))}
              </div>
            </div>
          )}

          {/* Enrichments */}
          {hasEnrichments && (
            <div>
              <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Enrichments</h4>
              <div className="space-y-2">
                {row.enrichmentResults?.map((change, i) => (
                  <EnrichmentItem key={i} change={change} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function JobDetails() {
  const { jobId } = useParams<{ jobId: string }>();
  const [filter, setFilter] = useState<string>('');
  const [downloading, setDownloading] = useState<'csv' | 'report' | null>(null);

  const { data: job, isLoading: jobLoading } = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => getJobStatus(jobId!),
    enabled: !!jobId,
    refetchInterval: (query) => {
      // Stop polling when job is complete or failed
      const data = query.state.data;
      if (data?.status === 'COMPLETED' || data?.status === 'FAILED') {
        return false;
      }
      return 3000; // Poll every 3 seconds
    },
  });

  const { data: results, isLoading: resultsLoading } = useQuery({
    queryKey: ['jobResults', jobId, filter],
    queryFn: () => getJobResults(jobId!, { filter: filter || undefined, pageSize: 100 }),
    enabled: !!jobId && job?.status === 'COMPLETED',
  });

  const handleDownload = async (type: 'csv' | 'report') => {
    if (!jobId) return;
    setDownloading(type);
    try {
      const { downloadUrl, fileName } = await getDownloadUrl(jobId, type);
      // Create a temporary link and trigger download
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      console.error('Download failed:', error);
    } finally {
      setDownloading(null);
    }
  };

  if (jobLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 text-blue-600 animate-spin" />
      </div>
    );
  }

  if (!job) {
    return (
      <div className="text-center py-12">
        <XCircle className="mx-auto h-12 w-12 text-red-500" />
        <p className="mt-4 text-lg font-medium text-gray-900">Job not found</p>
        <Link to="/" className="mt-4 text-blue-600 hover:text-blue-700">
          Back to dashboard
        </Link>
      </div>
    );
  }

  const isProcessing = !['COMPLETED', 'FAILED'].includes(job.status);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <Link to="/" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-2">
            <ArrowLeft className="h-4 w-4" />
            Back to dashboard
          </Link>
          <h1 className="text-2xl font-bold text-gray-900">{job.fileName}</h1>
          <div className="flex items-center gap-3 mt-2">
            <StatusBadge status={job.status} />
            <span className="text-sm text-gray-500">
              Created {new Date(job.createdAt).toLocaleString()}
            </span>
          </div>
        </div>

        {job.status === 'COMPLETED' && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleDownload('csv')}
              disabled={downloading === 'csv'}
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {downloading === 'csv' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              Download CSV
            </button>
            <button
              onClick={() => handleDownload('report')}
              disabled={downloading === 'report'}
              className="inline-flex items-center gap-2 px-4 py-2 bg-white text-gray-700 text-sm font-medium rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50 transition-colors"
            >
              {downloading === 'report' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileText className="h-4 w-4" />
              )}
              Download Report
            </button>
          </div>
        )}
      </div>

      {/* Processing Status */}
      {isProcessing && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <Loader2 className="h-8 w-8 text-blue-600 animate-spin flex-shrink-0" />
              <div className="flex-1">
                <p className="font-medium text-blue-900">Processing in progress...</p>
                <p className="text-sm text-blue-700">
                  Stage: {job.status.replace(/_/g, ' ')}
                </p>
              </div>
              {job.status === 'ENRICHING' && job.enrichmentBatchesTotal !== undefined && job.enrichmentBatchesTotal > 0 && (
                <div className="text-right">
                  <p className="text-2xl font-bold text-blue-900">
                    {Math.round(((job.enrichmentBatchesCompleted || 0) / job.enrichmentBatchesTotal) * 100)}%
                  </p>
                  <p className="text-xs text-blue-600">
                    {job.enrichmentBatchesCompleted || 0} / {job.enrichmentBatchesTotal} batches
                  </p>
                </div>
              )}
              {job.status !== 'ENRICHING' && job.processedRows !== undefined && job.totalRows !== undefined && job.totalRows > 0 && (
                <div className="text-right">
                  <p className="text-2xl font-bold text-blue-900">
                    {Math.round((job.processedRows / job.totalRows) * 100)}%
                  </p>
                  <p className="text-xs text-blue-600">
                    {job.processedRows} / {job.totalRows} rows
                  </p>
                </div>
              )}
            </div>
            
            {/* Progress Bar */}
            {job.totalRows !== undefined && job.totalRows > 0 && (
              <div className="space-y-2">
                <div className="w-full bg-blue-200 rounded-full h-3 overflow-hidden">
                  {job.status === 'ENRICHING' && job.enrichmentBatchesTotal ? (
                    // Determinate progress bar for enrichment based on batch completion
                    <div
                      className="bg-gradient-to-r from-blue-500 to-blue-600 h-3 rounded-full transition-all duration-500 ease-out"
                      style={{ width: `${Math.min(100, ((job.enrichmentBatchesCompleted || 0) / job.enrichmentBatchesTotal) * 100)}%` }}
                    />
                  ) : (
                    // Determinate progress bar for other stages
                    <div
                      className="bg-blue-600 h-3 rounded-full transition-all duration-500 ease-out"
                      style={{ width: `${Math.min(100, ((job.processedRows || 0) / job.totalRows) * 100)}%` }}
                    />
                  )}
                </div>
                <div className="flex justify-between text-xs text-blue-600">
                  <span>
                    {job.status === 'PARSING' && 'Parsing CSV file...'}
                    {job.status === 'INFERRING_SCHEMA' && 'Analyzing data structure...'}
                    {job.status === 'VALIDATING' && 'Validating and auto-correcting data...'}
                    {job.status === 'ENRICHING' && `Enriching ${job.totalRows} rows (registries, VAT validation, AI)...`}
                    {(job.status === 'GENERATING_OUTPUT' || job.status === 'GENERATING_OUTPUTS') && 'Generating output files...'}
                    {!['PARSING', 'INFERRING_SCHEMA', 'VALIDATING', 'ENRICHING', 'GENERATING_OUTPUT', 'GENERATING_OUTPUTS'].includes(job.status) && 'Processing...'}
                  </span>
                  <span>
                    {job.status === 'ENRICHING' && job.enrichmentBatchesTotal
                      ? `${job.enrichmentBatchesTotal - (job.enrichmentBatchesCompleted || 0)} batches remaining`
                      : (job.processedRows || 0) < job.totalRows 
                        ? `~${Math.ceil((job.totalRows - (job.processedRows || 0)) * 0.5)}s remaining`
                        : 'Finalizing...'}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Error */}
      {job.status === 'FAILED' && job.errorMessage && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <XCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-red-800">Processing failed</p>
              <p className="text-sm text-red-700 mt-1">{job.errorMessage}</p>
            </div>
          </div>
        </div>
      )}

      {/* Summary */}
      {job.summary && (
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Summary</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <div>
              <p className="text-2xl font-bold text-gray-900">{job.summary.totalRows}</p>
              <p className="text-sm text-gray-500">Total Rows</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-green-600">{job.summary.validRows}</p>
              <p className="text-sm text-gray-500">Valid Rows</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-amber-600">{job.summary.rowsWithIssues}</p>
              <p className="text-sm text-gray-500">Rows with Issues</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-blue-600">{job.summary.rowsEnriched}</p>
              <p className="text-sm text-gray-500">Rows Enriched</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-green-600">{job.summary.fieldsFilled}</p>
              <p className="text-sm text-gray-500">Fields Filled</p>
              <p className="text-xs text-gray-400">Empty values populated in CSV</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-blue-600">{job.summary.fieldsCorrected}</p>
              <p className="text-sm text-gray-500">Fields Corrected</p>
              <p className="text-xs text-gray-400">Existing values improved in CSV</p>
            </div>
          </div>
          {job.summary.fieldsDiscovered > 0 && (
            <p className="mt-3 text-sm text-gray-500">
              + {job.summary.fieldsDiscovered} additional field{job.summary.fieldsDiscovered === 1 ? '' : 's'} discovered for columns not in original file (see report for details)
            </p>
          )}
        </div>
      )}

      {/* Results */}
      {job.status === 'COMPLETED' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">Results</h2>
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-gray-400" />
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">All rows</option>
                <option value="enriched">Enriched</option>
                <option value="validated">Validated</option>
                <option value="needs-review">Needs review</option>
              </select>
            </div>
          </div>

          {resultsLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 text-blue-600 animate-spin" />
            </div>
          ) : results?.rows.length === 0 ? (
            <div className="bg-white rounded-lg border border-gray-200 p-8 text-center">
              <CheckCircle className="mx-auto h-12 w-12 text-green-500" />
              <p className="mt-4 text-gray-600">
                {filter ? 'No rows match this filter' : 'All rows processed successfully'}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {results?.rows.map((row) => (
                <RowCard key={row.rowIndex} row={row} />
              ))}
              {results?.hasMore && (
                <p className="text-center text-sm text-gray-500">
                  Showing first {results.rows.length} of {results.totalRows} rows
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
