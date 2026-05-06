import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import TurndownService from 'turndown';
import { marked } from 'marked';
import { AlertCircle, Bold, Code, Eye, FileText, Heading1, Heading2, Info, Italic, Link as LinkIcon, List, ListOrdered, Pencil, Save, Trash2 } from 'lucide-react';
import { createDoc, deleteDoc, fetchDoc, fetchDocs, updateDoc } from '../api';
import { useApp } from '../AppContext';
import type { Doc } from '../types';
import { DocsSidebar } from './DocsSidebar';

marked.setOptions({ gfm: true, breaks: false });

function normalizeDocPathInput(value: string) {
  const normalized = value.replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '');
  if (!normalized) {
    return null;
  }

  const withoutExtension = normalized.toLowerCase().endsWith('.md') ? normalized.slice(0, -3) : normalized;
  const segments = withoutExtension.split('/').filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
    return null;
  }

  return segments.join('/');
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function humanizeDocPath(docPath: string) {
  const basename = docPath.split('/').filter(Boolean).pop() || 'untitled';
  return basename
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function normalizeMarkdownBody(markdown: string) {
  const normalized = markdown.replace(/\r\n/g, '\n').trimEnd();
  return normalized ? `${normalized}\n` : '';
}

function renderMarkdownToHtml(markdown: string) {
  const rendered = marked.parse(markdown) as string;
  return rendered || '<p></p>';
}

function parseOrderValue(value: string) {
  if (!value.trim()) {
    return undefined;
  }

  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : undefined;
}

function getFolderAncestors(docPath: string) {
  const segments = docPath.split('/').filter(Boolean);
  const ancestors: string[] = [];

  for (let index = 1; index < segments.length; index += 1) {
    ancestors.push(segments.slice(0, index).join('/'));
  }

  return ancestors;
}

function resolveWikiDocPath(target: string, docs: Doc[]) {
  const normalizedPath = normalizeDocPathInput(target);
  const targetSlug = slugify(target);

  if (normalizedPath) {
    const directPathMatch = docs.find((doc) => doc.path.toLowerCase() === normalizedPath.toLowerCase());
    if (directPathMatch) {
      return directPathMatch.path;
    }

    const basenamePathMatch = docs.find((doc) => doc.path.split('/').pop()?.toLowerCase() === normalizedPath.toLowerCase());
    if (basenamePathMatch) {
      return basenamePathMatch.path;
    }
  }

  const slugMatch = docs.find((doc) => doc.slug === targetSlug);
  if (slugMatch) {
    return slugMatch.path;
  }

  const titleMatch = docs.find((doc) => slugify(doc.title) === targetSlug);
  return titleMatch?.path || null;
}

function injectWikiLinks(markdown: string, docs: Doc[]) {
  return markdown.replace(/\[\[([^\]]+)\]\]/g, (_match, rawTarget: string) => {
    const label = rawTarget.trim();
    const resolvedPath = resolveWikiDocPath(label, docs);

    if (resolvedPath) {
      return `[${label}](wiki:${encodeURIComponent(resolvedPath)})`;
    }

    return `[${label}](broken:${encodeURIComponent(label)})`;
  });
}

function ToolbarButton({
  label,
  active = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex h-10 w-10 items-center justify-center rounded-xl border transition-colors ${active ? 'border-primary bg-primary/10 text-primary' : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-100 dark:border-white/10 dark:bg-black/20 dark:text-gray-300 dark:hover:bg-white/5'} ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
      title={label}
    >
      {children}
    </button>
  );
}

function DocsMarkdown({
  markdown,
  docs,
  onOpenDoc,
}: {
  markdown: string;
  docs: Doc[];
  onOpenDoc: (path: string) => void;
}) {
  return (
    <div className="prose prose-gray max-w-none text-gray-700 dark:prose-invert dark:text-gray-200">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="mb-4 text-3xl font-bold text-gray-900 dark:text-gray-100">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-3 mt-8 text-2xl font-semibold text-gray-900 dark:text-gray-100">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-2 mt-6 text-xl font-semibold text-gray-900 dark:text-gray-100">{children}</h3>,
          p: ({ children }) => <p className="mb-4 leading-7">{children}</p>,
          ul: ({ children }) => <ul className="mb-4 list-disc space-y-1 pl-6">{children}</ul>,
          ol: ({ children }) => <ol className="mb-4 list-decimal space-y-1 pl-6">{children}</ol>,
          blockquote: ({ children }) => <blockquote className="mb-4 rounded-r-2xl border-l-4 border-primary/40 bg-gray-50/70 px-4 py-3 italic dark:bg-white/5">{children}</blockquote>,
          code: ({ children, className }) => {
            const isBlockCode = Boolean(className?.includes('language-'));
            if (isBlockCode) {
              return <code className="block overflow-x-auto rounded-2xl bg-black/90 p-4 text-sm text-gray-100">{children}</code>;
            }

            return <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-800 dark:bg-black/30 dark:text-gray-100">{children}</code>;
          },
          pre: ({ children }) => <pre className="mb-4 overflow-x-auto rounded-2xl bg-black/90">{children}</pre>,
          a: ({ children, href }) => {
            if (!href) {
              return <span>{children}</span>;
            }

            if (href.startsWith('wiki:')) {
              const targetPath = decodeURIComponent(href.slice(5));
              return (
                <button
                  type="button"
                  onClick={() => onOpenDoc(targetPath)}
                  className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-sm font-semibold text-primary transition-colors hover:bg-primary/20"
                >
                  {children}
                </button>
              );
            }

            if (href.startsWith('broken:')) {
              const brokenTarget = decodeURIComponent(href.slice(7));
              return (
                <span
                  title={`Broken doc link: ${brokenTarget}`}
                  className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-sm font-semibold text-rose-700 dark:bg-rose-500/10 dark:text-rose-300"
                >
                  {children}
                  <AlertCircle className="h-3.5 w-3.5" />
                </span>
              );
            }

            return (
              <a className="inline-flex items-center gap-1 text-primary underline underline-offset-2" href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {injectWikiLinks(markdown || 'No content yet.', docs)}
      </ReactMarkdown>
    </div>
  );
}

export function DocsScreen() {
  const { currentUser, config } = useApp();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<Doc | null>(null);
  const [loadingDocs, setLoadingDocs] = useState(true);
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftOrder, setDraftOrder] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const [isCreateFormOpen, setIsCreateFormOpen] = useState(false);
  const [newDocPath, setNewDocPath] = useState('');
  const [newDocTitle, setNewDocTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [docsRefreshKey, setDocsRefreshKey] = useState(0);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; message: string } | null>(null);
  const turndownServiceRef = useRef(
    new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
    })
  );

  const canEditDocs = (config?.docsEditPermissions ?? 'all') === 'all'
    || (config?.docsAllowedUsers ?? []).includes(currentUser);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: 'Start writing. Use [[doc-name]] for internal links.' }),
    ],
    content: '<p></p>',
    editable: false,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'min-h-[26rem] rounded-[24px] border border-gray-200 bg-white px-5 py-4 text-base leading-7 text-gray-900 outline-none dark:border-white/10 dark:bg-black/20 dark:text-gray-100',
      },
    },
    onUpdate: ({ editor: activeEditor }) => {
      const nextMarkdown = normalizeMarkdownBody(turndownServiceRef.current.turndown(activeEditor.getHTML()));
      setDraftBody(nextMarkdown);
    },
  });

  const currentOrder = parseOrderValue(draftOrder);
  const normalizedDraftTitle = draftTitle.trim() || (selectedDoc ? humanizeDocPath(selectedDoc.path) : 'Untitled');
  const draftMarkdown = normalizeMarkdownBody(draftBody);
  const isDirty = Boolean(
    selectedDoc
    && (
      normalizedDraftTitle !== selectedDoc.title
      || currentOrder !== selectedDoc.order
      || draftMarkdown !== normalizeMarkdownBody(selectedDoc.body)
    )
  );
  const previewTitle = selectedDoc ? normalizedDraftTitle : 'Docs';
  const previewBody = draftMarkdown || selectedDoc?.body || '';

  useEffect(() => {
    let cancelled = false;

    const loadDocsList = async () => {
      setLoadingDocs(true);

      try {
        const loadedDocs = await fetchDocs();
        if (cancelled) {
          return;
        }

        setDocs(loadedDocs);
        setExpandedFolders((current) => {
          const nextFolders = { ...current };
          loadedDocs.forEach((doc) => {
            getFolderAncestors(doc.path).forEach((folderPath) => {
              if (!(folderPath in nextFolders)) {
                nextFolders[folderPath] = true;
              }
            });
          });
          return nextFolders;
        });

        if (loadedDocs.length === 0) {
          setSelectedPath(null);
          setSelectedDoc(null);
          setDraftTitle('');
          setDraftOrder('');
          setDraftBody('');
          setIsEditing(false);
          return;
        }

        if (!selectedPath || !loadedDocs.some((doc) => doc.path === selectedPath)) {
          setSelectedPath(loadedDocs[0].path);
        }
      } catch (error) {
        console.error(error);
        if (!cancelled) {
          setNotice({ tone: 'error', message: 'Failed to load docs from the engine.' });
        }
      } finally {
        if (!cancelled) {
          setLoadingDocs(false);
        }
      }
    };

    void loadDocsList();

    return () => {
      cancelled = true;
    };
  }, [docsRefreshKey]);

  useEffect(() => {
    if (!selectedPath) {
      setSelectedDoc(null);
      setDraftTitle('');
      setDraftOrder('');
      setDraftBody('');
      setLoadingDoc(false);
      return;
    }

    let cancelled = false;
    setLoadingDoc(true);

    const loadSelectedDoc = async () => {
      try {
        const loadedDoc = await fetchDoc(selectedPath);
        if (cancelled) {
          return;
        }

        setSelectedDoc(loadedDoc);
        setDraftTitle(loadedDoc.title);
        setDraftOrder(loadedDoc.order?.toString() ?? '');
        setDraftBody(normalizeMarkdownBody(loadedDoc.body));
        setIsEditing(false);
      } catch (error) {
        console.error(error);
        if (!cancelled) {
          setNotice({ tone: 'error', message: `Failed to load ${selectedPath}.` });
        }
      } finally {
        if (!cancelled) {
          setLoadingDoc(false);
        }
      }
    };

    void loadSelectedDoc();

    return () => {
      cancelled = true;
    };
  }, [selectedPath]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    editor.setEditable(isEditing && canEditDocs);

    if (!selectedDoc) {
      editor.commands.setContent('<p></p>');
      return;
    }

    editor.commands.setContent(renderMarkdownToHtml(draftMarkdown || selectedDoc.body));
  }, [editor, selectedDoc?.path, isEditing, canEditDocs]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isDirty) {
        return;
      }

      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [isDirty]);

  const confirmDiscardChanges = () => {
    if (!isDirty) {
      return true;
    }

    return window.confirm('Discard unsaved doc changes?');
  };

  const handleOpenDoc = (docPath: string) => {
    if (docPath === selectedPath) {
      return;
    }

    if (!confirmDiscardChanges()) {
      return;
    }

    setNotice(null);
    setSelectedPath(docPath);
  };

  const handleCreateDoc = async () => {
    if (!canEditDocs) {
      return;
    }

    const requestedPath = newDocPath.trim() || slugify(newDocTitle);
    const normalizedPath = normalizeDocPathInput(requestedPath);
    if (!normalizedPath) {
      setNotice({ tone: 'error', message: 'Enter a valid doc path before creating a page.' });
      return;
    }

    setCreating(true);
    setNotice(null);

    try {
      const createdDoc = await createDoc({
        path: normalizedPath,
        title: newDocTitle.trim() || humanizeDocPath(normalizedPath),
        body: '',
      });

      setIsCreateFormOpen(false);
      setNewDocPath('');
      setNewDocTitle('');
      setSelectedPath(createdDoc.path);
      setDocsRefreshKey((current) => current + 1);
      setNotice({ tone: 'success', message: `Created ${createdDoc.title}.` });
    } catch (error) {
      console.error(error);
      setNotice({ tone: 'error', message: 'Failed to create the new doc.' });
    } finally {
      setCreating(false);
    }
  };

  const handleSave = async () => {
    if (!selectedDoc || !canEditDocs) {
      return;
    }

    setSaving(true);
    setNotice(null);

    try {
      const updatedDoc = await updateDoc(selectedDoc.path, {
        title: normalizedDraftTitle,
        order: currentOrder ?? null,
        body: draftMarkdown,
      });

      setSelectedDoc(updatedDoc);
      setDocs((currentDocs) => currentDocs.map((doc) => doc.path === updatedDoc.path ? updatedDoc : doc));
      setDraftTitle(updatedDoc.title);
      setDraftOrder(updatedDoc.order?.toString() ?? '');
      setDraftBody(normalizeMarkdownBody(updatedDoc.body));
      setNotice({ tone: 'success', message: `Saved ${updatedDoc.title}.` });
    } catch (error) {
      console.error(error);
      setNotice({ tone: 'error', message: 'Failed to save the current doc.' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedDoc || !canEditDocs) {
      return;
    }

    const confirmed = window.confirm(`Delete ${selectedDoc.title}? This removes the markdown file from .docs.`);
    if (!confirmed) {
      return;
    }

    setDeleting(true);
    setNotice(null);

    try {
      const currentIndex = docs.findIndex((doc) => doc.path === selectedDoc.path);
      const remainingDocs = docs.filter((doc) => doc.path !== selectedDoc.path);
      const nextDoc = remainingDocs[currentIndex] || remainingDocs[currentIndex - 1] || remainingDocs[0] || null;

      await deleteDoc(selectedDoc.path);
      setSelectedPath(nextDoc?.path || null);
      setDocsRefreshKey((current) => current + 1);
      setNotice({ tone: 'success', message: `Deleted ${selectedDoc.title}.` });
    } catch (error) {
      console.error(error);
      setNotice({ tone: 'error', message: 'Failed to delete the current doc.' });
    } finally {
      setDeleting(false);
    }
  };

  const handleResetDraft = () => {
    if (!selectedDoc) {
      return;
    }

    setDraftTitle(selectedDoc.title);
    setDraftOrder(selectedDoc.order?.toString() ?? '');
    setDraftBody(normalizeMarkdownBody(selectedDoc.body));
    setIsEditing(false);
    setNotice(null);
  };

  const handleStartCreateForm = () => {
    if (!confirmDiscardChanges()) {
      return;
    }

    setIsCreateFormOpen(true);
    setNotice(null);
  };

  const handleCancelCreateForm = () => {
    setIsCreateFormOpen(false);
    setNewDocPath('');
    setNewDocTitle('');
  };

  const handleToggleFolder = (folderPath: string) => {
    setExpandedFolders((currentFolders) => ({
      ...currentFolders,
      [folderPath]: currentFolders[folderPath] === false,
    }));
  };

  const handleSetLink = () => {
    if (!editor) {
      return;
    }

    const existingLink = editor.getAttributes('link').href as string | undefined;
    const nextLink = window.prompt('Enter the link URL. Leave blank to remove the current link.', existingLink || '');
    if (nextLink === null) {
      return;
    }

    if (!nextLink.trim()) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }

    editor.chain().focus().extendMarkRange('link').setLink({ href: nextLink.trim() }).run();
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[340px,minmax(0,1fr)]">
      <DocsSidebar
        docs={docs}
        selectedPath={selectedPath}
        onSelectDoc={handleOpenDoc}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        expandedFolders={expandedFolders}
        onToggleFolder={handleToggleFolder}
        canCreate={canEditDocs}
        isCreateFormOpen={isCreateFormOpen}
        newDocPath={newDocPath}
        onNewDocPathChange={setNewDocPath}
        newDocTitle={newDocTitle}
        onNewDocTitleChange={setNewDocTitle}
        onOpenCreateForm={handleStartCreateForm}
        onCancelCreate={handleCancelCreateForm}
        onCreateDoc={handleCreateDoc}
        creating={creating}
      />

      <section className="rounded-[32px] border border-gray-200 bg-white/80 p-6 shadow-xl shadow-gray-200/60 dark:border-white/10 dark:bg-[#161720] dark:shadow-none">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-gray-200 pb-5 dark:border-white/10">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.22em] text-gray-500">
              <FileText className="h-4 w-4" />
              Documentation
            </div>
            <h1 className="truncate text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-100">{selectedDoc ? previewTitle : 'Documentation'}</h1>
            <p className="mt-2 text-sm text-gray-500">
              {selectedDoc ? `${selectedDoc.path}.md` : 'Select a document from the sidebar or create the first one.'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setIsEditing((current) => !current)}
              disabled={!selectedDoc || !canEditDocs}
              className={`flex items-center gap-2 rounded-2xl px-4 py-2 text-sm font-semibold transition-colors ${selectedDoc && canEditDocs ? 'border border-gray-200 text-gray-700 hover:bg-gray-100 dark:border-white/10 dark:text-gray-200 dark:hover:bg-white/5' : 'bg-gray-200 text-gray-400 dark:bg-white/10 dark:text-gray-500'}`}
            >
              {isEditing ? <Eye className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
              {isEditing ? 'Preview' : 'Edit'}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!selectedDoc || !canEditDocs || !isDirty || saving}
              className={`flex items-center gap-2 rounded-2xl px-4 py-2 text-sm font-semibold transition-colors ${selectedDoc && canEditDocs && isDirty ? 'bg-primary text-white hover:bg-primary-hover' : 'bg-gray-200 text-gray-400 dark:bg-white/10 dark:text-gray-500'}`}
            >
              <Save className="h-4 w-4" />
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={!selectedDoc || !canEditDocs || deleting}
              className={`flex items-center gap-2 rounded-2xl px-4 py-2 text-sm font-semibold transition-colors ${selectedDoc && canEditDocs ? 'border border-rose-200 text-rose-700 hover:bg-rose-50 dark:border-rose-500/20 dark:text-rose-300 dark:hover:bg-rose-500/10' : 'bg-gray-200 text-gray-400 dark:bg-white/10 dark:text-gray-500'}`}
            >
              <Trash2 className="h-4 w-4" />
              {deleting ? 'Deleting...' : 'Delete'}
            </button>
          </div>
        </div>

        <div className="mt-5 space-y-4">
          {notice && (
            <div className={`rounded-2xl border px-4 py-3 text-sm ${notice.tone === 'error' ? 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-200' : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200'}`}>
              {notice.message}
            </div>
          )}

          {!canEditDocs && (
            <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              Docs are read-only for {currentUser}. Switch Docs Permissions to `all` or add this user to the allowed list in Settings.
            </div>
          )}

          {selectedDoc && (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr),140px]">
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Title</label>
                <input
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  disabled={!canEditDocs}
                  className="w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm font-semibold outline-none focus:border-primary disabled:bg-gray-100 disabled:text-gray-500 dark:border-white/10 dark:bg-black/20 dark:disabled:bg-white/5"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Order</label>
                <input
                  type="number"
                  value={draftOrder}
                  onChange={(event) => setDraftOrder(event.target.value)}
                  disabled={!canEditDocs}
                  placeholder="Optional"
                  className="w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm font-semibold outline-none focus:border-primary disabled:bg-gray-100 disabled:text-gray-500 dark:border-white/10 dark:bg-black/20 dark:disabled:bg-white/5"
                />
              </div>
            </div>
          )}

          {selectedDoc && isEditing && canEditDocs && (
            <div className="flex flex-wrap items-center gap-2 rounded-[24px] border border-gray-200 bg-gray-50/80 px-4 py-3 dark:border-white/10 dark:bg-black/10">
              <ToolbarButton label="Bold" active={Boolean(editor?.isActive('bold'))} disabled={!editor} onClick={() => editor?.chain().focus().toggleBold().run()}>
                <Bold className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton label="Italic" active={Boolean(editor?.isActive('italic'))} disabled={!editor} onClick={() => editor?.chain().focus().toggleItalic().run()}>
                <Italic className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton label="Heading 1" active={Boolean(editor?.isActive('heading', { level: 1 }))} disabled={!editor} onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}>
                <Heading1 className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton label="Heading 2" active={Boolean(editor?.isActive('heading', { level: 2 }))} disabled={!editor} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>
                <Heading2 className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton label="Bullet List" active={Boolean(editor?.isActive('bulletList'))} disabled={!editor} onClick={() => editor?.chain().focus().toggleBulletList().run()}>
                <List className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton label="Numbered List" active={Boolean(editor?.isActive('orderedList'))} disabled={!editor} onClick={() => editor?.chain().focus().toggleOrderedList().run()}>
                <ListOrdered className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton label="Code Block" active={Boolean(editor?.isActive('codeBlock'))} disabled={!editor} onClick={() => editor?.chain().focus().toggleCodeBlock().run()}>
                <Code className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton label="Link" active={Boolean(editor?.isActive('link'))} disabled={!editor} onClick={handleSetLink}>
                <LinkIcon className="h-4 w-4" />
              </ToolbarButton>
              {isDirty && (
                <button
                  type="button"
                  onClick={handleResetDraft}
                  className="ml-auto rounded-2xl border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-600 transition-colors hover:bg-gray-100 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
                >
                  Reset Draft
                </button>
              )}
            </div>
          )}

          {loadingDocs || loadingDoc ? (
            <div className="rounded-[28px] border border-dashed border-gray-200 px-6 py-10 text-center text-sm text-gray-500 dark:border-white/10">
              Loading docs...
            </div>
          ) : !selectedDoc ? (
            <div className="rounded-[28px] border border-dashed border-gray-200 px-6 py-12 text-center text-sm text-gray-500 dark:border-white/10">
              Select a document from the sidebar or create a new one.
            </div>
          ) : isEditing && canEditDocs ? (
            <div className="space-y-3">
              <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-200">
                Type `[[doc-name]]` to create internal wiki links. They will resolve to other docs when you switch back to preview mode.
              </div>
              <EditorContent editor={editor} />
            </div>
          ) : (
            <div className="rounded-[28px] border border-gray-200 bg-gray-50/70 px-6 py-6 dark:border-white/10 dark:bg-black/10">
              <DocsMarkdown markdown={previewBody} docs={docs} onOpenDoc={handleOpenDoc} />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}