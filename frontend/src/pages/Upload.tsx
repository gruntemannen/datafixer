import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getUploadUrl, uploadFile, createJob, previewColumns } from '../api';
import type { ColumnPreview } from '../api';
import { Upload as UploadIcon, FileSpreadsheet, AlertCircle, CheckCircle, Loader2, Columns, Eye, EyeOff } from 'lucide-react';

type UploadStep = 'select' | 'uploading' | 'columns' | 'processing' | 'done' | 'error';

export default function Upload() {
  const [file, setFile] = useState<File | null>(null);
  const [step, setStep] = useState<UploadStep>('select');
  const [error, setError] = useState('');
  const [_jobId, setJobId] = useState('');
  const [progress, setProgress] = useState(0);
  const [fileKey, setFileKey] = useState('');
  const [jobIdRef, setJobIdRef] = useState('');
  const [columnPreview, setColumnPreview] = useState<ColumnPreview | null>(null);
  const [excludedColumns, setExcludedColumns] = useState<Set<string>>(new Set());
  const navigate = useNavigate();

  const handleFileSelect = useCallback((selectedFile: File) => {
    if (!selectedFile.name.toLowerCase().endsWith('.csv')) {
      setError('Please select a CSV file');
      return;
    }
    if (selectedFile.size > 50 * 1024 * 1024) {
      setError('File size must be less than 50MB');
      return;
    }
    setFile(selectedFile);
    setError('');
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile) {
      handleFileSelect(droppedFile);
    }
  }, [handleFileSelect]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleUpload = async () => {
    if (!file) return;

    try {
      setStep('uploading');
      setProgress(0);

      // Get pre-signed URL
      const { uploadUrl, fileKey: key, jobId: newJobId } = await getUploadUrl(file.name);
      setFileKey(key);
      setJobIdRef(newJobId);
      setProgress(25);

      // Upload file to S3
      await uploadFile(uploadUrl, file);
      setProgress(50);

      // Preview columns
      const preview = await previewColumns(key);
      setColumnPreview(preview);
      setExcludedColumns(new Set());
      setProgress(75);

      // Show column selection
      setStep('columns');
    } catch (err) {
      setStep('error');
      setError(err instanceof Error ? err.message : 'Upload failed');
    }
  };

  const toggleColumn = (column: string) => {
    setExcludedColumns(prev => {
      const next = new Set(prev);
      if (next.has(column)) {
        next.delete(column);
      } else {
        next.add(column);
      }
      return next;
    });
  };

  const toggleAllColumns = () => {
    if (!columnPreview) return;
    if (excludedColumns.size === 0) {
      // Exclude all — but that makes no sense, so do nothing
      return;
    }
    // Include all
    setExcludedColumns(new Set());
  };

  const handleStartProcessing = async () => {
    try {
      setStep('processing');
      setProgress(85);

      // Create processing job with excluded columns
      await createJob(
        fileKey,
        file!.name,
        excludedColumns.size > 0 ? [...excludedColumns] : undefined
      );
      setProgress(95);

      setJobId(jobIdRef);
      setStep('done');
      setProgress(100);

      // Navigate to job details after a short delay
      setTimeout(() => {
        navigate(`/jobs/${jobIdRef}`);
      }, 1500);
    } catch (err) {
      setStep('error');
      setError(err instanceof Error ? err.message : 'Failed to start processing');
    }
  };

  const reset = () => {
    setFile(null);
    setStep('select');
    setError('');
    setProgress(0);
    setColumnPreview(null);
    setExcludedColumns(new Set());
    setFileKey('');
    setJobIdRef('');
  };

  const includedCount = columnPreview
    ? columnPreview.headers.length - excludedColumns.size
    : 0;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Upload CSV</h1>
        <p className="text-sm text-gray-500">Upload a CSV file to clean and enrich your data</p>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6">
        {step === 'select' && (
          <>
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-blue-400 transition-colors cursor-pointer"
              onClick={() => document.getElementById('file-input')?.click()}
            >
              <input
                id="file-input"
                type="file"
                accept=".csv"
                onChange={(e) => e.target.files?.[0] && handleFileSelect(e.target.files[0])}
                className="hidden"
              />
              <UploadIcon className="mx-auto h-12 w-12 text-gray-400" />
              <p className="mt-4 text-sm text-gray-600">
                <span className="font-medium text-blue-600">Click to upload</span> or drag and drop
              </p>
              <p className="mt-1 text-xs text-gray-500">CSV files up to 50MB</p>
            </div>

            {error && (
              <div className="mt-4 flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
                {error}
              </div>
            )}

            {file && (
              <div className="mt-4 p-4 bg-gray-50 rounded-lg">
                <div className="flex items-center gap-3">
                  <FileSpreadsheet className="h-8 w-8 text-blue-600" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{file.name}</p>
                    <p className="text-xs text-gray-500">
                      {(file.size / 1024 / 1024).toFixed(2)} MB
                    </p>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setFile(null);
                    }}
                    className="text-sm text-gray-500 hover:text-gray-700"
                  >
                    Remove
                  </button>
                </div>
              </div>
            )}

            <div className="mt-6">
              <button
                onClick={handleUpload}
                disabled={!file}
                className="w-full py-2 px-4 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Upload &amp; Preview Columns
              </button>
            </div>
          </>
        )}

        {step === 'uploading' && (
          <div className="text-center py-8">
            <Loader2 className="mx-auto h-12 w-12 text-blue-600 animate-spin" />
            <p className="mt-4 text-lg font-medium text-gray-900">
              Uploading and analyzing file...
            </p>
            <p className="mt-2 text-sm text-gray-500">
              Please wait while we read your CSV columns
            </p>
            <div className="mt-6 w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}

        {step === 'columns' && columnPreview && (
          <div className="space-y-5">
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Columns className="h-5 w-5 text-blue-600" />
                <h2 className="text-lg font-semibold text-gray-900">Select Columns</h2>
              </div>
              <div className="text-sm text-gray-500">
                {includedCount} of {columnPreview.headers.length} columns selected
                {columnPreview.totalRows > 0 && (
                  <span className="ml-2 text-gray-400">
                    &middot; ~{columnPreview.totalRows.toLocaleString()} rows
                  </span>
                )}
              </div>
            </div>

            <p className="text-sm text-gray-600">
              Deselect any columns you want to exclude from processing. Excluded columns will not be validated, enriched, or included in the output.
            </p>

            {/* Column selection with sample data */}
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              {/* Table header */}
              <div className="bg-gray-50 border-b border-gray-200 px-4 py-2 flex items-center justify-between">
                <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  Column name
                </span>
                <button
                  onClick={toggleAllColumns}
                  className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                >
                  {excludedColumns.size === 0 ? 'All selected' : 'Select all'}
                </button>
              </div>

              {/* Column rows */}
              <div className="divide-y divide-gray-100 max-h-96 overflow-y-auto">
                {columnPreview.headers.map((header) => {
                  const isExcluded = excludedColumns.has(header);
                  const sampleValues = columnPreview.sampleRows
                    .map(row => row[header])
                    .filter(v => v && v.trim());

                  return (
                    <button
                      key={header}
                      onClick={() => toggleColumn(header)}
                      className={`w-full px-4 py-3 flex items-center gap-3 text-left transition-colors ${
                        isExcluded
                          ? 'bg-gray-50 opacity-60 hover:opacity-80'
                          : 'bg-white hover:bg-blue-50'
                      }`}
                    >
                      {/* Toggle icon */}
                      <div className={`flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                        isExcluded
                          ? 'border-gray-300 bg-white'
                          : 'border-blue-600 bg-blue-600'
                      }`}>
                        {!isExcluded && (
                          <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 12 12">
                            <path d="M10.28 2.28L3.989 8.575 1.695 6.28A1 1 0 00.28 7.695l3 3a1 1 0 001.414 0l7-7A1 1 0 0010.28 2.28z" />
                          </svg>
                        )}
                      </div>

                      {/* Column info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          {isExcluded ? (
                            <EyeOff className="h-3.5 w-3.5 text-gray-400" />
                          ) : (
                            <Eye className="h-3.5 w-3.5 text-blue-600" />
                          )}
                          <span className={`text-sm font-medium ${
                            isExcluded ? 'text-gray-400 line-through' : 'text-gray-900'
                          }`}>
                            {header}
                          </span>
                        </div>
                        {sampleValues.length > 0 && (
                          <p className="mt-0.5 text-xs text-gray-400 truncate">
                            e.g. {sampleValues.slice(0, 2).join(', ')}
                          </p>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-3">
              <button
                onClick={reset}
                className="flex-1 py-2 px-4 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
              >
                Back
              </button>
              <button
                onClick={handleStartProcessing}
                disabled={includedCount === 0}
                className="flex-1 py-2 px-4 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Process {includedCount} Column{includedCount !== 1 ? 's' : ''}
              </button>
            </div>
          </div>
        )}

        {step === 'processing' && (
          <div className="text-center py-8">
            <Loader2 className="mx-auto h-12 w-12 text-blue-600 animate-spin" />
            <p className="mt-4 text-lg font-medium text-gray-900">Starting job...</p>
            <p className="mt-2 text-sm text-gray-500">
              Please wait while we begin processing your file
            </p>
            <div className="mt-6 w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}

        {step === 'done' && (
          <div className="text-center py-8">
            <CheckCircle className="mx-auto h-12 w-12 text-green-500" />
            <p className="mt-4 text-lg font-medium text-gray-900">Upload complete!</p>
            <p className="mt-2 text-sm text-gray-500">
              Redirecting to job details...
            </p>
          </div>
        )}

        {step === 'error' && (
          <div className="text-center py-8">
            <AlertCircle className="mx-auto h-12 w-12 text-red-500" />
            <p className="mt-4 text-lg font-medium text-gray-900">Upload failed</p>
            <p className="mt-2 text-sm text-red-600">{error}</p>
            <button
              onClick={reset}
              className="mt-6 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
            >
              Try again
            </button>
          </div>
        )}
      </div>

      {step === 'select' && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <h3 className="text-sm font-medium text-blue-800">What happens next?</h3>
          <ul className="mt-2 text-sm text-blue-700 space-y-1">
            <li>1. Upload your file and choose which columns to include</li>
            <li>2. We'll detect the CSV structure and map columns to standard fields</li>
            <li>3. Each row will be validated for formatting and completeness</li>
            <li>4. Missing or incorrect data will be enriched using public sources</li>
            <li>5. You'll get a cleaned CSV and detailed report of all changes</li>
          </ul>
        </div>
      )}
    </div>
  );
}
