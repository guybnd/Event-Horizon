import { AlertTriangle } from 'lucide-react';
import type { ParseError } from '../api';

interface ParseErrorBannerProps {
  errors: ParseError[];
}

export function ParseErrorBanner({ errors }: ParseErrorBannerProps) {
  if (errors.length === 0) return null;

  return (
    <div className="bg-red-50 dark:bg-red-900/20 border-l-4 border-red-500 p-4 mb-4">
      <div className="flex items-start">
        <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5 mr-3 flex-shrink-0" />
        <div className="flex-1">
          <h3 className="text-sm font-medium text-red-800 dark:text-red-200 mb-2">
            {errors.length === 1 ? 'Corrupted Ticket File' : `${errors.length} Corrupted Ticket Files`}
          </h3>
          <div className="text-sm text-red-700 dark:text-red-300 space-y-2">
            {errors.map((error) => (
              <div key={error.id} className="flex flex-col">
                <div className="font-mono text-xs bg-red-100 dark:bg-red-900/40 px-2 py-1 rounded inline-block mb-1">
                  {error.id}.md
                </div>
                <div className="text-xs opacity-90">
                  {error.error}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 text-xs text-red-600 dark:text-red-400">
            Fix the YAML frontmatter in {errors.length === 1 ? 'this file' : 'these files'} to restore {errors.length === 1 ? 'the ticket' : 'them'} to the board.
          </div>
        </div>
      </div>
    </div>
  );
}
