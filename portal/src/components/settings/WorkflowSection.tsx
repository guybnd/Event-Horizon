import type { StatusDef } from '../../types';
import { StatusEditor } from './shared';
import { getStatusRole } from '../../workflow';

interface WorkflowSectionProps {
  columns: StatusDef[];
  setColumns: (items: StatusDef[]) => void;
  hiddenStatuses: StatusDef[];
  setHiddenStatuses: (items: StatusDef[]) => void;
  requireInputStatus: string;
  readyForMergeStatus: string;
  archiveStatus: string;
}

export function WorkflowSection({
  columns,
  setColumns,
  hiddenStatuses,
  setHiddenStatuses,
  requireInputStatus,
  readyForMergeStatus,
  archiveStatus,
}: WorkflowSectionProps) {
  const roleOf = (name: string) =>
    getStatusRole(name, { requireInput: requireInputStatus, ready: readyForMergeStatus, archive: archiveStatus });

  return (
    <div>
      <p className="text-xs text-gray-500 mb-6 text-balance">
        Board columns and statuses are managed by Event Horizon. The workflow engine and agent
        instructions are written around them (phase routing, the Require Input / Ready / Archive
        roles, the Needs-Action safety net), so they can't be added, removed, or renamed — that
        would break those flows. You can <strong>recolor</strong> any status and reorder your board
        columns; the badge on each row shows its workflow role.
      </p>

      <div className="grid grid-cols-2 gap-10">
        <div>
          <h4 className="text-sm font-bold text-gray-800 dark:text-gray-200 mb-1">Board Columns</h4>
          <p className="text-xs text-gray-500 mb-4">Statuses that appear as lanes on your Kanban board.</p>
          <StatusEditor items={columns} setItems={setColumns} placeholder="Column Status Name" sortable locked roleOf={roleOf} />
        </div>
        <div>
          <h4 className="text-sm font-bold text-gray-800 dark:text-gray-200 mb-1">Hidden Statuses</h4>
          <p className="text-xs text-gray-500 mb-4">Statuses that don't appear as board columns (e.g. Backlog, Archived, Released).</p>
          <StatusEditor items={hiddenStatuses} setItems={setHiddenStatuses} placeholder="Hidden Status Name" locked roleOf={roleOf} />
        </div>
      </div>
    </div>
  );
}
