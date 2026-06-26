interface ReleaseNotesSectionProps {
  generateDistinctFiles: boolean;
  setGenerateDistinctFiles: (v: boolean) => void;
  releaseNotesPath: string;
  setReleaseNotesPath: (v: string) => void;
}

export function ReleaseNotesSection({
  generateDistinctFiles,
  setGenerateDistinctFiles,
  releaseNotesPath,
  setReleaseNotesPath,
}: ReleaseNotesSectionProps) {
  return (
    <div>
      <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Release Notes</h3>
      <p className="text-xs text-gray-500 mb-4 text-balance">Configure how release notes are generated when releasing Done tickets.</p>
      <div className="space-y-4 max-w-lg">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-bold text-gray-700 dark:text-gray-300">Release Notes Output</label>
          <div className="flex items-center gap-4 rounded-xl border border-gray-200 bg-white p-1 dark:border-white/10 dark:bg-black/20 w-fit">
            <button
              type="button"
              onClick={() => setGenerateDistinctFiles(true)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${generateDistinctFiles ? 'bg-primary text-white shadow-sm' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/5'}`}
            >
              Distinct file per version
            </button>
            <button
              type="button"
              onClick={() => setGenerateDistinctFiles(false)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${!generateDistinctFiles ? 'bg-primary text-white shadow-sm' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/5'}`}
            >
              Append to single file
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-bold text-gray-700 dark:text-gray-300">Release Notes Sub-Folder / File Path</label>
          <input
            value={releaseNotesPath}
            onChange={e => setReleaseNotesPath(e.target.value)}
            className="w-full bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 outline-none focus:border-primary text-sm"
            placeholder="e.g. release-notes"
          />
          <p className="text-[11px] text-gray-500">
            {generateDistinctFiles
              ? `Will generate distinct files under .docs/${releaseNotesPath}/{version}.md`
              : `Will append to the single file .docs/${releaseNotesPath}/release_notes.md`}
          </p>
        </div>
      </div>
    </div>
  );
}
