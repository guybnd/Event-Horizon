import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { API_URL } from '../api';

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

function resolveTaskMarkdownHref(taskId: string | undefined, href: string | undefined) {
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

function MarkdownImage({
  src,
  alt,
  taskId,
  compact,
}: {
  src?: string;
  alt?: string;
  taskId?: string;
  compact?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const resolvedSrc = resolveTaskMarkdownHref(taskId, src);

  if (!resolvedSrc || failed) {
    return (
      <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
        Image unavailable{alt ? `: ${alt}` : src ? `: ${src}` : '.'}
      </div>
    );
  }

  return (
    <img
      src={resolvedSrc}
      alt={alt || ''}
      loading="lazy"
      onError={() => setFailed(true)}
      className={compact
        ? 'mb-3 max-h-64 w-full rounded-xl border border-gray-200 bg-white object-contain dark:border-white/10 dark:bg-black/20'
        : 'mb-4 max-h-[32rem] w-full rounded-2xl border border-gray-200 bg-white object-contain dark:border-white/10 dark:bg-black/20'}
    />
  );
}

export function TaskMarkdown({
  body,
  taskId,
  compact = false,
  emptyMessage = 'No description yet.',
}: {
  body: string;
  taskId?: string;
  compact?: boolean;
  emptyMessage?: string;
}) {
  const headingClassNames = compact
    ? {
        h1: 'mb-3 text-2xl font-bold text-gray-900 dark:text-gray-100',
        h2: 'mb-2 mt-6 text-xl font-semibold text-gray-900 dark:text-gray-100',
        h3: 'mb-2 mt-4 text-lg font-semibold text-gray-900 dark:text-gray-100',
      }
    : {
        h1: 'mb-4 text-3xl font-bold text-gray-900 dark:text-gray-100',
        h2: 'mb-3 mt-8 text-2xl font-semibold text-gray-900 dark:text-gray-100',
        h3: 'mb-2 mt-6 text-xl font-semibold text-gray-900 dark:text-gray-100',
      };

  return (
    <div className={`max-w-none text-sm leading-7 text-gray-700 dark:text-gray-300 ${compact ? '' : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className={headingClassNames.h1}>{children}</h1>,
          h2: ({ children }) => <h2 className={headingClassNames.h2}>{children}</h2>,
          h3: ({ children }) => <h3 className={headingClassNames.h3}>{children}</h3>,
          p: ({ children }) => <p className="mb-4 whitespace-pre-wrap">{children}</p>,
          ul: ({ children }) => <ul className="mb-4 list-disc space-y-1 pl-6">{children}</ul>,
          ol: ({ children }) => <ol className="mb-4 list-decimal space-y-1 pl-6">{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          a: ({ children, href }) => {
            const resolvedHref = resolveTaskMarkdownHref(taskId, href);
            return (
              <a className="text-primary underline underline-offset-2" href={resolvedHref} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
          img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} taskId={taskId} compact={compact} />,
          code: ({ children, className }) => {
            const isBlock = className?.includes('language-');
            if (isBlock) {
              return <code className="block overflow-x-auto rounded-lg bg-black/90 p-4 text-sm text-gray-100">{children}</code>;
            }
            return <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-800 dark:bg-black/30 dark:text-gray-100">{children}</code>;
          },
          pre: ({ children }) => <pre className="mb-4 overflow-x-auto rounded-lg bg-black/90">{children}</pre>,
          blockquote: ({ children }) => (
            <blockquote className="mb-4 border-l-4 border-primary/40 pl-4 italic text-gray-600 dark:text-gray-400">
              {children}
            </blockquote>
          ),
          table: ({ children }) => <table className="mb-4 w-full border-collapse overflow-hidden rounded-lg">{children}</table>,
          thead: ({ children }) => <thead className="bg-gray-100 dark:bg-white/5">{children}</thead>,
          th: ({ children }) => <th className="border border-gray-200 px-3 py-2 text-left dark:border-white/10">{children}</th>,
          td: ({ children }) => <td className="border border-gray-200 px-3 py-2 dark:border-white/10">{children}</td>,
        }}
      >
        {body || emptyMessage}
      </ReactMarkdown>
    </div>
  );
}