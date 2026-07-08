/** FLUX-1303: portal copy of the engine's `planBodyHash` (engine/src/models/gate-policy.ts) —
 *  duplicated because the portal can't import from the engine package (same pattern as
 *  `resolvePlanGateValue` in pendingInteractions.tsx). Keep the two in sync.
 *
 *  Stable non-cryptographic djb2/base36 hash of a plan body. The engine records it as
 *  `planReviewBodyHash` when a plan verdict lands; the portal compares it against the current
 *  body to tell whether the plan changed since that review — re-reviewing an unchanged plan can
 *  only re-produce the same verdict, so "Re-review plan" is gated on a mismatch. */
export function planBodyHash(body: string): string {
  let h = 5381;
  for (let i = 0; i < body.length; i++) h = ((h << 5) + h + body.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
