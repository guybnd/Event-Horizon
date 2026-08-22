// FLUX-1662 (Phase A step 1) — server-side doc markdown renderer for the auto doc-recap artifact.
// Mirrors portal/src/lib/docMarkdown.ts's pipeline (stripFrontmatter -> best-effort wiki-link
// inlining -> marked.parse) but runs engine-side, since the recap emitter has no browser to render
// in and no `Doc[]` list to resolve wiki-links against. Keep the two pipelines in sync if either
// changes. Unlike the portal (trusted, dangerouslySetInnerHTML straight into the app shell), the
// output here is repo-authored doc content embedded into an artifact HTML document served through
// the sandboxed-iframe artifact viewer — sanitize on top of the sandbox + ARTIFACT_CSP as
// defense-in-depth since the content's provenance differs from deliberately-authored artifact HTML.

import matter from 'gray-matter';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: false });

/** Strip a leading YAML front-matter block (`---\n...\n---\n`), if present. Idempotent. */
function stripFrontmatter(content: string): string {
  try {
    return matter(content).content;
  } catch {
    return content;
  }
}

/** No doc list is available server-side, so a `[[wiki-link]]` degrades to its plain label text
 *  instead of resolving to a real link — inert, never throws. */
function inlineWikiLinks(markdown: string): string {
  return markdown.replace(/\[\[([^\]]+)\]\]/g, (match, rawTarget: string) => {
    const label = String(rawTarget ?? '').trim();
    return label || match;
  });
}

function stripScriptTags(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
}

function findTagEnd(html: string, start: number): number {
  let index = start + 1;
  while (index < html.length) {
    const char = html[index];
    if (char === '"' || char === "'") {
      const quote = char;
      let quoteEnd = index + 1;
      while (quoteEnd < html.length && html[quoteEnd] !== quote) quoteEnd += 1;
      if (html[quoteEnd] === quote) {
        index = quoteEnd + 1;
        continue;
      }
      const malformedEnd = html.indexOf('>', index + 1);
      return malformedEnd;
    }
    if (char === '>') return index;
    if (char === '<') return -1;
    index += 1;
  }
  return -1;
}

/** Applies `transform` only to real opening HTML tags (`<tag ...>`), never to escaped text
 *  (`&lt;div onclick=x&gt;` inside a code fence) or ordinary prose. The tokenizer is quote-aware so
 *  a `>` inside a quoted attribute value does not truncate the sanitized tag span; malformed tags
 *  with unterminated quotes still end at `>` so dangerous attributes are stripped best-effort. */
function withinTags(html: string, transform: (tag: string) => string): string {
  let result = '';
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.slice(cursor).search(/<[a-zA-Z]/);
    if (start === -1) {
      result += html.slice(cursor);
      break;
    }
    const tagStart = cursor + start;
    const tagEnd = findTagEnd(html, tagStart);
    if (tagEnd === -1) {
      result += html.slice(cursor);
      break;
    }
    result += html.slice(cursor, tagStart);
    result += transform(html.slice(tagStart, tagEnd + 1));
    cursor = tagEnd + 1;
  }
  return result;
}

const NAMED_URL_ENTITIES: Record<string, string> = {
  tab: '\t',
  newline: '\n',
  colon: ':',
};

/** Decodes what a browser decodes before resolving a URL scheme: numeric entities (`&#106;`,
 *  `&#x6a;`) and the handful of named whitespace/colon entities attackers use to split `javascript:`. */
function decodeUrlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_URL_ENTITIES[name.toLowerCase()] ?? match);
}

/** Scheme allowlist (not a denylist) applied after decoding — a denylist on the raw attribute text
 *  is trivially bypassed by entity/whitespace obfuscation (`&#106;avascript:`, `java&Tab;script:`). */
function isSafeUrl(raw: string, attrName: string): boolean {
  // Drop whitespace and C0 control characters (codes <= 0x20) the way a browser does before
  // resolving a URL scheme — done via charCodeAt rather than a regex range to avoid embedding
  // literal control characters in a regular expression.
  const cleaned = Array.from(decodeUrlEntities(raw))
    .filter((ch) => ch.charCodeAt(0) > 0x20)
    .join('');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(cleaned)) return true; // relative, query, or #fragment — no scheme
  if (attrName.toLowerCase().split(':').pop() === 'src' && /^data:image\/(?:png|jpeg|gif|webp)(?:[;,]|$)/i.test(cleaned)) {
    return true;
  }
  return /^(?:https?|mailto):/i.test(cleaned);
}

/** Strips `on*=` handlers in quoted or unquoted form, e.g. `onerror=alert(1)` — `marked`'s raw-HTML
 *  passthrough does not require attribute values to be quoted, so a quoted-only regex misses this.
 *  Confined to real tags via `withinTags`. Note a legitimate attribute value that happens to contain
 *  `on*=`-shaped text (e.g. `title="use onmouseover=true in config"`) is still mangled — inherent to
 *  a regex-based strip operating on raw tag text, not a parser bug. */
function stripEventHandlerAttributes(html: string): string {
  return withinTags(html, (tag) => tag.replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/gi, ''));
}

/** Strips `href`/`src`/`action`/`formaction` attributes whose URL scheme isn't on the allowlist
 *  (quoted or unquoted) — covers `javascript:` and `data:` script-execution vectors that `marked`'s
 *  raw-HTML passthrough lets through untouched, on `<a>`/`<img>`/`<form>`/`<button>` alike. Allows
 *  namespace-prefixed URL sinks like `xlink:href` and raster `data:image/...` only for `src`. */
function stripUnsafeUrlAttributes(html: string): string {
  return withinTags(html, (tag) =>
    tag.replace(
      /\s((?:[a-z][\w.-]*:)?(?:href|src|action|formaction))\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi,
      (match, attrName, dq, sq, uq) => {
        const value = dq ?? sq ?? uq ?? '';
        return isSafeUrl(value, attrName) ? match : '';
      }
    )
  );
}

export function renderDocMarkdownToHtml(markdown: string): string {
  let rendered = '';
  try {
    const withoutFrontmatter = stripFrontmatter(markdown ?? '');
    const withInlinedWikiLinks = inlineWikiLinks(withoutFrontmatter);
    rendered = (marked.parse(withInlinedWikiLinks) as string) || '';
  } catch {
    /* fall through with rendered = '' */
  }
  return stripUnsafeUrlAttributes(stripEventHandlerAttributes(stripScriptTags(rendered)));
}
