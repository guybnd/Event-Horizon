import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableCell } from '@tiptap/extension-table-cell';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { marked } from 'marked';
import { AlertCircle, Bold, Code, FileText, Heading1, Heading2, Info, Italic, Link as LinkIcon, List, ListOrdered, Lock, Network, Save, Share2, Trash2 } from 'lucide-react';
import { createDoc, deleteDoc, fetchDoc, fetchDocs, fetchGroupStatus, updateDoc } from '../api';
import { useApp } from '../AppContext';
import type { Doc } from '../types';
import type { GroupStatus } from '../api';
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

function createTurndownService() {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });

  service.use(gfm);

  service.addRule('wiki-links', {
    filter: (node) => {
      if (!(node instanceof HTMLElement) || node.tagName !== 'A') {
        return false;
      }

      const href = node.getAttribute('href') || '';
      return href.startsWith('wiki:') || href.startsWith('broken:');
    },
    replacement: (content, node) => {
      const href = (node as HTMLElement).getAttribute('href') || '';

      if (href.startsWith('broken:')) {
        return `[[${decodeURIComponent(href.slice(7)) || content}]]`;
      }

      return `[[${content || decodeURIComponent(href.slice(5))}]]`;
    },
  });

  return service;
}

function renderMarkdownToHtml(markdown: string, docs: Doc[]) {
  const rendered = marked.parse(injectWikiLinks(markdown, docs)) as string;
  return rendered || '<p></p>';
}

function getEditorDocumentSnapshot(editor: { getJSON: () => unknown }) {
  return JSON.stringify(editor.getJSON());
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

function getWikiLinkDefinition(target: string, docs: Doc[]) {
  const label = target.trim();
  const resolvedPath = resolveWikiDocPath(label, docs);

  return {
    label,
    resolvedPath,
    href: resolvedPath ? `wiki:${encodeURIComponent(resolvedPath)}` : `broken:${encodeURIComponent(label)}`,
  };
}

function injectWikiLinks(markdown: string, docs: Doc[]) {
  return markdown.replace(/\[\[([^\]]+)\]\]/g, (_match, rawTarget: string) => {
    const link = getWikiLinkDefinition(rawTarget, docs);

    if (!link.label) {
      return _match;
    }

    return `[${link.label}](${link.href})`;
  });
}

function getBrokenWikiLinks(markdown: string, docs: Doc[]) {
  const brokenTargets = new Set<string>();

  markdown.replace(/\[\[([^\]]+)\]\]/g, (_match, rawTarget: string) => {
    const label = rawTarget.trim();
    if (label && !resolveWikiDocPath(label, docs)) {
      brokenTargets.add(label);
    }

    return _match;
  });

  return Array.from(brokenTargets);
}

function getBreadcrumbs(docPath: string) {
  return docPath.split('/').filter(Boolean);
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

export function DocsScreen() {
  const { currentUser, config, workspacePath, setView } = useApp();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get('doc')
  );
  const [selectedDoc, setSelectedDoc] = useState<Doc | null>(null);
  const [loadingDocs, setLoadingDocs] = useState(true);
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const [createTargetFolder, setCreateTargetFolder] = useState<string | null>(null);
  const [newDocPath, setNewDocPath] = useState('');
  const [newDocTitle, setNewDocTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [docsRefreshKey, setDocsRefreshKey] = useState(0);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; message: string } | null>(null);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editorSnapshot, setEditorSnapshot] = useState('');
  const [isEditorFocused, setIsEditorFocused] = useState(false);
  const [hasTextSelection, setHasTextSelection] = useState(false);
  const turndownServiceRef = useRef<TurndownService | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const baselineEditorSnapshotRef = useRef('');
  const isApplyingEditorContentRef = useRef(false);
  const lastSyncedDocSignatureRef = useRef<string | null>(null);
  const loadedDocsRef = useRef<Doc[]>([]);
  const [groupStatus, setGroupStatus] = useState<GroupStatus | null>(null);

  if (!turndownServiceRef.current) {
    turndownServiceRef.current = createTurndownService();
  }

  const canEditDocs = (config?.docsEditPermissions ?? 'all') === 'all'
    || (config?.docsAllowedUsers ?? []).includes(currentUser);
  const isSelectedDocReadOnly = selectedDoc?.readOnly === true;
  const canEditSelectedDoc = canEditDocs && !isSelectedDocReadOnly;
  const brokenWikiLinks = selectedDoc ? getBrokenWikiLinks(draftBody, docs) : [];
  const breadcrumbs = selectedDoc ? getBreadcrumbs(selectedDoc.path) : [];
  const showToolbarActiveState = isEditorFocused && hasTextSelection;

  // Cross-project feature map (FLUX-403): the read-only group feature docs live
  // under `<docsLabel>/features/*`. Surface them as cards on the docs landing view.
  const groupDocsLabel = groupStatus?.docsLabel ?? 'Product';
  const featureDocs = useMemo(
    () =>
      docs
        .filter((doc) => doc.path.startsWith(`${groupDocsLabel}/features/`))
        .sort((left, right) => left.title.localeCompare(right.title, undefined, { sensitivity: 'base' })),
    [docs, groupDocsLabel],
  );
  const groupMembers = groupStatus?.members ?? [];
  const isInGroup = groupStatus?.configured === true || groupStatus?.membership != null;
  const showFeatureMap = isInGroup && featureDocs.length > 0;
  // Promotion discoverability (FLUX-416): on a group parent, a repo-local `.docs/`
  // doc (anything outside the `<docsLabel>/` group tree) is NOT shared with members
  // until it's promoted. Nudge toward the promotion panel so this isn't mistaken
  // for a sync bug.
  const isGroupParent = groupStatus?.configured === true;
  const selectedDocIsGroupDoc = selectedDoc != null && selectedDoc.path.startsWith(`${groupDocsLabel}/`);
  const showPromoteHint = isGroupParent && selectedDoc != null && !selectedDocIsGroupDoc && !isSelectedDocReadOnly;
  const participatingMembers = (doc: Doc) => {
    const haystack = `${doc.title}\n${doc.body ?? ''}`.toLowerCase();
    return groupMembers.filter((member) => haystack.includes(member.name.toLowerCase()));
  };
  const featureSummary = (doc: Doc) => {
    const line = (doc.body ?? '')
      .split('\n')
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0 && !entry.startsWith('#'));
    return line ? line.replace(/[*_`>[\]]/g, '').slice(0, 160) : 'No description yet.';
  };

  const syncEditorSelectionState = (activeEditor: NonNullable<typeof editor>) => {
    const { from, to } = activeEditor.state.selection;
    setHasTextSelection(from !== to);
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        link: {
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
          defaultProtocol: 'https',
          isAllowedUri: (url, { defaultValidate }) => url.startsWith('wiki:') || url.startsWith('broken:') || defaultValidate(url),
        },
      }),
      Placeholder.configure({ placeholder: 'Start writing. Use [[doc-name]] for internal links.' }),
      Table.configure({ resizable: false, HTMLAttributes: { class: 'docs-table' } }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content: '<p></p>',
    editable: false,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'docs-editor-content min-h-[26rem] rounded-[24px] border border-gray-200 bg-white px-5 py-4 text-base leading-7 text-gray-900 outline-none dark:border-white/10 dark:bg-black/20 dark:text-gray-100',
      },
    },
    onUpdate: ({ editor: activeEditor }) => {
      if (isApplyingEditorContentRef.current) {
        return;
      }

      setEditorSnapshot(getEditorDocumentSnapshot(activeEditor));
      const nextMarkdown = normalizeMarkdownBody(turndownServiceRef.current?.turndown(activeEditor.getHTML()) || '');
      setDraftBody(nextMarkdown);
    },
    onSelectionUpdate: ({ editor: activeEditor }) => {
      syncEditorSelectionState(activeEditor);
    },
    onFocus: ({ editor: activeEditor }) => {
      setIsEditorFocused(true);
      syncEditorSelectionState(activeEditor);
    },
    onBlur: () => {
      setIsEditorFocused(false);
      setHasTextSelection(false);
    },
  });

  const setEditorContentSafely = (html: string) => {
    if (!editor) {
      return '';
    }

    isApplyingEditorContentRef.current = true;
    editor.commands.setContent(html, { emitUpdate: false });
    const nextSnapshot = getEditorDocumentSnapshot(editor);
    setEditorSnapshot(nextSnapshot);
    syncEditorSelectionState(editor);
    queueMicrotask(() => {
      isApplyingEditorContentRef.current = false;
    });

    return nextSnapshot;
  };

  const normalizedDraftTitle = draftTitle.trim() || (selectedDoc ? humanizeDocPath(selectedDoc.path) : 'Untitled');
  const draftMarkdown = normalizeMarkdownBody(draftBody);
  const isDirty = Boolean(
    selectedDoc
    && (
      normalizedDraftTitle !== selectedDoc.title
      || editorSnapshot !== baselineEditorSnapshotRef.current
    )
  );

  useEffect(() => {
    if (!isEditingTitle) {
      return;
    }

    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [isEditingTitle]);

  useEffect(() => {
    const handleCustomNavigation = () => {
      const initialDoc = new URLSearchParams(window.location.search).get('doc');
      if (initialDoc && loadedDocsRef.current.some(d => d.path === initialDoc)) {
        setSelectedPath(initialDoc);
      }
    };
    
    window.addEventListener('flux:navigate', handleCustomNavigation);
    return () => window.removeEventListener('flux:navigate', handleCustomNavigation);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadDocsList = async () => {
      setLoadingDocs(true);

      try {
        const loadedDocs = await fetchDocs();
        if (cancelled) {
          return;
        }

        loadedDocsRef.current = loadedDocs;
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
          setDraftBody('');
          setIsEditingTitle(false);
          return;
        }

        const initialDoc = new URLSearchParams(window.location.search).get('doc');
        const currentlySelected = selectedPath || initialDoc;
        if (!currentlySelected || !loadedDocs.some((doc) => doc.path === currentlySelected)) {
          setSelectedPath(loadedDocs[0].path);
        } else if (initialDoc && !selectedPath) {
          setSelectedPath(initialDoc);
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
  }, [docsRefreshKey, workspacePath]);

  useEffect(() => {
    if (!selectedPath) {
      const url = new URL(window.location.href);
      url.searchParams.delete('doc');
      window.history.replaceState({}, '', url);
      setSelectedDoc(null);
      setDraftTitle('');
      setDraftBody('');
      setIsEditingTitle(false);
      setLoadingDoc(false);
      return;
    }

    const url = new URL(window.location.href);
    url.searchParams.set('doc', selectedPath);
    window.history.replaceState({}, '', url);

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
        setDraftBody(normalizeMarkdownBody(loadedDoc.body));
        setIsEditingTitle(false);
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
  }, [selectedPath, workspacePath]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    editor.setEditable(Boolean(selectedDoc) && canEditSelectedDoc);

    if (!selectedDoc) {
      if (lastSyncedDocSignatureRef.current !== '__empty__') {
        lastSyncedDocSignatureRef.current = '__empty__';
        baselineEditorSnapshotRef.current = setEditorContentSafely('<p></p>');
      }
      return;
    }

    const normalizedBody = normalizeMarkdownBody(selectedDoc.body);
    const docSignature = `${selectedDoc.path}\u0000${normalizedBody}`;

    if (lastSyncedDocSignatureRef.current === docSignature) {
      return;
    }

    lastSyncedDocSignatureRef.current = docSignature;
    baselineEditorSnapshotRef.current = setEditorContentSafely(renderMarkdownToHtml(normalizedBody, docs));
  }, [editor, selectedDoc?.path, selectedDoc?.body, canEditSelectedDoc, docs]);

  useEffect(() => {
    let cancelled = false;
    fetchGroupStatus()
      .then((status) => { if (!cancelled) setGroupStatus(status); })
      .catch(() => { if (!cancelled) setGroupStatus(null); });
    return () => { cancelled = true; };
  }, [workspacePath]);

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

  const handleOpenCreateForm = (folderPath: string) => {
    if (!confirmDiscardChanges()) {
      return;
    }

    setCreateTargetFolder(folderPath);
    setNewDocPath('');
    setNewDocTitle('');
    setNotice(null);
  };

  const handleCreateDoc = async () => {
    if (!canEditDocs) {
      return;
    }

    const requestedPath = newDocPath.trim() || slugify(newDocTitle);
    const normalizedRelativePath = normalizeDocPathInput(requestedPath);
    const normalizedPath = normalizeDocPathInput(
      createTargetFolder && createTargetFolder.length > 0
        ? `${createTargetFolder}/${normalizedRelativePath || ''}`
        : requestedPath,
    );

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

      setCreateTargetFolder(null);
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

  const handleReorderDocs = async (_directory: string, orderedPaths: string[]) => {
    if (!canEditDocs || orderedPaths.length < 2) {
      return;
    }

    const previousDocs = docs;
    const previousSelectedDoc = selectedDoc;
    const orderByPath = new Map(orderedPaths.map((path, index) => [path, index + 1] as const));

    setDocs((currentDocs) => currentDocs.map((doc) => (
      orderByPath.has(doc.path)
        ? { ...doc, order: orderByPath.get(doc.path) }
        : doc
    )));

    if (selectedDoc && orderByPath.has(selectedDoc.path)) {
      setSelectedDoc({ ...selectedDoc, order: orderByPath.get(selectedDoc.path) });
    }

    try {
      const updatedDocs = await Promise.all(
        orderedPaths.map((path, index) => updateDoc(path, { order: index + 1 }))
      );
      const updatedDocMap = new Map(updatedDocs.map((doc) => [doc.path, doc]));

      setDocs((currentDocs) => currentDocs.map((doc) => updatedDocMap.get(doc.path) || doc));

      if (selectedPath && updatedDocMap.has(selectedPath)) {
        setSelectedDoc(updatedDocMap.get(selectedPath) || null);
      }
    } catch (error) {
      console.error(error);
      setDocs(previousDocs);
      setSelectedDoc(previousSelectedDoc);
      setNotice({ tone: 'error', message: 'Failed to save the new sidebar order.' });
    }
  };

  const handleSave = async () => {
    if (!selectedDoc || !canEditSelectedDoc) {
      return;
    }

    setSaving(true);
    setNotice(null);

    try {
      const updatedDoc = await updateDoc(selectedDoc.path, {
        title: normalizedDraftTitle,
        body: draftMarkdown,
      });

      setSelectedDoc(updatedDoc);
      setDocs((currentDocs) => currentDocs.map((doc) => doc.path === updatedDoc.path ? updatedDoc : doc));
      setDraftTitle(updatedDoc.title);
      setDraftBody(normalizeMarkdownBody(updatedDoc.body));
      baselineEditorSnapshotRef.current = editor ? getEditorDocumentSnapshot(editor) : editorSnapshot;
      lastSyncedDocSignatureRef.current = `${updatedDoc.path}\u0000${normalizeMarkdownBody(updatedDoc.body)}`;
      setIsEditingTitle(false);
      setNotice({ tone: 'success', message: `Saved ${updatedDoc.title}.` });
    } catch (error) {
      console.error(error);
      setNotice({ tone: 'error', message: 'Failed to save the current doc.' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedDoc || !canEditSelectedDoc) {
      return;
    }

    const confirmed = window.confirm(`Delete ${selectedDoc.title}? This removes the markdown file from the workspace.`);
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
    const normalizedBody = normalizeMarkdownBody(selectedDoc.body);
    setDraftBody(normalizedBody);
    lastSyncedDocSignatureRef.current = `${selectedDoc.path}\u0000${normalizedBody}`;
    baselineEditorSnapshotRef.current = setEditorContentSafely(renderMarkdownToHtml(normalizedBody, docs));
    setIsEditingTitle(false);
    setNotice(null);
  };

  const handleCancelCreateForm = () => {
    setCreateTargetFolder(null);
    setNewDocPath('');
    setNewDocTitle('');
  };

  const handleToggleFolder = (folderPath: string) => {
    setExpandedFolders((currentFolders) => ({
      ...currentFolders,
      [folderPath]: currentFolders[folderPath] === false,
    }));
  };

  const handleEditorClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest('a');
    if (!anchor) {
      return;
    }

    const href = anchor.getAttribute('href') || '';
    if (href.startsWith('wiki:')) {
      event.preventDefault();
      handleOpenDoc(decodeURIComponent(href.slice(5)));
      return;
    }

    if (href.startsWith('broken:')) {
      event.preventDefault();
      setNotice({ tone: 'error', message: `No doc found for ${decodeURIComponent(href.slice(7))}.` });
      return;
    }

    if (href) {
      event.preventDefault();
      window.open(href, '_blank', 'noopener,noreferrer');
    }
  };

  const handleInsertWikiLink = () => {
    if (!editor || !canEditSelectedDoc) {
      return;
    }

    const selectionText = editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, ' ');
    const nextTarget = window.prompt('Enter the doc path or title to link with wiki syntax.', selectionText || '');
    if (!nextTarget || !nextTarget.trim()) {
      return;
    }

    const link = getWikiLinkDefinition(nextTarget, docs);
    const linkedDoc = link.resolvedPath ? docs.find((doc) => doc.path === link.resolvedPath) : null;
    const linkText = selectionText.trim() || linkedDoc?.title || link.label;
    const chain = editor.chain().focus();

    if (editor.state.selection.empty) {
      chain.insertContent({
        type: 'text',
        text: linkText,
        marks: [{ type: 'link', attrs: { href: link.href } }],
      });
    } else {
      chain.extendMarkRange('link').setLink({ href: link.href });
    }

    chain.run();
  };

  const stopEditingTitle = (mode: 'save' | 'cancel' = 'save') => {
    if (mode === 'cancel' && selectedDoc) {
      setDraftTitle(selectedDoc.title);
    }

    setIsEditingTitle(false);
  };

  const handleTitleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      stopEditingTitle('save');
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      stopEditingTitle('cancel');
    }
  };

  const handleSetLink = () => {
    if (!editor || !canEditSelectedDoc) {
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
    <div className="grid gap-6 xl:grid-cols-[minmax(18rem,20%)_minmax(0,1fr)]">
      <div className="space-y-4">
        {groupStatus?.membership?.role === 'member' && (
          <div className="rounded-[28px] border border-sky-200 bg-sky-50/60 p-4 dark:border-sky-500/20 dark:bg-sky-500/5">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-sky-100 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300">
                <Network className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h2 className="truncate text-sm font-bold text-gray-900 dark:text-gray-100">Part of “{groupStatus.membership.groupName}”</h2>
                <p className="text-[11px] text-gray-500">
                  This repo is the
                  <span className="font-semibold text-gray-700 dark:text-gray-300"> {groupStatus.membership.memberName}</span>
                  {groupStatus.membership.memberRole ? ` (${groupStatus.membership.memberRole})` : ''} member.
                  The <code className="font-mono">{groupDocsLabel}/</code> tree below is the shared cross-project knowledge base. Edits route to the group parent.
                </p>
              </div>
            </div>
          </div>
        )}
        {groupStatus?.configured && (
          <div className="rounded-[28px] border border-gray-200 bg-white/80 p-4 shadow-xl shadow-gray-200/60 dark:border-white/10 dark:bg-[#161720] dark:shadow-none">
            <div className="flex items-center gap-3 border-b border-gray-200 pb-3 dark:border-white/10">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-sky-100 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300">
                <Network className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h2 className="truncate text-sm font-bold text-gray-900 dark:text-gray-100">{groupStatus.name}</h2>
                <p className="text-[11px] text-gray-500">Multi-repo group · {groupStatus.members?.length ?? 0} member(s)</p>
              </div>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-gray-500">
              The <code className="font-mono">{groupDocsLabel}/</code> tree is this group’s shared cross-project knowledge base (the canonical <code className="font-mono">.flux-group</code> store). As the parent you can edit it inline here; saving fans the change out to every member.
            </p>
            <ul className="mt-3 space-y-2">
              {(groupStatus.members ?? []).map((member) => (
                <li key={member.name} className="flex items-center justify-between gap-2 text-xs">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${member.pathExists ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-white/20'}`} title={member.pathExists ? 'Checked out' : 'Not checked out'} />
                    <span className="truncate font-semibold text-gray-800 dark:text-gray-200">{member.name}</span>
                  </span>
                  <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-white/10 dark:text-gray-300">{member.role}</span>
                </li>
              ))}
            </ul>
            {showFeatureMap && selectedPath && (
              <button
                type="button"
                onClick={() => { if (confirmDiscardChanges()) setSelectedPath(null); }}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-sky-200 px-3 py-2 text-xs font-semibold text-sky-700 transition-colors hover:bg-sky-50 dark:border-sky-500/20 dark:text-sky-300 dark:hover:bg-sky-500/10"
              >
                <Network className="h-3.5 w-3.5" />
                View feature map
              </button>
            )}
          </div>
        )}
        <DocsSidebar
          docs={docs}
          selectedPath={selectedPath}
          onSelectDoc={handleOpenDoc}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          expandedFolders={expandedFolders}
          onToggleFolder={handleToggleFolder}
          canCreate={canEditDocs}
          createTargetFolder={createTargetFolder}
          newDocPath={newDocPath}
          onNewDocPathChange={setNewDocPath}
          newDocTitle={newDocTitle}
          onNewDocTitleChange={setNewDocTitle}
          onOpenCreateForm={handleOpenCreateForm}
          onCancelCreate={handleCancelCreateForm}
          onCreateDoc={handleCreateDoc}
          onReorderDocs={handleReorderDocs}
          creating={creating}
          readOnlyPrefix={groupStatus?.membership?.role === 'member' ? groupDocsLabel : undefined}
        />
      </div>

      <section className="rounded-[32px] border border-gray-200 bg-white/80 p-6 shadow-xl shadow-gray-200/60 dark:border-white/10 dark:bg-[#161720] dark:shadow-none">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-gray-200 pb-5 dark:border-white/10">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.22em] text-gray-500">
              <FileText className="h-4 w-4" />
              Documentation
            </div>
            {selectedDoc ? (
              isEditingTitle && canEditSelectedDoc ? (
                <input
                  ref={titleInputRef}
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  onBlur={() => stopEditingTitle('save')}
                  onKeyDown={handleTitleKeyDown}
                  className="w-full max-w-2xl rounded-2xl border border-gray-200 bg-white px-4 py-2 text-3xl font-bold tracking-tight text-gray-900 outline-none focus:border-primary dark:border-white/10 dark:bg-black/20 dark:text-gray-100"
                />
              ) : (
                <h1 className="truncate text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-100">
                  {canEditSelectedDoc ? (
                    <button
                      type="button"
                      onClick={() => setIsEditingTitle(true)}
                      className="-ml-2 rounded-xl px-2 py-1 text-left transition-colors hover:bg-gray-100 dark:hover:bg-white/5"
                    >
                      {normalizedDraftTitle}
                    </button>
                  ) : (
                    normalizedDraftTitle
                  )}
                </h1>
              )
            ) : (
              <h1 className="truncate text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-100">Documentation</h1>
            )}
            <p className="mt-2 text-sm text-gray-500">
              {selectedDoc ? `${selectedDoc.path}.md` : 'Select a document from the sidebar or create the first one.'}
            </p>
            {selectedDoc && breadcrumbs.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400">
                {breadcrumbs.map((segment, index) => (
                  <span key={`${segment}-${index}`} className="flex items-center gap-2">
                    {index > 0 && <span className="text-gray-300 dark:text-gray-600">/</span>}
                    <span>{segment}</span>
                  </span>
                ))}
                {isDirty && <span className="rounded-full bg-amber-100 px-2 py-1 text-[10px] text-amber-700 dark:bg-amber-500/10 dark:text-amber-200">Unsaved</span>}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={!selectedDoc || !canEditSelectedDoc || !isDirty || saving}
              className={`flex items-center gap-2 rounded-2xl px-4 py-2 text-sm font-semibold transition-colors ${selectedDoc && canEditSelectedDoc && isDirty ? 'bg-primary text-white hover:bg-primary-hover' : 'bg-gray-200 text-gray-400 dark:bg-white/10 dark:text-gray-500'}`}
            >
              <Save className="h-4 w-4" />
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={!selectedDoc || !canEditSelectedDoc || deleting}
              className={`flex items-center gap-2 rounded-2xl px-4 py-2 text-sm font-semibold transition-colors ${selectedDoc && canEditSelectedDoc ? 'border border-rose-200 text-rose-700 hover:bg-rose-50 dark:border-rose-500/20 dark:text-rose-300 dark:hover:bg-rose-500/10' : 'bg-gray-200 text-gray-400 dark:bg-white/10 dark:text-gray-500'}`}
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

          {selectedDoc && isSelectedDocReadOnly && (
            <div className="flex items-start gap-3 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-200">
              <Lock className="mt-0.5 h-4 w-4 shrink-0" />
              This is a read-only cross-project group doc. Edits are authored in the group's parent repo and fanned out to members.
            </div>
          )}

          {showPromoteHint && (
            <div className="flex flex-wrap items-start gap-3 rounded-2xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-800 dark:border-indigo-500/20 dark:bg-indigo-500/10 dark:text-indigo-200">
              <Share2 className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="flex-1 min-w-0">
                This doc is local to this repo — it isn't shared with the group. Only docs under <code className="font-mono">{groupDocsLabel}/</code> fan out to members. Promote it to share it across the group.
              </div>
              <button
                type="button"
                onClick={() => setView('settings')}
                className="shrink-0 rounded-xl border border-indigo-300 bg-white/60 px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-white dark:border-indigo-500/30 dark:bg-white/5 dark:text-indigo-200 dark:hover:bg-white/10"
              >
                Promote doc…
              </button>
            </div>
          )}

          {!canEditDocs && (
            <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              Docs are read-only for {currentUser}. The wiki editor stays visible, but only users allowed by Docs Permissions can change or save content.
            </div>
          )}

          {selectedDoc && canEditSelectedDoc && (
            <div className="sticky top-4 z-20 flex flex-wrap items-center gap-2 rounded-[24px] border border-gray-200 bg-gray-50/90 px-4 py-3 shadow-sm backdrop-blur dark:border-white/10 dark:bg-[#161720]/90">
              <ToolbarButton label="Bold" active={showToolbarActiveState && Boolean(editor?.isActive('bold'))} disabled={!editor} onClick={() => editor?.chain().focus().toggleBold().run()}>
                <Bold className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton label="Italic" active={showToolbarActiveState && Boolean(editor?.isActive('italic'))} disabled={!editor} onClick={() => editor?.chain().focus().toggleItalic().run()}>
                <Italic className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton label="Heading 1" active={showToolbarActiveState && Boolean(editor?.isActive('heading', { level: 1 }))} disabled={!editor} onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}>
                <Heading1 className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton label="Heading 2" active={showToolbarActiveState && Boolean(editor?.isActive('heading', { level: 2 }))} disabled={!editor} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>
                <Heading2 className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton label="Bullet List" active={showToolbarActiveState && Boolean(editor?.isActive('bulletList'))} disabled={!editor} onClick={() => editor?.chain().focus().toggleBulletList().run()}>
                <List className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton label="Numbered List" active={showToolbarActiveState && Boolean(editor?.isActive('orderedList'))} disabled={!editor} onClick={() => editor?.chain().focus().toggleOrderedList().run()}>
                <ListOrdered className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton label="Code Block" active={showToolbarActiveState && Boolean(editor?.isActive('codeBlock'))} disabled={!editor} onClick={() => editor?.chain().focus().toggleCodeBlock().run()}>
                <Code className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton label="Wiki Link" disabled={!editor} onClick={handleInsertWikiLink}>
                <FileText className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton label="External Link" active={showToolbarActiveState && Boolean(editor?.isActive('link'))} disabled={!editor} onClick={handleSetLink}>
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
            showFeatureMap ? (
              <div className="space-y-5">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-sky-100 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300">
                    <Network className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-lg font-bold tracking-tight text-gray-900 dark:text-gray-100">Feature map</h2>
                    <p className="text-sm text-gray-500">
                      {featureDocs.length} cross-project feature{featureDocs.length === 1 ? '' : 's'} mapped across {groupStatus?.name}. Select a card to open its doc.
                    </p>
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {featureDocs.map((doc) => {
                    const members = participatingMembers(doc);
                    return (
                      <button
                        key={doc.path}
                        type="button"
                        onClick={() => handleOpenDoc(doc.path)}
                        className="group flex flex-col gap-3 rounded-[24px] border border-gray-200 bg-white/70 p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-sky-300 hover:shadow-md dark:border-white/10 dark:bg-[#161720] dark:hover:border-sky-500/40"
                      >
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 shrink-0 text-sky-600 dark:text-sky-300" />
                          <span className="truncate font-semibold text-gray-900 dark:text-gray-100">{doc.title}</span>
                        </div>
                        <p className="line-clamp-2 text-xs text-gray-500">{featureSummary(doc)}</p>
                        <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
                          {members.length > 0 ? (
                            members.map((member) => (
                              <span
                                key={member.name}
                                className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-medium text-sky-700 dark:bg-sky-500/10 dark:text-sky-300"
                              >
                                {member.name} · {member.role}
                              </span>
                            ))
                          ) : (
                            <span className="text-[10px] text-gray-400">No member repos detected</span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="rounded-[28px] border border-dashed border-gray-200 px-6 py-12 text-center text-sm text-gray-500 dark:border-white/10">
                Select a document from the sidebar or create a new one.
              </div>
            )
          ) : (
            <div className="space-y-3">
              <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-200">
                This editor is always live. Use the wiki-link button or type `[[doc-name]]` to reference other docs, then click the rendered link to navigate.
              </div>
              {brokenWikiLinks.length > 0 && (
                <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-200">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>Broken wiki links: {brokenWikiLinks.join(', ')}.</span>
                  </div>
                </div>
              )}
              <div className="docs-editor-shell rounded-[28px] border border-gray-200 bg-gray-50/70 px-6 py-6 dark:border-white/10 dark:bg-black/10" onClickCapture={handleEditorClick}>
                <EditorContent editor={editor} />
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}