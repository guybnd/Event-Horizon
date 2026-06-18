import { API_URL } from './api';

const TASK_MARKDOWN_BASE_ORIGIN = 'https://task.local';
const FLUX_ASSETS_PREFIX = '.flux/assets/';

function isPassthroughHref(href: string) {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href);
}

function normalizeTicketRelativePath(taskId: string, href: string) {
  try {
    const resolvedUrl = new URL(href, `${TASK_MARKDOWN_BASE_ORIGIN}/.flux/${encodeURIComponent(taskId)}.md`);
    return decodeURIComponent(resolvedUrl.pathname.replace(/^\/+/, ''));
  } catch {
    return null;
  }
}

export function resolveTaskMarkdownHref(taskId: string | undefined, href: string | undefined) {
  if (!href || !taskId || isPassthroughHref(href)) {
    return href;
  }

  const normalizedPath = normalizeTicketRelativePath(taskId, href);
  if (!normalizedPath) {
    return href;
  }

  const assetPath = normalizedPath.startsWith(FLUX_ASSETS_PREFIX)
    ? normalizedPath.slice(FLUX_ASSETS_PREFIX.length)
    : normalizedPath.startsWith('assets/')
      ? normalizedPath.slice('assets/'.length)
      : null;

  if (!assetPath) {
    return href;
  }

  const encodedAssetPath = assetPath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `${API_URL}/assets/${encodedAssetPath}`;
}

export function normalizeTaskMarkdownBody(markdown: string) {
  const normalized = markdown.replace(/\r\n/g, '\n').trimEnd();
  return normalized ? `${normalized}\n` : '';
}
