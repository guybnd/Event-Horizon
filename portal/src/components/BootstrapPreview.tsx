import { useState, useEffect } from 'react';
import { Loader2, CheckCircle, AlertTriangle, FileText, FolderOpen, ListChecks } from 'lucide-react';
import { scanBootstrap, importBootstrap, type BootstrapScanResult, type BootstrapDocItem, type BootstrapTaskItem } from '../api';

interface BootstrapPreviewProps {
  onComplete: () => void;
  onSkip: () => void;
}

export function BootstrapPreview({ onComplete, onSkip }: BootstrapPreviewProps) {
  const [loading, setLoading] = useState(true);
  const [scanResult, setScanResult] = useState<BootstrapScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());
  const [selectedTasks, setSelectedTasks] = useState<Set<number>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ docsImported: number; ticketsCreated: number; ticketsSkipped: number } | null>(null);

  useEffect(() => {
    scanBootstrap()
      .then((result) => {
        setScanResult(result);
        setSelectedDocs(new Set(result.docs.map((d) => d.relativePath)));
        setSelectedTasks(new Set(result.tasks.map((_, i) => i)));
      })
      .catch((err) => setError(err.message || 'Failed to scan workspace'))
      .finally(() => setLoading(false));
  }, []);

  function toggleDoc(path: string) {
    setSelectedDocs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleTask(index: number) {
    setSelectedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  async function handleImport() {
    if (!scanResult) return;
    setImporting(true);
    setError(null);
    try {
      const tasks = scanResult.tasks
        .filter((_, i) => selectedTasks.has(i))
        .map((t) => ({ title: t.title, body: t.body }));
      const result = await importBootstrap({
        selectedDocs: Array.from(selectedDocs),
        selectedTasks: tasks,
      });
      setImportResult(result);
    } catch (err: any) {
      setError(err.message || 'Import failed');
    } finally {
      setImporting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-8 gap-3">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
        <p className="text-sm text-gray-500 dark:text-gray-400">Scanning your project…</p>
      </div>
    );
  }

  if (error && !scanResult) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
        <button
          onClick={onSkip}
          className="flex h-11 items-center justify-center rounded-2xl border border-gray-200 bg-white px-6 text-sm font-medium text-gray-700 shadow-sm transition-all hover:bg-gray-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10"
        >
          Continue
        </button>
      </div>
    );
  }

  if (importResult) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400">
          <CheckCircle className="h-5 w-5 shrink-0" />
          <div>
            <p className="font-medium">Import complete!</p>
            <p className="mt-1 text-xs opacity-80">
              {importResult.docsImported} doc{importResult.docsImported !== 1 ? 's' : ''} imported,{' '}
              {importResult.ticketsCreated} ticket{importResult.ticketsCreated !== 1 ? 's' : ''} created
              {importResult.ticketsSkipped > 0 && `, ${importResult.ticketsSkipped} skipped (duplicates)`}
            </p>
          </div>
        </div>
        <button
          onClick={onComplete}
          className="flex h-11 items-center justify-center rounded-2xl bg-primary px-6 text-sm font-semibold text-white shadow-sm transition-all hover:bg-primary-hover"
        >
          Continue →
        </button>
      </div>
    );
  }

  if (scanResult && scanResult.docs.length === 0 && scanResult.tasks.length === 0) {
    return (
      <div className="flex flex-col gap-4 items-center text-center">
        <div className="rounded-xl border border-gray-200 bg-gray-50 p-6 dark:border-white/10 dark:bg-white/5 w-full">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No importable docs or task files found in your project. You can always add docs and tickets manually later.
          </p>
        </div>
        <button
          onClick={onSkip}
          className="flex h-11 items-center justify-center rounded-2xl border border-gray-200 bg-white px-6 text-sm font-medium text-gray-700 shadow-sm transition-all hover:bg-gray-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10"
        >
          Continue
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Warnings */}
      {scanResult!.warnings.map((w, i) => (
        <div key={i} className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{w}</span>
        </div>
      ))}

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Docs section */}
      {scanResult!.docs.length > 0 && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
              <FolderOpen className="h-4 w-4" />
              Documentation
            </h3>
            <button
              type="button"
              onClick={() => {
                if (selectedDocs.size === scanResult!.docs.length) {
                  setSelectedDocs(new Set());
                } else {
                  setSelectedDocs(new Set(scanResult!.docs.map((d) => d.relativePath)));
                }
              }}
              className="text-xs text-primary hover:text-primary-hover transition-colors"
            >
              {selectedDocs.size === scanResult!.docs.length ? 'Deselect All' : 'Select All'}
            </button>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white dark:border-white/10 dark:bg-white/5 divide-y divide-gray-100 dark:divide-white/5 max-h-48 overflow-y-auto">
            {scanResult!.docs.map((doc: BootstrapDocItem) => (
              <label key={doc.relativePath} className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50 dark:hover:bg-white/5">
                <input
                  type="checkbox"
                  checked={selectedDocs.has(doc.relativePath)}
                  onChange={() => toggleDoc(doc.relativePath)}
                  className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                />
                {doc.type === 'folder' ? (
                  <FolderOpen className="h-4 w-4 shrink-0 text-gray-400" />
                ) : (
                  <FileText className="h-4 w-4 shrink-0 text-gray-400" />
                )}
                <span className="flex-1 text-sm text-gray-700 dark:text-gray-300 truncate">{doc.relativePath}</span>
                {doc.type === 'file' && <span className="text-xs text-gray-400">{doc.sizeLines} lines</span>}
                {doc.sizeLines > 500 && (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-500/20 dark:text-amber-400">
                    Large file
                  </span>
                )}
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Tasks section */}
      {scanResult!.tasks.length > 0 && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
              <ListChecks className="h-4 w-4" />
              Tasks to Import
            </h3>
            <button
              type="button"
              onClick={() => {
                if (selectedTasks.size === scanResult!.tasks.length) {
                  setSelectedTasks(new Set());
                } else {
                  setSelectedTasks(new Set(scanResult!.tasks.map((_, i) => i)));
                }
              }}
              className="text-xs text-primary hover:text-primary-hover transition-colors"
            >
              {selectedTasks.size === scanResult!.tasks.length ? 'Deselect All' : 'Select All'}
            </button>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white dark:border-white/10 dark:bg-white/5 divide-y divide-gray-100 dark:divide-white/5 max-h-56 overflow-y-auto">
            {scanResult!.tasks.map((task: BootstrapTaskItem, i: number) => (
              <label key={i} className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50 dark:hover:bg-white/5">
                <input
                  type="checkbox"
                  checked={selectedTasks.has(i)}
                  onChange={() => toggleTask(i)}
                  className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-700 dark:text-gray-300 truncate">{task.title}</p>
                  <p className="text-xs text-gray-400 truncate">{task.sourceFile}:{task.lineNumber}</p>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                  task.extractionMode === 'checklist'
                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400'
                    : 'bg-purple-100 text-purple-700 dark:bg-purple-500/20 dark:text-purple-400'
                }`}>
                  {task.extractionMode}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-col gap-3 pt-2">
        <button
          onClick={handleImport}
          disabled={importing || (selectedDocs.size === 0 && selectedTasks.size === 0)}
          className="flex h-11 items-center justify-center gap-2 rounded-2xl bg-primary px-6 text-sm font-semibold text-white shadow-sm transition-all hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {importing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Importing…
            </>
          ) : (
            `Import Selected (${selectedDocs.size + selectedTasks.size})`
          )}
        </button>
        <button
          onClick={onSkip}
          disabled={importing}
          className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
        >
          Skip
        </button>
      </div>
    </div>
  );
}
