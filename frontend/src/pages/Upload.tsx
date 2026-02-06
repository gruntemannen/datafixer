import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getUploadUrl, uploadFile, createJob } from '../api';
import { Upload as UploadIcon, FileSpreadsheet, AlertCircle, CheckCircle, Loader2 } from 'lucide-react';

type UploadStep = 'select' | 'uploading' | 'processing' | 'done' | 'error';

export default function Upload() {
  const [file, setFile] = useState<File | null>(null);
  const [step, setStep] = useState<UploadStep>('select');
  const [error, setError] = useState('');
  const [_jobId, setJobId] = useState('');
  const [progress, setProgress] = useState(0);
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
      const { uploadUrl, fileKey, jobId: newJobId } = await getUploadUrl(file.name);
      setProgress(25);

      // Upload file to S3
      await uploadFile(uploadUrl, file);
      setProgress(50);

      // Create processing job
      setStep('processing');
      await createJob(fileKey, file.name);
      setProgress(75);

      setJobId(newJobId);
      setStep('done');
      setProgress(100);

      // Navigate to job details after a short delay
      setTimeout(() => {
        navigate(`/jobs/${newJobId}`);
      }, 1500);
    } catch (err) {
      setStep('error');
      setError(err instanceof Error ? err.message : 'Upload failed');
    }
  };

  const reset = () => {
    setFile(null);
    setStep('select');
    setError('');
    setProgress(0);
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
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
                Start Processing
              </button>
            </div>
          </>
        )}

        {(step === 'uploading' || step === 'processing') && (
          <div className="text-center py-8">
            <Loader2 className="mx-auto h-12 w-12 text-blue-600 animate-spin" />
            <p className="mt-4 text-lg font-medium text-gray-900">
              {step === 'uploading' ? 'Uploading file...' : 'Starting job...'}
            </p>
            <p className="mt-2 text-sm text-gray-500">
              Please wait while we process your file
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

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h3 className="text-sm font-medium text-blue-800">What happens next?</h3>
        <ul className="mt-2 text-sm text-blue-700 space-y-1">
          <li>1. We'll detect the CSV structure and map columns to standard fields</li>
          <li>2. Each row will be validated for formatting and completeness</li>
          <li>3. Missing or incorrect data will be enriched using public sources</li>
          <li>4. You'll get a cleaned CSV and detailed report of all changes</li>
        </ul>
      </div>
    </div>
  );
}
