import { z } from 'zod';

/**
 * FLUX-1147: structured completion handoff attached to the `comment` history entry a
 * `change_status` (Ready move) or `finish_ticket` call writes — the same "prose verdict ->
 * structured field" migration `reviewState` did for reviews (FLUX-816), generalized to the whole
 * completion handoff so downstream readers (reviewer sessions, Furnace, the next implementer,
 * the portal) get fields to read instead of re-parsing free text.
 */
export interface CompletionValidationEntry {
  command: string;
  passed: boolean;
}

export interface CompletionPayload {
  changedFiles?: string[];
  validation?: CompletionValidationEntry[];
  decisions?: string[];
  residualRisk?: string;
  docsUpdated?: string[] | boolean;
}

export const COMPLETION_MAX_CHANGED_FILES = 200;
export const COMPLETION_MAX_VALIDATION_ENTRIES = 50;
export const COMPLETION_MAX_DECISIONS = 20;
export const COMPLETION_MAX_DOCS_UPDATED = 50;
export const COMPLETION_MAX_PATH_LENGTH = 500;
export const COMPLETION_MAX_COMMAND_LENGTH = 500;
export const COMPLETION_MAX_DECISION_LENGTH = 300;
export const COMPLETION_MAX_RESIDUAL_RISK_LENGTH = 2000;
export const COMPLETION_MAX_SERIALIZED_BYTES = 8 * 1024;

/**
 * Deliberately permissive at the MCP schema layer (`z.unknown()`) — `completion` is a courtesy
 * field, never a gate. All real shaping/validation happens in `sanitizeCompletion`, which drops or
 * truncates malformed/oversized input instead of throwing, so a garbage payload can never fail
 * schema validation and block the status move / finish.
 */
export const completionInputSchema = z.unknown().optional().describe(
  'Optional structured completion summary (changedFiles, validation, decisions, residualRisk, docsUpdated) alongside the required comment. Malformed fields are dropped, never rejected.'
);

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function sanitizeStringArray(value: unknown, maxEntries: number, maxLength: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cleaned = value
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .slice(0, maxEntries)
    .map((v) => truncate(v, maxLength));
  return cleaned.length > 0 ? cleaned : undefined;
}

function sanitizeValidationEntries(value: unknown): CompletionValidationEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cleaned: CompletionValidationEntry[] = [];
  for (const item of value) {
    if (cleaned.length >= COMPLETION_MAX_VALIDATION_ENTRIES) break;
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.command !== 'string' || rec.command.length === 0) continue;
    if (typeof rec.passed !== 'boolean') continue;
    cleaned.push({ command: truncate(rec.command, COMPLETION_MAX_COMMAND_LENGTH), passed: rec.passed });
  }
  return cleaned.length > 0 ? cleaned : undefined;
}

function sanitizeDocsUpdated(value: unknown): string[] | boolean | undefined {
  if (typeof value === 'boolean') return value;
  return sanitizeStringArray(value, COMPLETION_MAX_DOCS_UPDATED, COMPLETION_MAX_PATH_LENGTH);
}

function serializedSize(payload: CompletionPayload): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf-8');
}

function shrinkArray(payload: CompletionPayload, key: 'validation' | 'changedFiles' | 'decisions'): boolean {
  const arr = payload[key] as unknown[] | undefined;
  if (!arr || arr.length === 0) return false;
  arr.pop();
  if (arr.length === 0) delete payload[key];
  return true;
}

function shrinkDocsUpdated(payload: CompletionPayload): boolean {
  if (!Array.isArray(payload.docsUpdated) || payload.docsUpdated.length === 0) return false;
  payload.docsUpdated.pop();
  if (payload.docsUpdated.length === 0) delete payload.docsUpdated;
  return true;
}

function shrinkResidualRisk(payload: CompletionPayload): boolean {
  if (!payload.residualRisk) return false;
  const next = payload.residualRisk.slice(0, Math.floor(payload.residualRisk.length / 2));
  if (next.length === 0) delete payload.residualRisk;
  else payload.residualRisk = next;
  return true;
}

// Trims fields in a fixed priority order (least summary-critical first) until the overall payload
// fits COMPLETION_MAX_SERIALIZED_BYTES. Never throws — worst case yields `{}`.
function enforceSizeCap(payload: CompletionPayload): CompletionPayload {
  const steps = [
    () => shrinkArray(payload, 'validation'),
    () => shrinkArray(payload, 'changedFiles'),
    () => shrinkArray(payload, 'decisions'),
    () => shrinkDocsUpdated(payload),
    () => shrinkResidualRisk(payload),
  ];
  let guard = 0;
  while (serializedSize(payload) > COMPLETION_MAX_SERIALIZED_BYTES && guard < 10_000) {
    guard += 1;
    if (!steps.some((step) => step())) break;
  }
  return payload;
}

/**
 * Best-effort sanitizer: never throws. Malformed/oversized input is dropped or truncated rather
 * than rejected, so a garbage `completion` payload can never block a status move or finish — it's
 * a courtesy field, not a gate. Returns `undefined` when there is nothing to persist (raw is
 * absent/null/not a plain object); returns `{}` unchanged when the caller explicitly passed an
 * empty object (stored as empty — renders nothing extra in the portal).
 */
export function sanitizeCompletion(raw: unknown): CompletionPayload | undefined {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const rec = raw as Record<string, unknown>;
  const payload: CompletionPayload = {};

  const changedFiles = sanitizeStringArray(rec.changedFiles, COMPLETION_MAX_CHANGED_FILES, COMPLETION_MAX_PATH_LENGTH);
  if (changedFiles) payload.changedFiles = changedFiles;

  const validation = sanitizeValidationEntries(rec.validation);
  if (validation) payload.validation = validation;

  const decisions = sanitizeStringArray(rec.decisions, COMPLETION_MAX_DECISIONS, COMPLETION_MAX_DECISION_LENGTH);
  if (decisions) payload.decisions = decisions;

  if (typeof rec.residualRisk === 'string' && rec.residualRisk.length > 0) {
    payload.residualRisk = truncate(rec.residualRisk, COMPLETION_MAX_RESIDUAL_RISK_LENGTH);
  }

  const docsUpdated = sanitizeDocsUpdated(rec.docsUpdated);
  if (docsUpdated !== undefined) payload.docsUpdated = docsUpdated;

  return enforceSizeCap(payload);
}
