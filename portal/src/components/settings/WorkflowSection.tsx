import type { StatusDef } from '../../types';
import { StatusEditor } from './shared';

interface WorkflowSectionProps {
  columns: StatusDef[];
  setColumns: (items: StatusDef[]) => void;
  hiddenStatuses: StatusDef[];
  setHiddenStatuses: (items: StatusDef[]) => void;
  setRequireInputStatus: (v: string) => void;
  setReadyForMergeStatus: (v: string) => void;
  setArchiveStatus: (v: string) => void;
  statusOptions: string[];
  normalizedRequireInputStatus: string;
  normalizedReadyForMergeStatus: string;
  normalizedArchiveStatus: string;
  isRequireInputStatusMissing: boolean;
  isReadyForMergeStatusMissing: boolean;
  getWorkflowStatusLocation: (statusName: string) => string;
  restoreWorkflowStatusToBoard: (statusName: string) => void;
}

export function WorkflowSection({
  columns,
  setColumns,
  hiddenStatuses,
  setHiddenStatuses,
  setRequireInputStatus,
  setReadyForMergeStatus,
  setArchiveStatus,
  statusOptions,
  normalizedRequireInputStatus,
  normalizedReadyForMergeStatus,
  normalizedArchiveStatus,
  isRequireInputStatusMissing,
  isReadyForMergeStatusMissing,
  getWorkflowStatusLocation,
  restoreWorkflowStatusToBoard,
}: WorkflowSectionProps) {
  return (
    <div>
      <p className="text-xs text-gray-500 mb-6">Manage board columns, hidden statuses, and the special workflow stages used for user prompts and final review. Click any status badge below to pick its color.</p>

      <div className="grid grid-cols-2 gap-10">
        <div>
          <h4 className="text-sm font-bold text-gray-800 dark:text-gray-200 mb-1">Board Columns</h4>
          <p className="text-xs text-gray-500 mb-4">Statuses that appear as lanes on your Kanban board.</p>
          <StatusEditor items={columns} setItems={setColumns} placeholder="Column Status Name" sortable />
        </div>
        <div>
          <h4 className="text-sm font-bold text-gray-800 dark:text-gray-200 mb-1">Hidden Statuses</h4>
          <p className="text-xs text-gray-500 mb-4">Statuses that don't appear as board columns (e.g. Backlog).</p>
          <StatusEditor items={hiddenStatuses} setItems={setHiddenStatuses} placeholder="Hidden Status Name" />
        </div>
        <div className="col-span-2 rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
          <div className="grid grid-cols-2 gap-6">
            <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-white/10 dark:bg-black/20">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h4 className="text-sm font-bold text-gray-800 dark:text-gray-200">User Input Status</h4>
                  <p className="mt-1 text-xs text-gray-500">This replaces the old hardcoded `Require Input` workflow stage.</p>
                </div>
                <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-gray-600 dark:bg-white/10 dark:text-gray-300">
                  {getWorkflowStatusLocation(normalizedRequireInputStatus)}
                </span>
              </div>
              <div className="flex gap-2">
                <select
                  className="flex-1 bg-gray-50 dark:bg-[#252630] border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 outline-none focus:border-primary text-sm font-medium"
                  value={isRequireInputStatusMissing ? '__missing__' : normalizedRequireInputStatus}
                  onChange={e => setRequireInputStatus(e.target.value)}
                  disabled={statusOptions.length === 0}
                >
                  {isRequireInputStatusMissing && (
                    <option value="__missing__" disabled>
                      {normalizedRequireInputStatus} (missing)
                    </option>
                  )}
                  {statusOptions.length === 0 ? (
                    <option value="">No statuses available</option>
                  ) : (
                    statusOptions.map((statusOption) => (
                      <option key={statusOption} value={statusOption}>
                        {statusOption}
                      </option>
                    ))
                  )}
                </select>
                <button
                  type="button"
                  onClick={() => restoreWorkflowStatusToBoard(normalizedRequireInputStatus)}
                  className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
                >
                  Restore
                </button>
              </div>
            </div>

            <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-white/10 dark:bg-black/20">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h4 className="text-sm font-bold text-gray-800 dark:text-gray-200">Ready for Merge Status</h4>
                  <p className="mt-1 text-xs text-gray-500">Tickets in this status wait for review and the `finish &lt;ticket&gt;` handoff.</p>
                </div>
                <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-gray-600 dark:bg-white/10 dark:text-gray-300">
                  {getWorkflowStatusLocation(normalizedReadyForMergeStatus)}
                </span>
              </div>
              <div className="flex gap-2">
                <select
                  className="flex-1 bg-gray-50 dark:bg-[#252630] border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 outline-none focus:border-primary text-sm font-medium"
                  value={isReadyForMergeStatusMissing ? '__missing__' : normalizedReadyForMergeStatus}
                  onChange={e => setReadyForMergeStatus(e.target.value)}
                  disabled={statusOptions.length === 0}
                >
                  {isReadyForMergeStatusMissing && (
                    <option value="__missing__" disabled>
                      {normalizedReadyForMergeStatus} (missing)
                    </option>
                  )}
                  {statusOptions.length === 0 ? (
                    <option value="">No statuses available</option>
                  ) : (
                    statusOptions.map((statusOption) => (
                      <option key={statusOption} value={statusOption}>
                        {statusOption}
                      </option>
                    ))
                  )}
                </select>
                <button
                  type="button"
                  onClick={() => restoreWorkflowStatusToBoard(normalizedReadyForMergeStatus)}
                  className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
                >
                  Restore
                </button>
              </div>
            </div>

            <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-white/10 dark:bg-black/20">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h4 className="text-sm font-bold text-gray-800 dark:text-gray-200">Archive Status</h4>
                  <p className="mt-1 text-xs text-gray-500">Tickets in this status are hidden from the board but remain discoverable via search.</p>
                </div>
                <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-gray-600 dark:bg-white/10 dark:text-gray-300">
                  {getWorkflowStatusLocation(normalizedArchiveStatus)}
                </span>
              </div>
              <div className="flex gap-2">
                <select
                  className="flex-1 bg-gray-50 dark:bg-[#252630] border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 outline-none focus:border-primary text-sm font-medium"
                  value={statusOptions.includes(normalizedArchiveStatus) ? normalizedArchiveStatus : '__missing__'}
                  onChange={e => setArchiveStatus(e.target.value)}
                  disabled={statusOptions.length === 0}
                >
                  {!statusOptions.includes(normalizedArchiveStatus) && (
                    <option value="__missing__" disabled>
                      {normalizedArchiveStatus} (missing)
                    </option>
                  )}
                  {statusOptions.length === 0 ? (
                    <option value="">No statuses available</option>
                  ) : (
                    statusOptions.map((statusOption) => (
                      <option key={statusOption} value={statusOption}>
                        {statusOption}
                      </option>
                    ))
                  )}
                </select>
                <button
                  type="button"
                  onClick={() => restoreWorkflowStatusToBoard(normalizedArchiveStatus)}
                  className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
                >
                  Restore
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
