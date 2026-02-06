import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { listJobs, deleteJob, Job } from '../api';
import { 
  FileSpreadsheet, 
  Clock, 
  CheckCircle, 
  AlertTriangle, 
  XCircle,
  Loader2,
  Plus,
  ChevronRight,
  Trash2
} from 'lucide-react';

function getStatusIcon(status: string) {
  switch (status) {
    case 'COMPLETED':
      return <CheckCircle className="h-5 w-5 text-green-500" />;
    case 'FAILED':
      return <XCircle className="h-5 w-5 text-red-500" />;
    case 'PENDING':
      return <Clock className="h-5 w-5 text-gray-400" />;
    default:
      return <Loader2 className="h-5 w-5 text-blue-500 animate-spin" />;
  }
}

function getStatusBadge(status: string) {
  const styles: Record<string, string> = {
    COMPLETED: 'bg-green-100 text-green-800',
    FAILED: 'bg-red-100 text-red-800',
    PENDING: 'bg-gray-100 text-gray-800',
    PARSING: 'bg-blue-100 text-blue-800',
    INFERRING_SCHEMA: 'bg-blue-100 text-blue-800',
    VALIDATING: 'bg-blue-100 text-blue-800',
    ENRICHING: 'bg-blue-100 text-blue-800',
    GENERATING_OUTPUTS: 'bg-blue-100 text-blue-800',
  };

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${styles[status] || 'bg-gray-100 text-gray-800'}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function formatDate(dateString: string) {
  return new Date(dateString).toLocaleString();
}

function JobCard({ job, onDelete }: { job: Job; onDelete: (jobId: string) => void }) {
  const [showConfirm, setShowConfirm] = useState(false);

  const handleDelete = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setShowConfirm(true);
  };

  const confirmDelete = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onDelete(job.jobId);
    setShowConfirm(false);
  };

  const cancelDelete = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setShowConfirm(false);
  };

  return (
    <div className="relative bg-white rounded-lg border border-gray-200 shadow-sm hover:shadow-md transition-shadow">
      <Link to={`/jobs/${job.jobId}`} className="block p-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            {getStatusIcon(job.status)}
            <div>
              <h3 className="text-sm font-medium text-gray-900">{job.fileName}</h3>
              <p className="text-xs text-gray-500">{formatDate(job.createdAt)}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleDelete}
              className="p-1 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
              title="Delete job"
            >
              <Trash2 className="h-4 w-4" />
            </button>
            <ChevronRight className="h-5 w-5 text-gray-400" />
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between">
          {getStatusBadge(job.status)}
          
          {job.summary && (
            <div className="flex items-center gap-4 text-xs text-gray-500">
              <span>{job.summary.totalRows} rows</span>
              {job.summary.rowsWithIssues > 0 && (
                <span className="flex items-center gap-1 text-amber-600">
                  <AlertTriangle className="h-3 w-3" />
                  {job.summary.rowsWithIssues} issues
                </span>
              )}
              {job.summary.rowsEnriched > 0 && (
                <span className="text-green-600">
                  {job.summary.rowsEnriched} enriched
                </span>
              )}
            </div>
          )}
        </div>
      </Link>

      {/* Delete confirmation modal */}
      {showConfirm && (
        <div 
          className="absolute inset-0 bg-white/95 rounded-lg flex flex-col items-center justify-center p-4 z-10"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="text-sm text-gray-700 text-center mb-4">
            Delete <strong>{job.fileName}</strong>?
          </p>
          <div className="flex gap-2">
            <button
              onClick={cancelDelete}
              className="px-3 py-1.5 text-sm text-gray-600 bg-gray-100 hover:bg-gray-200 rounded transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={confirmDelete}
              className="px-3 py-1.5 text-sm text-white bg-red-600 hover:bg-red-700 rounded transition-colors"
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const queryClient = useQueryClient();
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['jobs'],
    queryFn: () => listJobs(),
    refetchInterval: 5000, // Poll every 5 seconds for status updates
  });

  const deleteMutation = useMutation({
    mutationFn: deleteJob,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      setDeleteError(null);
    },
    onError: (err: Error) => {
      setDeleteError(err.message || 'Failed to delete job');
    },
  });

  const handleDelete = (jobId: string) => {
    deleteMutation.mutate(jobId);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-500">View and manage your CSV processing jobs</p>
        </div>
        <Link
          to="/upload"
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Upload CSV
        </Link>
      </div>

      {deleteError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 flex items-center justify-between">
          <span>{deleteError}</span>
          <button onClick={() => setDeleteError(null)} className="text-red-500 hover:text-red-700">
            <XCircle className="h-5 w-5" />
          </button>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 text-blue-600 animate-spin" />
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
          Failed to load jobs. Please try again.
        </div>
      ) : data?.jobs.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
          <FileSpreadsheet className="mx-auto h-12 w-12 text-gray-400" />
          <h3 className="mt-4 text-lg font-medium text-gray-900">No jobs yet</h3>
          <p className="mt-2 text-sm text-gray-500">
            Upload a CSV file to start cleaning and enriching your data.
          </p>
          <Link
            to="/upload"
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
          >
            <Plus className="h-4 w-4" />
            Upload your first CSV
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data?.jobs.map((job) => (
            <JobCard key={job.jobId} job={job} onDelete={handleDelete} />
          ))}
        </div>
      )}
    </div>
  );
}
