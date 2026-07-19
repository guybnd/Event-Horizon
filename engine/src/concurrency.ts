/**
 * FLUX-1547: bounded-concurrency worker pool shared by the boot scan (task-store.ts's `initDir`)
 * and the boot index's stat-comparison pass (boot-index.ts). Each worker pulls the next index
 * off a shared cursor — plain synchronous increment is race-free since JS only yields at `await`
 * points — so results are order-independent by construction: callers must not rely on `items`
 * being processed front-to-back.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const poolSize = Math.max(1, Math.min(concurrency, items.length));
  let next = 0;
  const runWorker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: poolSize }, runWorker));
}
