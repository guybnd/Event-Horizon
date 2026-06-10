import { useState } from 'react';
import { AlertTriangle, X, Copy, Check } from 'lucide-react';
import { createPortal } from 'react-dom';
import type { ParseError } from '../api';

interface ParseErrorButtonProps {
  errors: ParseError[];
}

export function ParseErrorButton({ errors }: ParseErrorButtonProps) {
  const [isOpen, setIsOpen] = useState(false);

  if (errors.length === 0) return null;

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="relative flex items-center gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors"
        title="View corrupted ticket files"
      >
        <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400" />
        <span className="text-sm font-medium text-red-700 dark:text-red-300">
          Parse Errors
        </span>
        <span className="flex items-center justify-center min-w-[20px] h-5 px-1.5 text-xs font-semibold rounded-full bg-red-600 dark:bg-red-500 text-white">
          {errors.length}
        </span>
      </button>

      {isOpen && createPortal(
        <ParseErrorModal errors={errors} onClose={() => setIsOpen(false)} />,
        document.body
      )}
    </>
  );
}

interface ParseErrorModalProps {
  errors: ParseError[];
  onClose: () => void;
}

function buildFixInstructions(error: ParseError): string {
  return `# Fix Corrupted Ticket: ${error.id}

## File Path
${error.path}

## Error
${error.error}

## Expected YAML Frontmatter Schema

\`\`\`yaml
---
id: ${error.id}
title: "Ticket title here"          # REQUIRED - non-empty string
status: Todo                         # Valid: Grooming, Todo, In Progress, Require Input, Ready, Done, Released
priority: None                       # Valid: None, Low, Medium, High, Critical
effort: None                         # Valid: None, XS, S, M, L, XL
assignee: unassigned                 # string
tags: []                             # string array
createdBy: Agent                     # string
updatedBy: Agent                     # string
subtasks: []                         # array of ticket ID strings (e.g. ["FLUX-5", "FLUX-6"])
history:                             # array of history entry objects
  - type: status_change              # MUST use "from"/"to", NOT "oldStatus"/"newStatus"
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-26T12:00:00.000Z' # valid ISO 8601 timestamp
  - type: comment
    user: Agent
    date: '2026-05-26T12:00:00.000Z'
    comment: "Comment text here"     # REQUIRED for comment/activity/agent_message types
  - type: activity
    user: Agent
    date: '2026-05-26T12:00:00.000Z'
    comment: "Activity description"
---
\`\`\`

## Common Fixes

- **"status_change requires 'from' (not 'oldStatus')"** → Rename \`oldStatus\` to \`from\` and \`newStatus\` to \`to\`
- **"missing or empty title"** → Add a \`title\` field with a non-empty string value
- **"missing or invalid ISO date"** → Ensure \`date\` is a valid ISO 8601 string like \`'2026-05-26T12:00:00.000Z'\`
- **"missing or empty type"** → Add a \`type\` field (valid: activity, comment, agent_message, status_change, agent_session)
- **"inline subtask object missing id"** → Replace inline objects with string IDs (e.g. \`- FLUX-5\`)

## Instructions

**Note:** Auto-repair was already attempted on this ticket and could not resolve the issue.
Manual intervention is required.

1. Read the file at the path above
2. Identify the YAML frontmatter section (between the \`---\` delimiters)
3. Fix the specific error described above using the schema reference
4. Use the engine API to update: \`PUT /api/tasks/${error.id}\` with corrected fields
5. Or edit the file directly ensuring valid YAML with spaces (not tabs) for indentation
`;
}

function ParseErrorModal({ errors, onClose }: ParseErrorModalProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopyInstructions = async (error: ParseError) => {
    const instructions = buildFixInstructions(error);
    await navigator.clipboard.writeText(instructions);
    setCopiedId(error.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-white dark:bg-zinc-900 rounded-lg shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col m-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-zinc-200 dark:border-zinc-700">
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400" />
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              Corrupted Ticket Files
            </h2>
            <span className="px-2 py-1 text-xs font-semibold rounded-full bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300">
              {errors.length}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            title="Close"
          >
            <X className="h-5 w-5 text-zinc-500 dark:text-zinc-400" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          <div className="space-y-3">
            {errors.map((error) => (
              <div
                key={error.id}
                className="border border-red-200 dark:border-red-800 rounded-lg bg-red-50 dark:bg-red-900/10"
              >
                <button
                  onClick={() => setExpandedId(expandedId === error.id ? null : error.id)}
                  className="w-full flex items-center justify-between p-3 hover:bg-red-100 dark:hover:bg-red-900/20 transition-colors rounded-lg"
                >
                  <div className="flex items-center gap-3">
                    <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400 flex-shrink-0" />
                    <span className="font-mono text-sm font-medium text-red-800 dark:text-red-200">
                      {error.id}.md
                    </span>
                  </div>
                  <svg
                    className={`h-4 w-4 text-red-600 dark:text-red-400 transition-transform ${
                      expandedId === error.id ? 'rotate-180' : ''
                    }`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {expandedId === error.id && (
                  <div className="px-3 pb-3 pt-0">
                    <div className="mt-2 p-3 bg-red-100 dark:bg-red-900/30 rounded border border-red-200 dark:border-red-700">
                      <p className="text-xs font-mono text-red-800 dark:text-red-200 whitespace-pre-wrap break-words">
                        {error.error}
                      </p>
                    </div>
                    <div className="mt-2 text-xs text-red-700 dark:text-red-300">
                      <strong>File path:</strong>{' '}
                      <code className="font-mono bg-red-200 dark:bg-red-900/40 px-1 py-0.5 rounded">
                        {error.path}
                      </code>
                    </div>
                    <button
                      onClick={() => handleCopyInstructions(error)}
                      className="mt-3 flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md bg-red-600 dark:bg-red-700 text-white hover:bg-red-700 dark:hover:bg-red-600 transition-colors"
                    >
                      {copiedId === error.id ? (
                        <>
                          <Check className="h-3.5 w-3.5" />
                          Copied!
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" />
                          Copy Fix Instructions
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="mt-4 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
            <p className="text-xs text-yellow-800 dark:text-yellow-200">
              <strong>How to fix:</strong> Edit the ticket file's YAML frontmatter to correct the formatting error.
              The error will clear automatically once the file is saved with valid YAML.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
