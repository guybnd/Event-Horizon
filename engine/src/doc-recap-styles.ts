// FLUX-1667 — sync counterpart of portal/src/index.css's `.docs-editor-content` prose block (the
// same pattern doc-render.ts follows for its own portal-mirroring pipeline: keep these two rules
// in sync if either changes). Reproduced as plain CSS (no Tailwind @apply, no build step) because
// this is inlined into a standalone, self-contained doc-recap artifact document served straight to
// a sandboxed iframe — v1 is intentionally engine-owned rather than shared via import across the
// engine/portal build boundary. Colors/spacing approximate the portal's Tailwind gray/primary
// scale; the primary accent (#6366f1) and dark-mode palette (#0b1220/#e5e7eb/#334155) match the
// indigo/dark tokens already used by ARTIFACT_ANNOTATOR_SCRIPT in artifacts.ts so an artifact's
// injected UI and its doc-recap prose read as one consistent surface.
export const DOC_RECAP_CSS = `
:root { color-scheme: light dark; }
body {
  margin: 0;
  padding: 24px;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: #111827;
  background: #ffffff;
}
.docs-editor-content > *:first-child { margin-top: 0; }
.docs-editor-content > *:last-child { margin-bottom: 0; }
.docs-editor-content p { margin: 0.75rem 0; }
.docs-editor-content strong { font-weight: 700; }
.docs-editor-content em { font-style: italic; }
.docs-editor-content h1 { margin: 1.5rem 0 0.75rem; font-size: 1.875rem; line-height: 2.25rem; font-weight: 700; letter-spacing: -0.025em; color: #030712; }
.docs-editor-content h2 { margin: 1.5rem 0 0.75rem; font-size: 1.5rem; line-height: 2rem; font-weight: 600; color: #111827; }
.docs-editor-content h3 { margin: 1.25rem 0 0.5rem; font-size: 1.25rem; line-height: 1.75rem; font-weight: 600; color: #111827; }
.docs-editor-content ul { margin: 1rem 0; padding-left: 1.5rem; list-style-type: disc; }
.docs-editor-content ol { margin: 1rem 0; padding-left: 1.5rem; list-style-type: decimal; }
.docs-editor-content li { margin: 0.25rem 0; }
.docs-editor-content blockquote {
  margin: 1rem 0;
  border-left: 4px solid rgba(99, 102, 241, 0.4);
  border-top-right-radius: 1rem;
  border-bottom-right-radius: 1rem;
  background: #f9fafb;
  padding: 0.75rem 1rem;
  font-style: italic;
  color: #374151;
}
.docs-editor-content pre {
  margin: 1rem 0;
  overflow-x: auto;
  border-radius: 1rem;
  background: #030712;
  padding: 0.75rem 1rem;
  font-size: 0.875rem;
  line-height: 1.25rem;
  color: #f3f4f6;
}
.docs-editor-content pre code { background: transparent; padding: 0; color: inherit; }
.docs-editor-content :not(pre) > code {
  border-radius: 0.375rem;
  background: #f3f4f6;
  padding: 0.125rem 0.375rem;
  font-size: 0.9em;
  color: #1f2937;
}
.docs-editor-content a { cursor: pointer; font-weight: 600; text-decoration: underline; text-underline-offset: 2px; }
.docs-editor-content a[href^="wiki:"] {
  border-radius: 9999px;
  background: rgba(99, 102, 241, 0.1);
  padding: 0.125rem 0.5rem;
  color: #6366f1;
  text-decoration: none;
}
.docs-editor-content a[href^="wiki:"]:hover { background: rgba(99, 102, 241, 0.15); }
.docs-editor-content a[href^="broken:"] {
  border-radius: 9999px;
  background: #ffe4e6;
  padding: 0.125rem 0.5rem;
  color: #be123c;
  text-decoration: none;
}
.docs-editor-content img {
  margin: 1rem 0;
  max-height: 32rem;
  width: 100%;
  border-radius: 1rem;
  border: 1px solid #e5e7eb;
  background: #ffffff;
  object-fit: contain;
}
.docs-editor-content table { margin: 1rem 0; width: 100%; border-collapse: collapse; overflow: hidden; border-radius: 1rem; }
.docs-editor-content th { border: 1px solid #e5e7eb; background: #f3f4f6; padding: 0.5rem 0.75rem; text-align: left; font-weight: 600; }
.docs-editor-content td { border: 1px solid #e5e7eb; padding: 0.5rem 0.75rem; vertical-align: top; }
.docs-editor-content table p { margin: 0; }
.docs-editor-content .eh-mermaid-diagram { margin: 1rem 0; }
.docs-editor-content .eh-mermaid-diagram svg { max-width: 100%; height: auto; }
.docs-editor-content .mermaid-error {
  margin: 1rem 0;
  border-radius: 0.5rem;
  border: 1px solid #fecaca;
  background: #fef2f2;
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  color: #b91c1c;
}

@media (prefers-color-scheme: dark) {
  body { color: #e5e7eb; background: #0b1220; }
  .docs-editor-content h1 { color: #ffffff; }
  .docs-editor-content h2 { color: #f9fafb; }
  .docs-editor-content h3 { color: #f3f4f6; }
  .docs-editor-content blockquote { background: rgba(255, 255, 255, 0.05); color: #e5e7eb; }
  .docs-editor-content :not(pre) > code { background: rgba(255, 255, 255, 0.1); color: #f3f4f6; }
  .docs-editor-content a[href^="broken:"] { background: rgba(244, 63, 94, 0.1); color: #fda4af; }
  .docs-editor-content img { border-color: rgba(255, 255, 255, 0.1); background: rgba(0, 0, 0, 0.2); }
  .docs-editor-content th { border-color: rgba(255, 255, 255, 0.1); background: rgba(255, 255, 255, 0.05); }
  .docs-editor-content td { border-color: rgba(255, 255, 255, 0.1); }
  .docs-editor-content .mermaid-error { border-color: rgba(244, 63, 94, 0.4); background: rgba(244, 63, 94, 0.1); color: #fda4af; }
}
`;
