import type { Config, Task } from './types';

export const DEFAULT_REQUIRE_INPUT_STATUS = 'Require Input';
export const DEFAULT_READY_FOR_MERGE_STATUS = 'Ready';
export const DEFAULT_ARCHIVE_STATUS = 'Archived';

export function getRequireInputStatus(config?: Config | null) {
  return config?.requireInputStatus?.trim() || DEFAULT_REQUIRE_INPUT_STATUS;
}

export function getReadyForMergeStatus(config?: Config | null) {
  return config?.readyForMergeStatus?.trim() || DEFAULT_READY_FOR_MERGE_STATUS;
}

export function getArchiveStatus(config?: Config | null) {
  return config?.archiveStatus?.trim() || DEFAULT_ARCHIVE_STATUS;
}

export function getPromptableStatuses(config?: Config | null) {
  return Array.from(new Set([getRequireInputStatus(config), getReadyForMergeStatus(config)]));
}

export function isTaskAwaitingInput(task: Task): boolean {
  return task.swimlane === 'require-input';
}

export function isTaskPromptable(task: Task, config?: Config | null): boolean {
  if (task.swimlane === 'require-input') return true;
  const readyStatus = getReadyForMergeStatus(config);
  return task.status === readyStatus;
}

export function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function isPromptableStatus(status: string | undefined, config?: Config | null) {
  if (!status) return false;
  return getPromptableStatuses(config).includes(status);
}