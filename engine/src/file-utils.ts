import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import { getFluxDir, getActiveFluxDir, getTaskAssetsDir, workspaceRoot } from './workspace.js';
import { configCache } from './config.js';

export const SUPPORTED_IMAGE_TYPES = new Map<string, string>([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/svg+xml', '.svg'],
]);

export const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.svg']);

// ─── Onboarding image allowlist (FLUX-760) ─────────────────────────────────────
//
// SEPARATE, gif-AWARE allowlist used ONLY by the dev-only onboarding-asset route.
// It deliberately does NOT widen the chat SUPPORTED_IMAGE_TYPES/EXTENSIONS above
// (those exclude gif on purpose so animated gifs never enter chat). Onboarding
// images are committed assets that ship in portal/public/onboarding-assets/ and
// are rendered by the wizard, so animated gif support is required here.
export const ONBOARDING_IMAGE_TYPES = new Map<string, string>([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/svg+xml', '.svg'],
  ['image/gif', '.gif'],
  // FLUX-763: looping-video onboarding media. .mov is render/delete-aware (in
  // EXTENSIONS below) but deliberately NOT in this upload-ACCEPT map — it is large +
  // less web-friendly (video/quicktime). Recommend authoring H.264 mp4 as primary.
  ['video/mp4', '.mp4'],
  ['video/webm', '.webm'],
]);

export const ONBOARDING_IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.svg',
  '.gif',
  '.mp4',
  '.webm',
  '.mov',
]);

/**
 * Resolve the on-disk extension for an onboarding image, MIME-first then falling
 * back to the client-supplied filename's extension. Returns null when neither
 * resolves to an allowed onboarding image type (caller responds 400). The
 * extension is what makes express.static/Vite serve the correct Content-Type
 * (e.g. .gif → image/gif), so it must come from this validated allowlist and
 * NEVER be trusted raw from the client name without validation.
 */
export function resolveOnboardingImageExtension(fileName: string, mimeType: string) {
  const normalizedMimeType = typeof mimeType === 'string' ? mimeType.trim().toLowerCase() : '';
  if (ONBOARDING_IMAGE_TYPES.has(normalizedMimeType)) {
    return ONBOARDING_IMAGE_TYPES.get(normalizedMimeType)!;
  }

  const extension = getExtensionFromFileName(fileName);
  if (ONBOARDING_IMAGE_EXTENSIONS.has(extension)) {
    return extension === '.jpeg' ? '.jpg' : extension;
  }

  return null;
}

export interface DocRecord {
  path: string;
  title: string;
  body: string;
  slug: string;
  directory: string;
  order?: number;
  /** Group docs (`.flux-group`) surfaced under the synthetic Product prefix are read-only. */
  readOnly?: boolean;
  /** True for cross-project group docs (vs the repo's own `.docs/`). */
  group?: boolean;
  /** True when this group doc is editable but its writes route through the group parent (bound member, FLUX-419). */
  viaParent?: boolean;
}

export interface StoredDoc extends DocRecord {
  _path: string;
}

export function getDocsDir() {
  return path.join(workspaceRoot!, configCache.docsRoot || '.docs');
}

// ─── Asset helpers ────────────────────────────────────────────────────────────

export function isTopLevelTaskFile(filePath: string) {
  return filePath.endsWith('.md') && path.dirname(filePath) === getActiveFluxDir();
}

export function normalizeRelativePath(filePath: string) {
  return filePath.split(path.sep).join('/');
}

export function encodeAssetPath(assetPath: string) {
  return assetPath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

export function normalizeAssetPathInput(value: unknown) {
  if (typeof value !== 'string') return null;

  const normalized = value.replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '');
  if (!normalized) return null;

  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) return null;

  return segments.join('/');
}

export function getAssetPathFromRequestPath(requestPath: string) {
  const prefix = '/api/assets/';
  if (!requestPath.startsWith(prefix)) return null;
  try {
    return normalizeAssetPathInput(decodeURIComponent(requestPath.slice(prefix.length)));
  } catch {
    return null;
  }
}

export function getAssetFilePath(assetPath: string) {
  return path.join(getTaskAssetsDir(), ...assetPath.split('/'));
}

export function isPathInsideRoot(rootPath: string, targetPath: string) {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

export function getExtensionFromFileName(fileName: string) {
  const extension = path.extname(fileName || '').toLowerCase();
  if (extension === '.jpeg') return '.jpg';
  return extension;
}

export function sanitizeAssetBaseName(fileName: string) {
  const baseName = path.basename(fileName, path.extname(fileName));
  const normalized = baseName
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
  return normalized || 'image';
}

export function resolveSupportedImageExtension(fileName: string, mimeType: string) {
  const normalizedMimeType = typeof mimeType === 'string' ? mimeType.trim().toLowerCase() : '';
  if (SUPPORTED_IMAGE_TYPES.has(normalizedMimeType)) {
    return SUPPORTED_IMAGE_TYPES.get(normalizedMimeType)!;
  }

  const extension = getExtensionFromFileName(fileName);
  if (SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
    return extension === '.jpeg' ? '.jpg' : extension;
  }

  return null;
}

export function normalizeBase64Content(content: string) {
  const trimmedContent = content.trim();
  const match = trimmedContent.match(/^data:[^;]+;base64,(.+)$/i);
  return (match ? match[1]! : trimmedContent).replace(/\s+/g, '');
}

export async function createUniqueAssetFileName(directoryPath: string, requestedFileName: string) {
  const extension = path.extname(requestedFileName);
  const baseName = path.basename(requestedFileName, extension);
  let suffix = 1;
  let candidate = requestedFileName;

  while (true) {
    const candidatePath = path.join(directoryPath, candidate);
    try {
      await fs.access(candidatePath);
      suffix += 1;
      candidate = `${baseName}-${suffix}${extension}`;
    } catch (error: any) {
      if (error.code === 'ENOENT') return candidate;
      throw error;
    }
  }
}

// ─── Doc helpers ─────────────────────────────────────────────────────────────

export function normalizeDocPathInput(value: unknown) {
  if (typeof value !== 'string') return null;

  const normalized = value.replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '');
  if (!normalized) return null;

  const withoutExtension = normalized.toLowerCase().endsWith('.md')
    ? normalized.slice(0, -3)
    : normalized;
  const segments = withoutExtension.split('/').filter(Boolean);

  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) return null;

  return segments.join('/');
}

export function getDocPathFromFile(filePath: string) {
  const relativePath = normalizeRelativePath(path.relative(getDocsDir(), filePath));
  if (!relativePath || relativePath.startsWith('..')) return null;
  return normalizeDocPathInput(relativePath);
}

export function getDocFilePath(docPath: string) {
  return path.join(getDocsDir(), ...docPath.split('/')) + '.md';
}

export function isDocFile(filePath: string) {
  return filePath.toLowerCase().endsWith('.md') && getDocPathFromFile(filePath) !== null;
}

export function titleFromDocPath(docPath: string) {
  const basename = docPath.split('/').filter(Boolean).pop() || 'untitled';
  return basename
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

export function slugifyDocValue(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function parseDocOrder(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsedValue = Number(value);
    if (Number.isFinite(parsedValue)) return parsedValue;
  }
  return undefined;
}

export function serializeDoc(doc: StoredDoc): DocRecord {
  const { _path, ...publicDoc } = doc;
  return publicDoc;
}

export function getDocPathFromRequestPath(requestPath: string) {
  const prefix = '/api/docs/';
  if (!requestPath.startsWith(prefix)) return null;
  try {
    return normalizeDocPathInput(decodeURIComponent(requestPath.slice(prefix.length)));
  } catch {
    return null;
  }
}

export function buildDocFrontmatter(title: string, order: number | undefined) {
  return {
    title,
    ...(order !== undefined ? { order } : {}),
  };
}

/** Serialize a doc to its on-disk markdown form (frontmatter + body). */
export function buildDocMarkdown(title: string, order: number | undefined, body: string): string {
  return matter.stringify(body, buildDocFrontmatter(title, order));
}

export function sortDocs(docs: DocRecord[]) {
  return [...docs].sort((left, right) => left.path.localeCompare(right.path, undefined, { sensitivity: 'base' }));
}

export async function writeDocFile(filePath: string, title: string, order: number | undefined, body: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buildDocMarkdown(title, order, body), 'utf-8');
}

export async function removeEmptyDocDirectories(startingFilePath: string) {
  let currentDirectory = path.dirname(startingFilePath);
  const docsRoot = path.resolve(getDocsDir());

  while (path.resolve(currentDirectory) !== docsRoot) {
    const entries = await fs.readdir(currentDirectory);
    if (entries.length > 0) return;
    await fs.rmdir(currentDirectory);
    currentDirectory = path.dirname(currentDirectory);
  }
}
