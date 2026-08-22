// FLUX-1662 (Phase A step 1) — server-side doc markdown renderer. Mirrors the pipeline in
// portal/src/lib/docMarkdown.ts (stripFrontmatter -> best-effort wiki-link transform -> marked.parse
// with gfm:true, breaks:false) but runs engine-side, since the auto doc-recap emitter has no browser
// to render in. Unlike the portal renderer (trusted, dangerouslySetInnerHTML'd straight into the app
// shell), this output is embedded into a doc-recap artifact HTML document that ships through the same
// sandboxed-iframe path as any other artifact — but the SOURCE here is repo-authored doc content, a
// different provenance than deliberately-authored artifact HTML, so this module also strips <script>
// tags and inline on*= handlers as defense-in-depth on top of the iframe sandbox + ARTIFACT_CSP.

import { describe, it, expect } from 'vitest';
import { renderDocMarkdownToHtml } from './doc-render.js';

describe('renderDocMarkdownToHtml (FLUX-1662)', () => {
  it('renders headings, lists, and links to the expected HTML fragments', () => {
    const html = renderDocMarkdownToHtml('# Title\n\n- one\n- two\n\n[link](https://example.com)\n');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<li>two</li>');
    expect(html).toContain('<a href="https://example.com">link</a>');
  });

  it('strips a leading YAML front-matter block before rendering', () => {
    const md = '---\ntitle: Guide\norder: 3\n---\n# Guide\n\nBody text.\n';
    const html = renderDocMarkdownToHtml(md);
    expect(html).not.toContain('title: Guide');
    expect(html).not.toContain('order: 3');
    expect(html).not.toContain('---');
    expect(html).toContain('<h1>Guide</h1>');
    expect(html).toContain('Body text.');
  });

  it('is a no-op on content with no front-matter (idempotent stripping)', () => {
    const html = renderDocMarkdownToHtml('# No Frontmatter\n\nJust body.\n');
    expect(html).toContain('<h1>No Frontmatter</h1>');
    expect(html).toContain('Just body.');
  });

  it('strips <script> tags from the rendered output (sanitization)', () => {
    const md = '# Title\n\n<script>alert(document.cookie)</script>\n\nSafe text.\n';
    const html = renderDocMarkdownToHtml(md);
    expect(html.toLowerCase()).not.toContain('<script');
    expect(html.toLowerCase()).not.toContain('alert(document.cookie)');
    expect(html).toContain('Safe text.');
  });

  it('strips inline on*= event handler attributes from the rendered output', () => {
    const md = '# Title\n\n<img src="x.png" onerror="alert(1)">\n\n<div onclick="doEvil()">click me</div>\n\nSafe text.\n';
    const html = renderDocMarkdownToHtml(md);
    expect(html.toLowerCase()).not.toContain('onerror');
    expect(html.toLowerCase()).not.toContain('onclick');
    expect(html).toContain('Safe text.');
  });

  it('strips unquoted inline on*= event handler attributes (FLUX-1666)', () => {
    const md = '# Title\n\n<img src=x.png onerror=alert(1)>\n\n<div onclick=doEvil()>click me</div>\n\nSafe text.\n';
    const html = renderDocMarkdownToHtml(md);
    expect(html.toLowerCase()).not.toContain('onerror');
    expect(html.toLowerCase()).not.toContain('onclick');
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('doEvil()');
    expect(html).toContain('Safe text.');
  });

  it('strips unsafe attributes after a quoted > in the same tag (FLUX-1699)', () => {
    const md = '<img src=x alt=">" onerror=alert(1)>\n\n<a alt=">" href="javascript:alert(2)">x</a>\n';
    const html = renderDocMarkdownToHtml(md);
    expect(html.toLowerCase()).not.toContain('onerror');
    expect(html.toLowerCase()).not.toContain('javascript:');
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('alert(2)');
    expect(html).toContain('alt=">"');
  });

  it('documents malformed tags with unterminated quotes being escaped before sanitizing (FLUX-1699)', () => {
    const md = '<img src=x alt="unterminated onerror=alert(1)>\n';
    const html = renderDocMarkdownToHtml(md);
    expect(html).toContain('&lt;img src=x alt=&quot;unterminated onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
  });

  it('strips javascript: URLs from quoted and unquoted href/src attributes (FLUX-1666)', () => {
    const md =
      '# Title\n\n<a href="javascript:alert(1)">click</a>\n\n' +
      "<a href='javascript:alert(2)'>click</a>\n\n" +
      '<a href=javascript:alert(3)>click</a>\n\n' +
      '<img src=javascript:alert(4)>\n\nSafe text.\n';
    const html = renderDocMarkdownToHtml(md);
    expect(html.toLowerCase()).not.toContain('javascript:');
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('alert(2)');
    expect(html).not.toContain('alert(3)');
    expect(html).not.toContain('alert(4)');
    expect(html).toContain('Safe text.');
  });

  it('strips javascript: URLs from xlink:href without leaving a mangled xlink remnant (FLUX-1699)', () => {
    const html = renderDocMarkdownToHtml('<svg><a xlink:href="javascript:alert(1)">z</a></svg>\n');
    expect(html.toLowerCase()).not.toContain('xlink:href');
    expect(html.toLowerCase()).not.toContain('javascript:');
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('<a xlink>');
    expect(html).toContain('<a>z</a>');
  });

  it('leaves ordinary http(s) href/src attributes untouched', () => {
    const md = '<a href="https://example.com">link</a>\n\n<img src="https://example.com/x.png">\n';
    const html = renderDocMarkdownToHtml(md);
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('src="https://example.com/x.png"');
  });

  it('leaves relative, mailto, and fragment hrefs untouched (FLUX-1666)', () => {
    const md =
      '[relative](./other.md)\n\n[mail](mailto:someone@example.com)\n\n[frag](#section)\n\n![logo](logo.png)\n';
    const html = renderDocMarkdownToHtml(md);
    expect(html).toContain('href="./other.md"');
    expect(html).toContain('href="mailto:someone@example.com"');
    expect(html).toContain('href="#section"');
    expect(html).toContain('src="logo.png"');
  });

  it('does not corrupt prose that merely mentions an on*= handler (FLUX-1666)', () => {
    const md = 'Set onclick=foo() and then reload the page.\n';
    const html = renderDocMarkdownToHtml(md);
    expect(html).toContain('Set onclick=foo() and then reload the page.');
  });

  it('does not corrupt an inline code span documenting an unquoted handler (FLUX-1666)', () => {
    const md = 'Use `<img src=x onerror=alert(1)>` as the vector, then verify.\n';
    const html = renderDocMarkdownToHtml(md);
    expect(html).toContain('</code>');
    expect(html).toContain('then verify.');
  });

  it('does not corrupt a fenced code block documenting an unquoted handler (FLUX-1666)', () => {
    const md = '```html\n<div onclick=doThing()>label</div>\n```\n';
    const html = renderDocMarkdownToHtml(md);
    expect(html).toContain('label');
    expect(html).toContain('&lt;/div&gt;');
    expect(html).toContain('</code></pre>');
  });

  it('strips javascript: hrefs obfuscated with numeric and named entities (FLUX-1666)', () => {
    const md =
      '<a href="&#106;avascript:alert(1)">a</a>\n\n' +
      '<a href="&#x6a;avascript:alert(2)">b</a>\n\n' +
      '<a href="java&Tab;script:alert(3)">c</a>\n\n' +
      'Safe text.\n';
    const html = renderDocMarkdownToHtml(md);
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('alert(2)');
    expect(html).not.toContain('alert(3)');
    expect(html).toContain('Safe text.');
  });

  it('strips javascript: from action/formaction and data: URLs (FLUX-1666)', () => {
    const md =
      '<form action="javascript:alert(1)">f</form>\n\n' +
      '<button formaction="javascript:alert(2)">b</button>\n\n' +
      '<a href="data:text/html,<script>alert(3)</script>">d</a>\n\n' +
      'Safe text.\n';
    const html = renderDocMarkdownToHtml(md);
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('alert(2)');
    expect(html.toLowerCase()).not.toContain('data:text/html');
    expect(html).toContain('Safe text.');
  });

  it('allows raster data:image srcs but strips SVG data:image srcs (FLUX-1699)', () => {
    const md =
      '![png](data:image/png;base64,iVBORw0KGgo=)\n\n' +
      '<img src="data:image/svg+xml,<svg onload=alert(1)>">\n';
    const html = renderDocMarkdownToHtml(md);
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(html.toLowerCase()).not.toContain('data:image/svg+xml');
    expect(html).not.toContain('alert(1)');
  });

  it('degrades an unresolved [[wiki-link]] to inert/plain text rather than throwing', () => {
    expect(() => renderDocMarkdownToHtml('See [[Some Missing Doc]] for details.\n')).not.toThrow();
    const html = renderDocMarkdownToHtml('See [[Some Missing Doc]] for details.\n');
    expect(html).toContain('Some Missing Doc');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('[object Object]');
  });

  it('never throws on empty or whitespace-only input', () => {
    expect(() => renderDocMarkdownToHtml('')).not.toThrow();
    expect(() => renderDocMarkdownToHtml('   \n\n  ')).not.toThrow();
    expect(renderDocMarkdownToHtml('')).toEqual(expect.any(String));
  });
});
