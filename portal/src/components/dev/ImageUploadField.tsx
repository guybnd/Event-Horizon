import { useRef, useState } from 'react';
import { ImagePlus, Loader2, X } from 'lucide-react';
import { uploadOnboardingAsset, deleteOnboardingAsset } from '../../api';
import type { OnboardingImage } from '../../config/onboardingFlow';
import { OnboardingMedia } from '../onboarding/OnboardingMedia';

/**
 * FLUX-760 Phase 3 — the SHARED dev-only image-upload control used by BOTH editor
 * tabs (Flow per content-page, Features per panel), so the upload UX + the upload
 * call are written ONCE.
 *
 * Flow: pick a file -> read base64 (FileReader.readAsDataURL, same pattern as the
 * chat upload in taskAssetUploads.ts) -> POST via api.uploadOnboardingAsset, which
 * writes the raw bytes (NO re-encode — gif animation preserved) to the committed
 * portal/public/onboarding-assets/ dir and returns a root-absolute url. On 201 we
 * call onChange({ src: url, alt }) so the draft holds the committed path; the
 * editor's existing Save PUT then persists the reference into the committed JSON
 * (upload writes the FILE; Save writes the PATH).
 *
 * The thumbnail is a plain <img> (NOT canvas, NOT a background-image) with
 * object-contain, so an uploaded GIF visibly LOOPS in the editor. A ?v=Date.now()
 * cache-buster is appended to the PREVIEW src ONLY (never to the committed
 * image.src) so a same-id re-upload refreshes past the browser cache.
 *
 * DEV-ONLY: this module is a transitive import of the import.meta.env.DEV-gated
 * Onboarding Studio chunk (imported only by the two editor tabs), and
 * uploadOnboardingAsset hits a route that only mounts in dev — so it is
 * dead-code-eliminated from the production bundle.
 */

const ACCEPT = 'image/png,image/jpeg,image/svg+xml,image/gif,video/mp4,video/webm';

/** Read a File as a bare base64 string (data-URL prefix stripped) — mirrors taskAssetUploads.ts. */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Failed to read ${file.name || 'media'}.`));
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error(`Failed to read ${file.name || 'media'}.`));
        return;
      }
      const commaIndex = reader.result.indexOf(',');
      resolve(commaIndex >= 0 ? reader.result.slice(commaIndex + 1) : reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export function ImageUploadField({
  kind,
  id,
  value,
  onChange,
}: {
  kind: 'page' | 'feature';
  id: string;
  value: OnboardingImage | undefined;
  onChange: (image: OnboardingImage | undefined) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bump on every successful upload so the SAME committed src dodges the browser
  // cache (the path is deterministic — re-upload overwrites in place). Applied to
  // the PREVIEW img only, never to the committed image.src.
  const [cacheBust, setCacheBust] = useState(0);

  const hasImage = !!value?.src;

  async function handlePick(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const content = await readFileAsBase64(file);
      const result = await uploadOnboardingAsset(kind, id, {
        fileName: file.name || 'media',
        mimeType: file.type,
        content,
      });
      // Preserve any alt the author already typed; the committed src is the bare url.
      onChange({ src: result.url, alt: value?.alt });
      setCacheBust(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setBusy(false);
      // Reset the input so re-picking the SAME file still fires onChange.
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function handleRemove() {
    setBusy(true);
    setError(null);
    try {
      // Blank the reference first (the load-bearing action); deleting the committed
      // file is best-effort — a failure there must not block clearing the ref.
      onChange(undefined);
      await deleteOnboardingAsset(kind, id).catch(() => {
        /* best-effort: orphaned file is acceptable, the ref is already cleared */
      });
    } finally {
      setBusy(false);
    }
  }

  // Preview src: committed path + cache-buster (preview ONLY — committed src is bare).
  const previewSrc = hasImage
    ? cacheBust
      ? `${value!.src}${value!.src.includes('?') ? '&' : '?'}v=${cacheBust}`
      : value!.src
    : null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-gray-50/60 p-2 dark:border-white/10 dark:bg-white/[0.02]">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
          Media
        </span>
        <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[9px] font-semibold text-gray-400 dark:bg-white/10 dark:text-gray-500">
          dev only
        </span>
      </div>

      <div className="flex items-start gap-2">
        {/* Thumbnail THROUGH the shared OnboardingMedia so an uploaded .mp4/.webm shows a
            muted looping <video> exactly matching prod (and gif/img still animate).
            OnboardingMedia strips the ?v= cache-buster before sniffing, so video and image
            previews are classified correctly. */}
        {previewSrc ? (
          <OnboardingMedia
            image={{ src: previewSrc, alt: value?.alt }}
            className="h-16 w-16 shrink-0 rounded-lg border border-gray-200 bg-white object-contain dark:border-white/10 dark:bg-white/5"
          />
        ) : (
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border border-dashed border-gray-300 text-gray-300 dark:border-white/15 dark:text-white/20">
            <ImagePlus className="h-5 w-5" />
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
              className="flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-200 dark:hover:bg-white/10"
            >
              {busy ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <ImagePlus className="h-3 w-3" />
              )}
              {hasImage ? 'Replace media' : 'Upload media'}
            </button>
            {hasImage && (
              <button
                type="button"
                onClick={handleRemove}
                disabled={busy}
                aria-label="Remove media"
                className="flex items-center gap-1 rounded-md p-1 text-gray-400 transition-colors hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50 dark:hover:bg-rose-400/10"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Alt-text editor — edits image.alt without touching the committed file. */}
          <input
            type="text"
            value={value?.alt ?? ''}
            disabled={!hasImage || busy}
            onChange={(e) =>
              onChange({ src: value?.src ?? '', alt: e.target.value || undefined })
            }
            placeholder="Alt text (optional)"
            className="w-full rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] text-gray-700 outline-none focus:border-primary disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-200"
          />
        </div>

        {/* Hidden file input — accepts gif + mp4/webm (the onboarding allowlist), NOT the chat set. */}
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => handlePick(e.target.files?.[0])}
        />
      </div>

      {error && (
        <p className="rounded-md bg-rose-50 px-2 py-1 text-[11px] text-rose-700 dark:bg-rose-400/10 dark:text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}
