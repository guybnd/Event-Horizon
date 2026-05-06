import type { Config } from './types';

export const DEFAULT_REQUIRE_INPUT_STATUS = 'Require Input';
export const DEFAULT_READY_FOR_MERGE_STATUS = 'Ready';

export function getRequireInputStatus(config?: Config | null) {
  return config?.requireInputStatus?.trim() || DEFAULT_REQUIRE_INPUT_STATUS;
}

export function getReadyForMergeStatus(config?: Config | null) {
  return config?.readyForMergeStatus?.trim() || DEFAULT_READY_FOR_MERGE_STATUS;
}

export function getPromptableStatuses(config?: Config | null) {
  return Array.from(new Set([getRequireInputStatus(config), getReadyForMergeStatus(config)]));
}

export function isPromptableStatus(status: string | undefined, config?: Config | null) {
  if (!status) return false;
  return getPromptableStatuses(config).includes(status);
}