import type { Config } from './types';

export const STATUS_COLOR_PALETTE = [
  'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
  'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300',
];

export function getDefaultStatusColor(statusName: string | undefined) {
  if (!statusName) return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  const normalized = statusName.trim().toLowerCase();

  if (normalized === 'done') {
    return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300';
  }

  if (normalized === 'in progress') {
    return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300';
  }

  if (normalized === 'require input' || normalized === 'ready') {
    return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';
  }

  if (normalized === 'grooming') {
    return 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300';
  }

  if (normalized === 'todo') {
    return 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300';
  }

  if (normalized === 'backlog') {
    return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  }

  return 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300';
}

export function getStatusColorClass(config: Config | null | undefined, statusName: string | undefined) {
  if (!statusName) return getDefaultStatusColor('unknown');
  const normalized = statusName.trim().toLowerCase();
  const configuredStatus = [...(config?.columns || []), ...(config?.hiddenStatuses || [])]
    .find((item) => item.name?.trim().toLowerCase() === normalized);

  return configuredStatus?.color || getDefaultStatusColor(statusName);
}