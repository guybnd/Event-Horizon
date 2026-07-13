import { useState, useEffect, useRef } from 'react';
import { X, AlertTriangle, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { resetToRemote } from '../api';
import type { ConflictInfo, ResolutionStrategy } from '../api';

interface ConflictResolutionModalProps {
  conflicts: ConflictInfo[];
  onResolve: (resolutions: Array<{ ticketId: string; strategy: ResolutionStrategy; newContent?: string }>) => Promise<void>;
  onClose: () => void;
}

interface TicketData {
  id: string;
  title: string;
  status: string;
  priority: string;
  effort: string;
  assignee: string;
  tags: string[];
  body: string;
}

/**
 * Simple frontmatter parser for display purposes only.
 * Parses basic YAML fields - just enough to show a semantic diff to the user.
 * Does not need to be production-grade since the backend validates with gray-matter.
 */
function parseTicketFrontmatter(content: string): TicketData | null {
  try {
    const fmMatch = content.match(/^---\n([\s\S]+?)\n---\n([\s\S]*)$/);
    if (!fmMatch) return null;

    const yamlLines = fmMatch[1].split('\n');
    const body = fmMatch[2];

    let id = '', title = '', status = '', priority = '', effort = '', assignee = '';
    const tags: string[] = [];
    let inTagsBlock = false;

    for (const line of yamlLines) {
      if (line.startsWith('tags:')) {
        inTagsBlock = true;
        continue;
      }
      if (inTagsBlock) {
        if (line.startsWith('  - ')) {
          tags.push(line.substring(4).trim());
        } else if (!line.startsWith('  ')) {
          inTagsBlock = false;
        }
      }

      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match) {
        const [, key, value] = match;
        if (key === 'id') id = value.trim();
        if (key === 'title') title = value.trim();
        if (key === 'status') status = value.trim();
        if (key === 'priority') priority = value.trim();
        if (key === 'effort') effort = value.trim();
        if (key === 'assignee') assignee = value.trim();
      }
    }

    return { id, title, status, priority, effort, assignee, tags, body: body.trim() };
  } catch {
    return null;
  }
}

function renderFieldDiff(label: string, localValue: string | string[], remoteValue: string | string[]) {
  const localStr = Array.isArray(localValue) ? localValue.join(', ') : localValue;
  const remoteStr = Array.isArray(remoteValue) ? remoteValue.join(', ') : remoteValue;

  if (localStr === remoteStr) return null;

  return (
    <div className="py-1.5 border-b border-gray-200 dark:border-gray-700 last:border-0">
      <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">{label}</div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded px-2 py-1">
          <span className="text-red-700 dark:text-red-300">{localStr || '(empty)'}</span>
        </div>
        <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded px-2 py-1">
          <span className="text-green-700 dark:text-green-300">{remoteStr || '(empty)'}</span>
        </div>
      </div>
    </div>
  );
}

export function ConflictResolutionModal({ conflicts, onResolve, onClose }: ConflictResolutionModalProps) {
  const [resolutions, setResolutions] = useState<Record<string, { strategy: ResolutionStrategy; newContent?: string } | undefined>>(
    Object.fromEntries(conflicts.map(c => [c.ticketId, undefined]))
  );
  const [expandedConflict, setExpandedConflict] = useState<string | null>(conflicts[0]?.ticketId || null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [expandedPreview, setExpandedPreview] = useState<Record<string, boolean>>({});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // FLUX-1232: "discard everything, take remote" escape hatch — confirm-gated, separate from
  // the per-ticket resolution flow above (this bypasses it entirely).
  const [confirmingDiscardAll, setConfirmingDiscardAll] = useState(false);
  const [discardAllInFlight, setDiscardAllInFlight] = useState(false);
  const [discardAllError, setDiscardAllError] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // Save previously focused element and focus modal
    previousActiveElement.current = document.activeElement as HTMLElement;
    closeButtonRef.current?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSubmitting) {
        onClose();
      } else if (e.key === 'Tab') {
        // Focus trap logic
        const modal = modalRef.current;
        if (!modal) return;

        const focusableElements = modal.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (e.shiftKey && document.activeElement === firstElement) {
          e.preventDefault();
          lastElement?.focus();
        } else if (!e.shiftKey && document.activeElement === lastElement) {
          e.preventDefault();
          firstElement?.focus();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      // Restore focus on unmount
      previousActiveElement.current?.focus();
    };
  }, [onClose, isSubmitting]);

  // Derived from the live `conflicts` prop (not from `resolutions`' own keys) so a
  // conflict list that grows or shrinks while the modal stays mounted (SSE push mid-resolve)
  // can't leave a stale/missing key making this look done when it isn't, or vice versa.
  const allResolved = conflicts.every(c => {
    const res = resolutions[c.ticketId];
    return res !== undefined && (res.strategy !== 'manual' || !!res.newContent);
  });

  const handleResolve = async () => {
    if (!allResolved) return;
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const resolutionArray = conflicts.map(c => {
        const res = resolutions[c.ticketId]!;
        return { ticketId: c.ticketId, strategy: res.strategy, newContent: res.newContent };
      });
      await onResolve(resolutionArray);
      onClose();
    } catch (err) {
      console.error('Failed to resolve conflicts:', err);
      const message = err instanceof Error ? err.message : String(err);
      setErrorMessage(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const updateResolution = (ticketId: string, strategy: ResolutionStrategy, newContent?: string) => {
    setResolutions(prev => ({
      ...prev,
      [ticketId]: { strategy, newContent }
    }));
  };

  const handleDiscardAll = async () => {
    setDiscardAllInFlight(true);
    setDiscardAllError(null);
    try {
      await resetToRemote();
      onClose();
    } catch (err) {
      setDiscardAllError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiscardAllInFlight(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        ref={modalRef}
        className="relative bg-white dark:bg-gray-800 rounded-lg shadow-2xl w-full max-w-4xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="conflict-modal-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 sm:h-6 sm:w-6 text-yellow-500" />
            <h2 id="conflict-modal-title" className="text-lg sm:text-xl font-semibold text-gray-900 dark:text-gray-100">
              Sync Conflicts Detected
            </h2>
          </div>
          <button
            ref={closeButtonRef}
            onClick={onClose}
            disabled={isSubmitting}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-50"
            aria-label="Close conflict resolution modal"
          >
            <X className="h-5 w-5 sm:h-6 sm:w-6" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 space-y-4">
          {errorMessage && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
                <p className="text-sm text-red-800 dark:text-red-200">{errorMessage}</p>
              </div>
            </div>
          )}
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Local and remote branches have diverged with conflicting changes to {conflicts.length} ticket{conflicts.length > 1 ? 's' : ''}.
            Choose a resolution strategy for each:
          </p>

          {/* FLUX-1232: escape hatch — bypass per-ticket resolution entirely and match remote. */}
          <div className="rounded-lg border border-orange-200 dark:border-orange-500/30 bg-orange-50 dark:bg-orange-500/10 p-3 space-y-2">
            {discardAllError && (
              <p className="text-sm text-red-600 dark:text-red-400 break-words">{discardAllError}</p>
            )}
            {!confirmingDiscardAll ? (
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-orange-800 dark:text-orange-200">
                  Too many conflicts to resolve one at a time? Discard all local changes and match remote instead.
                </p>
                <button
                  type="button"
                  onClick={() => setConfirmingDiscardAll(true)}
                  disabled={isSubmitting}
                  className="shrink-0 whitespace-nowrap rounded-md bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-orange-700 disabled:opacity-50"
                >
                  Discard all local & take remote…
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs font-medium text-orange-900 dark:text-orange-100">
                  This discards ALL local board changes not yet pushed and replaces the entire board with
                  the remote's version. A backup ref is kept, but this cannot be undone from the portal.
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleDiscardAll()}
                    disabled={discardAllInFlight}
                    className="flex items-center gap-2 rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-60"
                  >
                    {discardAllInFlight ? (<><Loader2 className="h-3.5 w-3.5 animate-spin" />Resetting…</>) : 'Yes, discard everything'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingDiscardAll(false)}
                    disabled={discardAllInFlight}
                    className="rounded-md bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600 disabled:opacity-60"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          {conflicts.map((conflict) => {
            const isExpanded = expandedConflict === conflict.ticketId;
            const currentResolution = resolutions[conflict.ticketId];
            const isPreviewExpanded = expandedPreview[conflict.ticketId];

            const localData = parseTicketFrontmatter(conflict.localContent);
            const remoteData = parseTicketFrontmatter(conflict.remoteContent);

            const strategyLabels: Record<string, string> = {
              'use-remote': 'Use Remote',
              'use-local': 'Use Local',
              'rename-local': 'Rename Local',
              'manual': 'Manual Merge',
            };

            return (
              <div key={conflict.ticketId} className="border border-gray-300 dark:border-gray-600 rounded-lg overflow-hidden">
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 sm:px-4 py-3 bg-gray-50 dark:bg-gray-700 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors"
                  onClick={() => setExpandedConflict(isExpanded ? null : conflict.ticketId)}
                  aria-expanded={isExpanded}
                  aria-controls={`conflict-${conflict.ticketId}`}
                >
                  <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                    <span className="font-mono text-xs sm:text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                      {conflict.ticketId}
                    </span>
                    <span className={`text-xs px-2 py-1 rounded whitespace-nowrap ${currentResolution ? 'bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200' : 'bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-200'}`}>
                      {currentResolution ? strategyLabels[currentResolution.strategy] : 'Choose a strategy'}
                    </span>
                  </div>
                  {isExpanded ? <ChevronUp className="h-5 w-5 shrink-0" /> : <ChevronDown className="h-5 w-5 shrink-0" />}
                </button>

                {isExpanded && (
                  <div id={`conflict-${conflict.ticketId}`} className="p-3 sm:p-4 space-y-4">
                    {/* Resolution options */}
                    <div className="space-y-2">
                      <label className="flex items-start gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name={`resolution-${conflict.ticketId}`}
                          checked={currentResolution?.strategy === 'use-local'}
                          onChange={() => updateResolution(conflict.ticketId, 'use-local')}
                          className="mt-1"
                        />
                        <div>
                          <div className="font-medium text-sm text-gray-900 dark:text-gray-100">Use local version</div>
                          <div className="text-xs text-gray-500 dark:text-gray-400">Keep your changes and overwrite the remote version</div>
                        </div>
                      </label>

                      <label className="flex items-start gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name={`resolution-${conflict.ticketId}`}
                          checked={currentResolution?.strategy === 'use-remote'}
                          onChange={() => updateResolution(conflict.ticketId, 'use-remote')}
                          className="mt-1"
                        />
                        <div>
                          <div className="font-medium text-sm text-gray-900 dark:text-gray-100">Use remote version</div>
                          <div className="text-xs text-gray-500 dark:text-gray-400">Discard local changes and accept the remote version</div>
                        </div>
                      </label>

                      <label className="flex items-start gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name={`resolution-${conflict.ticketId}`}
                          checked={currentResolution?.strategy === 'rename-local'}
                          onChange={() => updateResolution(conflict.ticketId, 'rename-local')}
                          className="mt-1"
                        />
                        <div>
                          <div className="font-medium text-sm text-gray-900 dark:text-gray-100">Rename local version</div>
                          <div className="text-xs text-gray-500 dark:text-gray-400">Keep local changes with a new ticket ID and accept remote version at original ID</div>
                        </div>
                      </label>

                      <label className="flex items-start gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name={`resolution-${conflict.ticketId}`}
                          checked={currentResolution?.strategy === 'manual'}
                          onChange={() => {
                            // Don't bias - start with empty textarea so user must choose
                            updateResolution(conflict.ticketId, 'manual', '');
                          }}
                          className="mt-1"
                        />
                        <div>
                          <div className="font-medium text-sm text-gray-900 dark:text-gray-100">Manual merge</div>
                          <div className="text-xs text-gray-500 dark:text-gray-400">Edit and merge the content manually</div>
                        </div>
                      </label>

                      {currentResolution?.strategy === 'manual' && (
                        <div className="mt-3 space-y-2">
                          <label className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                            Merged Content
                          </label>
                          <textarea
                            className="w-full h-64 text-xs font-mono bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded p-2 resize-y"
                            value={currentResolution.newContent || ''}
                            onChange={(e) => updateResolution(conflict.ticketId, 'manual', e.target.value)}
                          />
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => updateResolution(conflict.ticketId, 'manual', conflict.localContent)}
                              className="text-xs px-2 py-1 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded"
                            >
                              Use Local
                            </button>
                            <button
                              type="button"
                              onClick={() => updateResolution(conflict.ticketId, 'manual', conflict.remoteContent)}
                              className="text-xs px-2 py-1 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded"
                            >
                              Use Remote
                            </button>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Preview */}
                    <div className="mt-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                          Conflicting Fields <span className="text-gray-500">(local → remote)</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setExpandedPreview(prev => ({ ...prev, [conflict.ticketId]: !isPreviewExpanded }))}
                          className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          {isPreviewExpanded ? 'Show full content' : 'Show semantic diff'}
                        </button>
                      </div>

                      {isPreviewExpanded ? (
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div>
                            <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">Local Version</div>
                            <pre className="text-xs bg-gray-100 dark:bg-gray-900 p-2 sm:p-3 rounded border border-gray-300 dark:border-gray-600 overflow-auto max-h-60 whitespace-pre-wrap break-words">
                              {conflict.localContent}
                            </pre>
                          </div>
                          <div>
                            <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">Remote Version</div>
                            <pre className="text-xs bg-gray-100 dark:bg-gray-900 p-2 sm:p-3 rounded border border-gray-300 dark:border-gray-600 overflow-auto max-h-60 whitespace-pre-wrap break-words">
                              {conflict.remoteContent}
                            </pre>
                          </div>
                        </div>
                      ) : localData && remoteData ? (
                        <div className="bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded p-3 space-y-0">
                          {renderFieldDiff('Title', localData.title, remoteData.title)}
                          {renderFieldDiff('Status', localData.status, remoteData.status)}
                          {renderFieldDiff('Priority', localData.priority, remoteData.priority)}
                          {renderFieldDiff('Effort', localData.effort, remoteData.effort)}
                          {renderFieldDiff('Assignee', localData.assignee, remoteData.assignee)}
                          {renderFieldDiff('Tags', localData.tags, remoteData.tags)}
                          {localData.body !== remoteData.body && (
                            <div className="py-1.5">
                              <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Body</div>
                              <div className="text-xs text-gray-700 dark:text-gray-300">
                                Content differs ({localData.body.length} → {remoteData.body.length} chars)
                              </div>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="text-xs text-gray-500 dark:text-gray-400 italic">Unable to parse ticket data</div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-end gap-2 sm:gap-3 px-4 sm:px-6 py-4 border-t border-gray-200 dark:border-gray-700">
          {!allResolved && (
            <p className="text-xs text-gray-500 dark:text-gray-400 sm:mr-auto">
              Resolve every conflict to continue — manual merges need non-empty content.
            </p>
          )}
          <button
            onClick={onClose}
            disabled={isSubmitting}
            className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleResolve}
            disabled={isSubmitting || !allResolved}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-50 flex items-center justify-center gap-2 transition-colors"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Resolving...</span>
              </>
            ) : (
              'Resolve Conflicts'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
