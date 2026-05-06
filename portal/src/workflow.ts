import type { Config } from './types';

export const REQUIRE_INPUT_STATUS = 'Require Input';
export const DEFAULT_READY_FOR_MERGE_STATUS = 'Ready';

export function getReadyForMergeStatus(config?: Config | null) {
  return config?.readyForMergeStatus?.trim() || DEFAULT_READY_FOR_MERGE_STATUS;
}

export function getPromptableStatuses(config?: Config | null) {
  return Array.from(new Set([REQUIRE_INPUT_STATUS, getReadyForMergeStatus(config)]));
}

export function isPromptableStatus(status: string | undefined, config?: Config | null) {
  if (!status) return false;
  return getPromptableStatuses(config).includes(status);
}