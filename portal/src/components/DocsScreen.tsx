import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableCell } from '@tiptap/extension-table-cell';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { AlertCircle, Bold, ChevronDown, ChevronRight, Clock, Code, FileText, Heading1, Heading2, Info, Italic, Link as LinkIcon, List, ListOrdered, Lock, Network, Save, Share2, Trash2, X } from 'lucide-react';
import { applyDocsPromotion, createDoc, deleteDoc, DocConflictError, fetchDoc, fetchDocRevisions, fetchDocs, fetchGroupStatus, renameDocsFolder, updateDoc, updateGroupDocsLabel, type DocRevision } from '../api';
import { useAppSelector } from '../store/useAppSelector';
import type { Doc } from '../types';
import type { GroupStatus } from '../api';
import { resolveDocEditability } from '../utils';
import { getElectronAPI } from '../electronApi';
import { DocsSidebar } from './DocsSidebar';
import { DocHistoryPanel } from './docs/DocHistoryPanel';
import { PromptModal, type PromptModalState } from './task-modal/PromptModal';
import { TicketRefChip } from './TicketRefChip';
import { useConfirm } from '../hooks/useConfirm';
import { formatRelative } from '../lib/relativeTime';
import { normalizeDocPathInput, slugify, renderMarkdownToHtml, getBrokenWikiLinks, getWikiLinkDefinition } from '../lib/docMarkdown';
import { detectUnsupported, parseBlocks, spliceEditedBlocks } from '../lib/blockSplice';

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

// FLUX-1672: whether this doc carries front-matter keys beyond title/order — drives the
// collapsible metadata strip above the rendered body. Front matter is preserved verbatim across
// saves (FLUX-1650) regardless of editor mode, so its presence no longer forces raw mode
// (that FLUX-1654 default was retired once round-trip fidelity was fixed).
function hasExtraFrontmatter(doc: Doc) {
  return Boolean(doc.extraFrontmatter && Object.keys(doc.extraFrontmatter).length > 0);
}

type EditorMode = 'rich' | 'raw';

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
      onMouseDown={(e) => e.preventDefault()}
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
  const currentUser = useAppSelector((s) => s.currentUser);
  const config = useAppSelector((s) => s.config);
  const workspacePath = useAppSelector((s) => s.workspacePath);
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
  const [createDestFolder, setCreateDestFolder] = useState('');
  const [newDocPath, setNewDocPath] = useState('');
  const [newDocTitle, setNewDocTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [docsRefreshKey, setDocsRefreshKey] = useState(0);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; message: string } | null>(null);
  // FLUX-1655: set when a save is rejected by the optimistic-concurrency guard (doc changed on
  // disk since load) — renders a non-destructive "reload" banner instead of a plain error notice.
  const [docConflict, setDocConflict] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [activeTab, setActiveTab] = useState<'editor' | 'history'>('editor');
  const confirm = useConfirm();
  const [editorSnapshot, setEditorSnapshot] = useState('');
  const [isEditorFocused, setIsEditorFocused] = useState(false);
  const [hasTextSelection, setHasTextSelection] = useState(false);
  const [editorHintDismissed, setEditorHintDismissed] = useState(
    () => localStorage.getItem('docs-editor-hint') === 'dismissed',
  );
  const [groupPanelCollapsed, setGroupPanelCollapsed] = useState(false);
  const [showPromoteModal, setShowPromoteModal] = useState(false);
  const [promoteFolder, setPromoteFolder] = useState('features');
  const [promoteFilename, setPromoteFilename] = useState('');
  const [promoteApplying, setPromoteApplying] = useState(false);
  const [promoteError, setPromoteError] = useState<string | null>(null);
  const [promoteResult, setPromoteResult] = useState<{ count: number } | null>(null);
  const turndownServiceRef = useRef<TurndownService | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const baselineEditorSnapshotRef = useRef('');
  const isApplyingEditorContentRef = useRef(false);
  const lastSyncedDocSignatureRef = useRef<string | null>(null);
  const loadedDocsRef = useRef<Doc[]>([]);
  // FLUX-1654: verbatim (unnormalized) on-disk body, used only for raw-mode dirty tracking and as
  // the source when materializing raw edits into the rich editor on a raw -> rich mode switch.
  const savedBodyRef = useRef('');
  // FLUX-1663: per-block clean signatures + the source body they were derived from, established
  // whenever Rich text content is (re)synced from a known-good source (load, reset, mode switch,
  // restore). handleSave's block-splice diffs the live editor's current blocks against this snapshot.
  const blockSpliceRef = useRef<{ originalBody: string; cleanSigs: string[] } | null>(null);
  const [mode, setMode] = useState<EditorMode>('rich');
  // FLUX-1663: non-null when the current doc can't be block-spliced (footnotes, reference-style
  // links, or a source/rendered block-count mismatch) -- shown as a banner while forced into raw mode.
  const [rawFallbackNotice, setRawFallbackNotice] = useState<string | null>(null);
  const [groupStatus, setGroupStatus] = useState<GroupStatus | null>(null);
  const [promptState, setPromptState] = useState<PromptModalState | null>(null);
  // FLUX-1672: the doc's latest commit (for the last-edited byline), and whether the front-matter
  // metadata strip is expanded — both reset per doc selection (collapsed-by-default for the strip).
  const [lastRevision, setLastRevision] = useState<DocRevision | null>(null);
  const [metadataStripExpanded, setMetadataStripExpanded] = useState(false);
  const promptResolverRef = useRef<((value: string | null) => void) | null>(null);

  // FLUX-1457: window.prompt throws in the Electron desktop shell; this promise-based seam feeds
  // the styled PromptModal instead. Resolves `null` on cancel/Escape/unmount, same as window.prompt.
  const runPrompt = (req: { title: string; message?: string; defaultValue?: string; submitLabel?: string; multiline?: boolean }): Promise<string | null> => {
    return new Promise((resolve) => {
      promptResolverRef.current = resolve;
      setPromptState({ mode: 'input', ...req });
    });
  };

  const submitPrompt = (value: string) => {
    promptResolverRef.current?.(value);
    promptResolverRef.current = null;
    setPromptState(null);
  };

  const cancelPrompt = () => {
    promptResolverRef.current?.(null);
    promptResolverRef.current = null;
    setPromptState(null);
  };

  useEffect(() => {
    return () => {
      promptResolverRef.current?.(null);
      promptResolverRef.current = null;
    };
  }, []);

  if (!turndownServiceRef.current) {
    turndownServiceRef.current = createTurndownService();
  }

  const canEditDocs = (config?.docsEditPermissions ?? 'all') === 'all'
    || (config?.docsAllowedUsers ?? []).includes(currentUser);
  const isSelectedDocReadOnly = selectedDoc?.readOnly === true;
  const docEditability = resolveDocEditability(selectedDoc ?? null, canEditDocs);
  const canEditSelectedDoc = docEditability.editable;
  const editsRouteViaParent = docEditability.viaParent;
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
  // Promotion discoverability (FLUX-416): a repo-local `.docs/` doc (anything
  // outside the `<docsLabel>/` group tree) is NOT shared with the group until it's
  // promoted. Both sides of a group can promote — the parent owns the store, a
  // bound member pushes through the parent — so nudge toward the promotion panel
  // for either so this isn't mistaken for a sync bug.
  const isGroupParent = groupStatus?.configured === true;
  const isGroupMember = groupStatus?.membership != null;
  const canPromoteHere = isGroupParent || isGroupMember;
  const selectedDocIsGroupDoc = selectedDoc != null && selectedDoc.path.startsWith(`${groupDocsLabel}/`);
  const showPromoteHint = canPromoteHere && selectedDoc != null && !selectedDocIsGroupDoc && !isSelectedDocReadOnly;
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
      || (mode === 'raw' ? draftBody !== savedBodyRef.current : editorSnapshot !== baselineEditorSnapshotRef.current)
    )
  );

  // FLUX-1663: each top-level ProseMirror node renders as one direct child of the editor's DOM
  // root -- reading outerHTML straight off the live DOM (rather than serializing detached nodes)
  // guarantees turndown sees exactly what handleSave/setupRichBlockSplice would each see, with no
  // extra dependency (avoids pulling in @tiptap/pm just for a DOMSerializer).
  //
  // ProseMirror auto-appends a trailing EMPTY paragraph whenever the document's last real content
  // is a non-text block (a fenced code block, a table, ...), so there's a cursor position to keep
  // typing below it -- this happens for a single whole-document render too (verified: rendering
  // this same corpus as one block produces the identical trailing empty paragraph), so it's a
  // structural editor artifact, not user content, and has no corresponding source block to splice
  // against. Drop it here so block-count/signature accounting never sees it.
  function getSpliceableTopLevelNodeHtmls(activeEditor: NonNullable<typeof editor>): string[] {
    const htmls = Array.from(activeEditor.view.dom.children).map((child) => (child as HTMLElement).outerHTML);
    const lastIndex = activeEditor.state.doc.content.childCount - 1;
    if (lastIndex >= 0) {
      const lastNode = activeEditor.state.doc.content.child(lastIndex);
      if (lastNode.type.name === 'paragraph' && lastNode.content.size === 0) {
        return htmls.slice(0, -1);
      }
    }
    return htmls;
  }

  // FLUX-1663: (re)establish the block-splice baseline for Rich text mode. Renders `bodyForBlocks`
  // through marked ONE TOP-LEVEL BLOCK AT A TIME (not the whole body at once) so each mdast block
  // maps 1:1 to a TipTap top-level node, then snapshots each node's clean signature from the
  // ACTUAL rendered DOM -- the same path handleSave reads from -- so an untouched block's signature
  // is guaranteed to compare equal at save time. Falls back (returns false, sets the raw-mode
  // notice) on unsupported global constructs (footnotes/ref-links) or a block-count mismatch.
  const setupRichBlockSplice = (bodyForBlocks: string): boolean => {
    if (!editor) {
      return false;
    }

    const unsupported = detectUnsupported(bodyForBlocks);
    if (!unsupported.supported) {
      setRawFallbackNotice(unsupported.reason || 'This document uses markdown features not yet supported in rendered editing.');
      blockSpliceRef.current = null;
      return false;
    }

    const blocks = parseBlocks(bodyForBlocks);
    const combinedHtml = blocks.length > 0
      ? blocks.map((block) => renderMarkdownToHtml(block.sourceText, docs)).join('')
      : '<p></p>';
    setEditorContentSafely(combinedHtml);

    const spliceableHtmls = blocks.length > 0 ? getSpliceableTopLevelNodeHtmls(editor) : [];
    if (blocks.length > 0 && spliceableHtmls.length !== blocks.length) {
      setRawFallbackNotice('This document’s structure couldn’t be mapped to editable blocks.');
      blockSpliceRef.current = null;
      return false;
    }

    const cleanSigs = spliceableHtmls.map((html) => turndownServiceRef.current!.turndown(html));
    blockSpliceRef.current = { originalBody: bodyForBlocks, cleanSigs };
    setRawFallbackNotice(null);
    return true;
  };

  // FLUX-1663: the Rich text save path. Recomputes each current top-level node's signature from its
  // live rendered HTML and hands off to spliceEditedBlocks, which copies every block whose signature
  // still matches `blockSpliceRef`'s baseline verbatim from source bytes, and re-serializes only the
  // blocks that changed -- instead of turndown-ing the whole document (FLUX-1663's whole point).
  const computeRichSaveBody = (): string => {
    if (!editor || !blockSpliceRef.current) {
      return draftMarkdown;
    }

    const currentBlocks = getSpliceableTopLevelNodeHtmls(editor).map((html) => {
      const content = turndownServiceRef.current!.turndown(html);
      return { signature: content, content };
    });

    return spliceEditedBlocks(blockSpliceRef.current.originalBody, blockSpliceRef.current.cleanSigs, currentBlocks);
  };

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

  // Strip the `?doc=` deep-link param when leaving the Docs screen, so it never
  // lingers (and points at a now-invalid doc) on other screens.
  useEffect(() => {
    return () => {
      const url = new URL(window.location.href);
      if (url.searchParams.has('doc')) {
        url.searchParams.delete('doc');
        window.history.replaceState({}, '', url);
      }
    };
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
        } else if (selectedPath) {
          // FLUX-1671: this refresh only replaces the `docs` list -- it never reconciles the
          // currently OPEN doc, so an external change to it (a merged PR, another tab's save)
          // left `selectedDoc`/`savedBodyRef` pointing at a stale baseline (false-dirty prompts on
          // nav, stale/empty content). Reconcile here: apply the fresh body when there are no
          // local edits to lose; otherwise route through the FLUX-1655 conflict banner instead of
          // silently overwriting the user's draft or drifting `isDirty`.
          const freshDoc = loadedDocs.find((doc) => doc.path === selectedPath);
          if (freshDoc && freshDoc.body !== savedBodyRef.current) {
            if (isDirty) {
              setDocConflict(true);
            } else {
              applyLoadedDoc(freshDoc);
            }
          }
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

  // Apply a freshly fetched doc to editor state — shared by the load-on-select effect below and
  // the FLUX-1655 "Reload doc" conflict-banner action (which re-fetches the same selected path).
  // FLUX-1663: a doc carrying footnotes/reference-style links can't be block-spliced safely (a
  // single-block serialization could drop/duplicate the shared definition), so it opens in raw
  // mode too, same as the FLUX-1650/1654 extra-frontmatter case -- but WITH a visible banner,
  // since (unlike extra-frontmatter docs) this is a capability gap, not an intentional default.
  const computeDefaultMode = (loadedDoc: Doc): { mode: EditorMode; noticeReason: string | null } => {
    const unsupported = detectUnsupported(loadedDoc.body);
    if (!unsupported.supported) {
      return { mode: 'raw', noticeReason: unsupported.reason || 'This document uses markdown features not yet supported in rendered editing.' };
    }

    return { mode: 'rich', noticeReason: null };
  };

  const applyLoadedDoc = (loadedDoc: Doc) => {
    const { mode: defaultMode, noticeReason } = computeDefaultMode(loadedDoc);
    // FLUX-1671: force the render-sync effect (below) to re-apply this doc's content even when its
    // signature happens to match the last-synced one (e.g. re-selecting a doc after an external
    // change reverted, or reapplying the same path after a refresh) -- never leave the editor
    // showing a stale/previous doc's body or an empty buffer.
    lastSyncedDocSignatureRef.current = null;
    setSelectedDoc(loadedDoc);
    setDraftTitle(loadedDoc.title);
    setMode(defaultMode);
    setRawFallbackNotice(noticeReason);
    savedBodyRef.current = loadedDoc.body;
    setDraftBody(defaultMode === 'raw' ? loadedDoc.body : normalizeMarkdownBody(loadedDoc.body));
    setIsEditingTitle(false);
    setMetadataStripExpanded(false);
  };

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

        applyLoadedDoc(loadedDoc);
      } catch (error) {
        console.error(error);
        if (!cancelled) {
          setNotice({ tone: 'error', message: `Failed to load ${selectedPath}.` });
          // The path is stale (e.g. after a rename/move) — drop the selection so
          // the URL's `?doc=` param doesn't keep pointing at a doc that's gone.
          setSelectedPath(null);
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

  // FLUX-1672: last-edited byline — reuses the existing revisions endpoint (no new API), reading
  // only revisions[0] (newest). Degrades silently (no byline) on a non-git workspace or an
  // untracked doc, both of which resolve to an empty list rather than throwing.
  useEffect(() => {
    // Clear synchronously on every selection change so a slow fetch for the new doc never
    // leaves the *previous* doc's byline showing while it's in flight.
    setLastRevision(null);
    if (!selectedPath) {
      return;
    }
    let cancelled = false;
    fetchDocRevisions(selectedPath)
      .then((revisions) => {
        if (!cancelled) setLastRevision(revisions[0] ?? null);
      })
      .catch(() => {
        if (!cancelled) setLastRevision(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPath, workspacePath]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    // FLUX-1671: `emitUpdate: false` -- setEditable's default (true) fires a TipTap 'update' event
    // on EVERY call regardless of whether editable actually changed. In raw mode the underlying
    // rich editor is never seeded with the doc's content (it's lazily seeded only on a switch to
    // Rich text), so that stray 'update' hands `onUpdate` the editor's still-default empty HTML,
    // which overwrites `draftBody` with '' -- the concrete empty-editor-buffer/data-loss mechanism.
    // This effect only toggles read-only-ness here; it never wants to emit a content-change event.
    editor.setEditable(Boolean(selectedDoc) && canEditSelectedDoc && mode === 'rich', false);

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

    // FLUX-1654: raw mode never feeds the doc through marked/TipTap — the rich editor is lazily
    // seeded (see handleModeChange) only if/when the user switches to Rich text for this doc.
    if (mode !== 'rich') {
      return;
    }

    // FLUX-1663: render+snapshot per top-level mdast block (not the whole body at once) so save
    // can splice edited blocks against untouched, verbatim source bytes. A block-count mismatch
    // between source and rendered nodes is only detectable once we've actually rendered into the
    // live editor -- computeDefaultMode already screened for footnotes/ref-links up front.
    if (setupRichBlockSplice(selectedDoc.body)) {
      baselineEditorSnapshotRef.current = getEditorDocumentSnapshot(editor);
    } else {
      setMode('raw');
      setDraftBody(selectedDoc.body);
    }
  }, [editor, selectedDoc?.path, selectedDoc?.body, canEditSelectedDoc, docs, mode]);

  useEffect(() => {
    let cancelled = false;
    fetchGroupStatus()
      .then((status) => { if (!cancelled) setGroupStatus(status); })
      .catch(() => { if (!cancelled) setGroupStatus(null); });
    return () => { cancelled = true; };
  }, [workspacePath]);

  useEffect(() => {
    const electron = getElectronAPI();
    if (electron) {
      // Electron never renders the beforeunload dialog — it just silently cancels the close.
      // Report dirty state to main instead, which owns a native confirm on close/quit (FLUX-1458).
      // Do NOT also preventDefault beforeunload here: it would re-cancel the close right after
      // the user picks "Discard" in the native dialog, stranding the window.
      electron.setUnsavedGuard?.(isDirty);
      return () => { electron.setUnsavedGuard?.(false); };
    }

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

  const confirmDiscardChanges = async () => {
    if (!isDirty) {
      return true;
    }

    return await confirm({ title: 'Discard unsaved doc changes?', tone: 'danger', confirmLabel: 'Discard' });
  };

  const handleOpenDoc = async (docPath: string) => {
    if (docPath === selectedPath) {
      return;
    }

    if (!(await confirmDiscardChanges())) {
      return;
    }

    setNotice(null);
    setDocConflict(false);
    setSelectedPath(docPath);
    setActiveTab('editor');
  };

  const handleRestoreRevision = (revision: DocRevision, content: Doc) => {
    if (!selectedDoc || !canEditSelectedDoc) {
      return;
    }

    setDraftTitle(content.title);
    // Deliberately leave `baselineEditorSnapshotRef`/`savedBodyRef` pointing at `selectedDoc`'s
    // synced snapshot — this makes the restored content read as an unsaved DRAFT (isDirty=true)
    // relative to the current committed doc, so Save commits it as a new revision rather than
    // silently overwriting.
    if (mode === 'raw' || !editor) {
      setDraftBody(content.body);
    } else if (setupRichBlockSplice(content.body)) {
      setDraftBody(content.body);
    } else {
      // The restored revision isn't block-splice-safe (e.g. it contains footnotes) --
      // fall back to Markdown mode so the user can still see/save the restored content faithfully.
      setMode('raw');
      setDraftBody(content.body);
    }
    setActiveTab('editor');
    setNotice({ tone: 'success', message: `Loaded revision ${revision.hash.slice(0, 7)} into the editor — review and Save to restore it.` });
  };

  const handleOpenCreateForm = async (folderPath: string) => {
    if (!(await confirmDiscardChanges())) {
      return;
    }

    setCreateTargetFolder(folderPath);
    setCreateDestFolder('');
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
    // The "+" on a specific folder pins that folder; the root "New Doc" form
    // lets the user pick a destination folder from the dropdown instead.
    const baseFolder = createTargetFolder || createDestFolder;
    const normalizedPath = normalizeDocPathInput(
      baseFolder && baseFolder.length > 0
        ? `${baseFolder}/${normalizedRelativePath || ''}`
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
      setCreateDestFolder('');
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

  // Which folders expose an inline rename affordance. The group-label root is a
  // config change (parent-only); its store subfolders are virtual and not movable.
  const canRenameFolder = (folderPath: string) => {
    if (!canEditDocs) return false;
    if (folderPath === groupDocsLabel) return isGroupParent;
    if (folderPath.startsWith(`${groupDocsLabel}/`)) return false;
    return true;
  };

  // Remap the open-doc selection + folder expand/collapse state when a folder
  // path prefix changes, so a rename reflects instantly instead of leaving the
  // UI pointing at the now-stale old path until a page reload.
  const remapFolderPrefix = (fromPrefix: string, toPrefix: string) => {
    const under = (value: string) => value === fromPrefix || value.startsWith(`${fromPrefix}/`);
    const remap = (value: string) => (under(value) ? toPrefix + value.slice(fromPrefix.length) : value);
    setSelectedPath((current) => (current ? remap(current) : current));
    setExpandedFolders((current) => {
      const next: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(current)) {
        next[remap(key)] = value;
      }
      return next;
    });
  };

  // Rename a docs folder. The group-label root reroutes to the group docs-label
  // config (parent-only); every other folder is a file move via the docs API.
  const handleRenameFolder = async (fromPath: string, newName: string) => {
    if (fromPath === groupDocsLabel) {
      await updateGroupDocsLabel(newName);
      const status = await fetchGroupStatus().catch(() => null);
      setGroupStatus(status);
      remapFolderPrefix(groupDocsLabel, newName);
      setDocsRefreshKey((current) => current + 1);
      setNotice({ tone: 'success', message: `Group docs folder renamed to “${newName}”.` });
      return;
    }
    const parentPrefix = fromPath.split('/').slice(0, -1).join('/');
    const toPath = parentPrefix ? `${parentPrefix}/${newName}` : newName;
    await renameDocsFolder(fromPath, toPath);
    remapFolderPrefix(fromPath, toPath);
    setDocsRefreshKey((current) => current + 1);
    setNotice({ tone: 'success', message: `Folder renamed to “${newName}”.` });
  };

  const handleSave = async () => {
    if (!selectedDoc || !canEditSelectedDoc) {
      return;
    }

    // FLUX-1655: with docsCommitOnSave on, a save becomes a git commit -- prompt for the message
    // first (before any busy/notice state), and abort on cancel just like the wiki-link prompt.
    let revisionMessage: string | undefined;
    if (config?.docsCommitOnSave) {
      const message = await runPrompt({
        title: 'Save as revision',
        message: 'Describe this change -- it becomes the commit message.',
        defaultValue: `Update ${normalizedDraftTitle}`,
        submitLabel: 'Save',
        multiline: true,
      });
      if (message === null) {
        return;
      }
      revisionMessage = message;
    }

    // FLUX-1654: raw mode sends the textarea's body byte-for-byte (no normalizeMarkdownBody
    // pass) so a no-op load->save round-trips to zero diff on disk. FLUX-1663: rich mode now
    // splices only the blocks that actually changed against verbatim source bytes, instead of
    // turndown-ing the whole document -- see computeRichSaveBody.
    const outgoingBody = mode === 'raw' ? draftBody : computeRichSaveBody();

    // FLUX-1671: hard-guard against the concrete data-loss vector -- a driven-empty editor buffer
    // (from the state drift this ticket fixes, or any other client bug) saved over a real,
    // non-empty on-disk doc. Refuse with no write rather than silently clobbering.
    if (!outgoingBody.trim() && savedBodyRef.current.trim()) {
      setNotice({ tone: 'error', message: 'Refusing to save: the editor buffer is empty but the doc on disk is not. Reload the doc to recover, then try again.' });
      return;
    }

    setSaving(true);
    setNotice(null);
    setDocConflict(false);

    try {
      // FLUX-1671: send `baseHash` on every save (previously only during save-as-revision) so the
      // FLUX-1655 optimistic-concurrency guard (engine/src/routes/docs.ts) always fires when the
      // doc changed on disk since load -- a stale-baseline save now 409s into the conflict banner
      // instead of blindly overwriting an external change.
      const updatedDoc = await updateDoc(selectedDoc.path, {
        title: normalizedDraftTitle,
        body: outgoingBody,
        baseHash: selectedDoc.hash,
        ...(revisionMessage !== undefined ? { revisionMessage, author: currentUser } : {}),
      });

      setSelectedDoc(updatedDoc);
      setDocs((currentDocs) => currentDocs.map((doc) => doc.path === updatedDoc.path ? updatedDoc : doc));
      setDraftTitle(updatedDoc.title);
      savedBodyRef.current = updatedDoc.body;
      setDraftBody(mode === 'raw' ? updatedDoc.body : normalizeMarkdownBody(updatedDoc.body));
      baselineEditorSnapshotRef.current = editor ? getEditorDocumentSnapshot(editor) : editorSnapshot;
      lastSyncedDocSignatureRef.current = `${updatedDoc.path}\u0000${normalizeMarkdownBody(updatedDoc.body)}`;
      // FLUX-1663: the DOM didn't change across the save round-trip -- every block just persisted
      // is now "clean" relative to `updatedDoc.body`, so re-baseline instead of waiting for the
      // render-sync effect (which no-ops here since its own doc-signature guard already matches).
      if (mode === 'rich' && editor) {
        blockSpliceRef.current = {
          originalBody: updatedDoc.body,
          cleanSigs: getSpliceableTopLevelNodeHtmls(editor).map((html) => turndownServiceRef.current!.turndown(html)),
        };
      }
      setIsEditingTitle(false);
      setNotice({ tone: 'success', message: `Saved ${updatedDoc.title}.` });
    } catch (error) {
      console.error(error);
      if (error instanceof DocConflictError) {
        setDocConflict(true);
      } else {
        setNotice({ tone: 'error', message: 'Failed to save the current doc.' });
      }
    } finally {
      setSaving(false);
    }
  };

  // FLUX-1655: the conflict banner's "Reload doc" action -- re-fetches the current on-disk version
  // (never overwrites it) so the user can see what changed before deciding how to reapply their edit.
  const handleReloadAfterConflict = async () => {
    if (!selectedDoc) {
      return;
    }

    try {
      const freshDoc = await fetchDoc(selectedDoc.path);
      applyLoadedDoc(freshDoc);
      setDocs((currentDocs) => currentDocs.map((doc) => doc.path === freshDoc.path ? freshDoc : doc));
      setDocConflict(false);
      setNotice(null);
    } catch (error) {
      console.error(error);
      setNotice({ tone: 'error', message: `Failed to reload ${selectedDoc.path}.` });
    }
  };

  const handleDelete = async () => {
    if (!selectedDoc || !canEditSelectedDoc) {
      return;
    }

    const confirmed = await confirm({ title: `Delete ${selectedDoc.title}? This removes the markdown file from the workspace.`, tone: 'danger', confirmLabel: 'Delete' });
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
    savedBodyRef.current = selectedDoc.body;
    const normalizedBody = normalizeMarkdownBody(selectedDoc.body);
    setDraftBody(mode === 'raw' ? selectedDoc.body : normalizedBody);
    lastSyncedDocSignatureRef.current = `${selectedDoc.path}\u0000${normalizedBody}`;
    if (mode === 'rich' && editor && setupRichBlockSplice(selectedDoc.body)) {
      baselineEditorSnapshotRef.current = getEditorDocumentSnapshot(editor);
    }
    setIsEditingTitle(false);
    setNotice(null);
  };

  // FLUX-1654: Rich text <-> Markdown toggle. Raw -> rich lazily seeds the TipTap editor (the
  // first time marked/turndown run for a raw-defaulted doc) — the baseline snapshot is rendered
  // from `savedBodyRef` (the on-disk body) so isDirty still reflects unsaved changes correctly,
  // then any pending raw edits are layered on top as the actually-displayed content. Rich -> raw
  // is a no-op on content: `draftBody` is already kept in sync with the rich editor via onUpdate.
  const handleModeChange = (nextMode: EditorMode) => {
    if (nextMode === mode) {
      return;
    }

    if (nextMode === 'rich' && editor) {
      const savedBodyNormalized = normalizeMarkdownBody(savedBodyRef.current);
      const hasPendingRawEdits = draftMarkdown !== savedBodyNormalized;
      const bodyForBlocks = hasPendingRawEdits ? draftMarkdown : savedBodyNormalized;

      if (!setupRichBlockSplice(bodyForBlocks)) {
        // Stays in Markdown mode -- forcing Rich text would show an editor we can't safely
        // splice-save from. `rawFallbackNotice` (set by setupRichBlockSplice) explains why.
        return;
      }

      // Baseline must reflect the on-disk state (for isDirty), not `bodyForBlocks` when there
      // are pending raw edits -- so only overwrite it when there's nothing pending to preserve.
      if (!hasPendingRawEdits) {
        baselineEditorSnapshotRef.current = getEditorDocumentSnapshot(editor);
      }

      setDraftBody(bodyForBlocks);
    }

    setMode(nextMode);
  };

  const handleCancelCreateForm = () => {
    setCreateTargetFolder(null);
    setCreateDestFolder('');
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
      void handleOpenDoc(decodeURIComponent(href.slice(5)));
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

  const handleInsertWikiLink = async () => {
    if (!editor || !canEditSelectedDoc) {
      return;
    }

    const selectionText = editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, ' ');
    const nextTarget = await runPrompt({
      title: 'Insert wiki link',
      message: 'Enter the doc path or title to link with wiki syntax.',
      defaultValue: selectionText || '',
      submitLabel: 'Insert',
    });
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

  const handleSetLink = async () => {
    if (!editor || !canEditSelectedDoc) {
      return;
    }

    const existingLink = editor.getAttributes('link').href as string | undefined;
    const nextLink = await runPrompt({
      title: 'Link URL',
      message: 'Enter the link URL. Leave blank to remove the current link.',
      defaultValue: existingLink || '',
      submitLabel: 'Set link',
    });
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
    <>
    <div className="grid gap-6 xl:grid-cols-[minmax(18rem,20%)_minmax(0,1fr)]">
      <div className="space-y-4">
        {groupStatus?.membership?.role === 'member' && (
          <div className="rounded-[28px] border border-sky-200 bg-sky-50/60 p-4 dark:border-sky-500/20 dark:bg-sky-500/5">
            <button
              type="button"
              onClick={() => setGroupPanelCollapsed((c) => !c)}
              className="flex w-full items-center gap-3 text-left"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-sky-100 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300">
                <Network className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-sm font-bold text-gray-900 dark:text-gray-100">Part of “{groupStatus.membership.groupName}”</h2>
                {groupPanelCollapsed && <p className="text-[11px] text-gray-400">{groupStatus.membership.memberName} member &middot; click to expand</p>}
              </div>
              {groupPanelCollapsed ? <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" /> : <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" />}
            </button>
            {!groupPanelCollapsed && (
              <p className="mt-3 text-[11px] text-gray-500">
                This repo is the
                <span className="font-semibold text-gray-700 dark:text-gray-300"> {groupStatus.membership.memberName}</span>
                {groupStatus.membership.memberRole ? ` (${groupStatus.membership.memberRole})` : ''} member.
                The <code className="font-mono">{groupDocsLabel}/</code> tree below is the shared cross-project knowledge base. Edits route to the group parent.
              </p>
            )}
          </div>
        )}
        {groupStatus?.configured && (
          <div className="rounded-[28px] border border-gray-200 bg-white/80 p-4 shadow-xl shadow-gray-200/60 dark:border-white/10 dark:bg-[#161720] dark:shadow-none">
            <button
              type="button"
              onClick={() => setGroupPanelCollapsed((c) => !c)}
              className="flex w-full items-center gap-3 border-b border-gray-200 pb-3 text-left dark:border-white/10"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-sky-100 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300">
                <Network className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-sm font-bold text-gray-900 dark:text-gray-100">{groupStatus.name}</h2>
                <p className="text-[11px] text-gray-500">Multi-repo group · {groupStatus.members?.length ?? 0} member(s)</p>
                {groupPanelCollapsed ? <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" /> : <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" />}
              </div>
            </button>
            {!groupPanelCollapsed && (
              <>
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
                onClick={() => { void (async () => { if (await confirmDiscardChanges()) setSelectedPath(null); })(); }}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-sky-200 px-3 py-2 text-xs font-semibold text-sky-700 transition-colors hover:bg-sky-50 dark:border-sky-500/20 dark:text-sky-300 dark:hover:bg-sky-500/10"
              >
                <Network className="h-3.5 w-3.5" />
                View feature map
              </button>
            )}
              </>
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
          createDestFolder={createDestFolder}
          onCreateDestFolderChange={setCreateDestFolder}
          newDocPath={newDocPath}
          onNewDocPathChange={setNewDocPath}
          newDocTitle={newDocTitle}
          onNewDocTitleChange={setNewDocTitle}
          onOpenCreateForm={handleOpenCreateForm}
          onCancelCreate={handleCancelCreateForm}
          onCreateDoc={handleCreateDoc}
          onReorderDocs={handleReorderDocs}
          creating={creating}
          systemFolders={['event-horizon']}
          onRenameFolder={handleRenameFolder}
          canRenameFolder={canRenameFolder}
        />
      </div>

      <section className="rounded-[32px] border border-gray-200 bg-white/80 p-6 shadow-xl shadow-gray-200/60 dark:border-white/10 dark:bg-[#161720] dark:shadow-none">
        {/* ── Compact doc header ── */}
        <div className="border-b border-gray-200 pb-4 dark:border-white/10">
          {/* Top row: breadcrumb path + actions */}
          <div className="flex items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
              <FileText className="h-3.5 w-3.5 shrink-0 text-gray-400" />
              {selectedDoc && breadcrumbs.length > 0 ? (
                <nav className="flex min-w-0 items-center gap-1 overflow-hidden text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400">
                  {breadcrumbs.map((segment, index) => (
                    <span key={`${segment}-${index}`} className="flex min-w-0 items-center gap-1">
                      {index > 0 && <span className="shrink-0 text-gray-300 dark:text-gray-600">/</span>}
                      <span className="truncate">{segment}</span>
                    </span>
                  ))}
                </nav>
              ) : (
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400">Documentation</span>
              )}
            </div>
            {isDirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400 dark:bg-amber-300" title="Unsaved changes" />}
            {isDirty && canEditSelectedDoc && (
              <button
                type="button"
                onClick={handleResetDraft}
                className="shrink-0 rounded-xl px-2.5 py-1.5 text-xs font-semibold text-gray-500 transition-colors hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/5"
              >
                Reset
              </button>
            )}
            <button
              type="button"
              onClick={handleSave}
              disabled={!selectedDoc || !canEditSelectedDoc || !isDirty || saving}
              className={`flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors ${selectedDoc && canEditSelectedDoc && isDirty ? 'bg-primary text-white hover:bg-primary-hover' : 'text-gray-300 dark:text-gray-600'}`}
            >
              <Save className="h-3.5 w-3.5" />
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={!selectedDoc || !canEditSelectedDoc || deleting}
              title={deleting ? 'Deleting…' : 'Delete doc'}
              className={`shrink-0 rounded-xl p-1.5 transition-colors ${selectedDoc && canEditSelectedDoc ? 'text-rose-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10' : 'text-gray-300 dark:text-gray-600'}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          {/* Title row */}
          <div className="mt-3">
            {selectedDoc ? (
              isEditingTitle && canEditSelectedDoc ? (
                <input
                  ref={titleInputRef}
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  onBlur={() => stopEditingTitle('save')}
                  onKeyDown={handleTitleKeyDown}
                  className="w-full max-w-2xl rounded-2xl border border-gray-200 bg-white px-4 py-2 text-2xl font-bold tracking-tight text-gray-900 outline-none focus:border-primary dark:border-white/10 dark:bg-black/20 dark:text-gray-100"
                />
              ) : (
                <h1 className="truncate text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100">
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
              <h1 className="truncate text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100">Documentation</h1>
            )}
          </div>
          {selectedDoc && lastRevision && (
            <div className="mt-1 flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
              <span title={lastRevision.date}>
                Last edited {formatRelative(lastRevision.date)} · {lastRevision.author}
              </span>
              {lastRevision.ticketId && <TicketRefChip ticketId={lastRevision.ticketId} />}
            </div>
          )}
          {selectedDoc && (
            <div className="mt-3 flex items-center gap-1">
              <button
                type="button"
                onClick={() => setActiveTab('editor')}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${activeTab === 'editor' ? 'bg-primary/10 text-primary' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/5'}`}
              >
                Editor
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('history')}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${activeTab === 'history' ? 'bg-primary/10 text-primary' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/5'}`}
              >
                <Clock className="h-3.5 w-3.5" />
                History
              </button>
              {canEditSelectedDoc && activeTab === 'editor' && (
                <div className="ml-auto flex items-center gap-0.5 rounded-lg bg-gray-100 p-0.5 dark:bg-white/5" title="Markdown mode is byte-faithful — it never round-trips through the rich-text renderer, so edits diff cleanly (FLUX-1654).">
                  <button
                    type="button"
                    onClick={() => handleModeChange('rich')}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${mode === 'rich' ? 'bg-white text-gray-900 shadow-sm dark:bg-white/10 dark:text-white' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'}`}
                  >
                    Rich text
                  </button>
                  <button
                    type="button"
                    onClick={() => handleModeChange('raw')}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${mode === 'raw' ? 'bg-white text-gray-900 shadow-sm dark:bg-white/10 dark:text-white' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'}`}
                  >
                    Markdown
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mt-4 space-y-4">
          {notice && (
            <div className={`rounded-2xl border px-4 py-3 text-sm ${notice.tone === 'error' ? 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-200' : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200'}`}>
              {notice.message}
            </div>
          )}

          {docConflict && selectedDoc && (
            <div className="flex flex-wrap items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="flex-1 min-w-0">
                This doc changed on disk since you loaded it. Your edits weren't saved — reload to see the latest version, then reapply your change.
              </div>
              <button
                type="button"
                onClick={handleReloadAfterConflict}
                className="shrink-0 rounded-xl border border-amber-300 bg-white/60 px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-white dark:border-amber-500/30 dark:bg-white/5 dark:text-amber-200 dark:hover:bg-white/10"
              >
                Reload doc
              </button>
            </div>
          )}

          {selectedDoc && mode === 'raw' && rawFallbackNotice && (
            <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              {rawFallbackNotice} Switched to Markdown mode.
            </div>
          )}

          {selectedDoc && isSelectedDocReadOnly && (
            <div className="flex items-start gap-3 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-200">
              <Lock className="mt-0.5 h-4 w-4 shrink-0" />
              This is a read-only cross-project group doc. Edits are authored in the group's parent repo and fanned out to members.
            </div>
          )}

          {selectedDoc && editsRouteViaParent && (
            <div className="flex items-start gap-3 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-200">
              <Share2 className="mt-0.5 h-4 w-4 shrink-0" />
              This is a shared {groupDocsLabel} doc. Your edits are saved through the group's parent repo and fanned out to every member.
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
                onClick={() => {
                  const docPath = selectedDoc?.path;
                  const basename = docPath?.split('/').pop() ?? 'doc';
                  setPromoteFolder('features');
                  setPromoteFilename(basename.toLowerCase().endsWith('.md') ? basename : `${basename}.md`);
                  setPromoteError(null);
                  setPromoteResult(null);
                  setShowPromoteModal(true);
                }}
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

          {selectedDoc && activeTab === 'editor' && hasExtraFrontmatter(selectedDoc) && (
            <div className="rounded-2xl border border-gray-200 bg-gray-50/70 dark:border-white/10 dark:bg-white/5">
              <button
                type="button"
                onClick={() => setMetadataStripExpanded((expanded) => !expanded)}
                className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs font-semibold text-gray-600 dark:text-gray-300"
              >
                {metadataStripExpanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                Front matter
                <span className="font-normal text-gray-400">({Object.keys(selectedDoc.extraFrontmatter ?? {}).length})</span>
              </button>
              {metadataStripExpanded && (
                <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 border-t border-gray-200 px-4 py-3 text-xs dark:border-white/10">
                  {Object.entries(selectedDoc.extraFrontmatter ?? {}).map(([key, value]) => (
                    <div key={key} className="contents">
                      <dt className="font-mono text-gray-400 dark:text-gray-500">{key}</dt>
                      <dd className="min-w-0 truncate text-gray-700 dark:text-gray-200">
                        {typeof value === 'string' ? value : JSON.stringify(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          )}

          {selectedDoc && canEditSelectedDoc && isEditorFocused && (
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
          ) : activeTab === 'history' ? (
            <DocHistoryPanel
              docPath={selectedDoc.path}
              docs={docs}
              canRestore={canEditSelectedDoc}
              onRestore={handleRestoreRevision}
            />
          ) : (
            <div className="space-y-3">
              {!editorHintDismissed && (
                <div className="flex items-start gap-3 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-200">
                  <span className="flex-1">This editor is always live. Use the wiki-link button or type `[[doc-name]]` to reference other docs, then click the rendered link to navigate.</span>
                  <button
                    type="button"
                    onClick={() => { setEditorHintDismissed(true); localStorage.setItem('docs-editor-hint', 'dismissed'); }}
                    className="shrink-0 rounded-lg p-1 text-sky-600 hover:bg-sky-100 dark:text-sky-300 dark:hover:bg-sky-500/10"
                    title="Dismiss"
                  ><X className="h-3.5 w-3.5" /></button>
                </div>
              )}
              {brokenWikiLinks.length > 0 && (
                <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-200">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>Broken wiki links: {brokenWikiLinks.join(', ')}.</span>
                  </div>
                </div>
              )}
              <div className="docs-editor-shell rounded-[28px] border border-gray-200 bg-gray-50/70 px-6 py-6 dark:border-white/10 dark:bg-black/10" onClickCapture={mode === 'rich' ? handleEditorClick : undefined}>
                {mode === 'raw' ? (
                  <textarea
                    value={draftBody}
                    onChange={(event) => setDraftBody(event.target.value)}
                    readOnly={!canEditSelectedDoc}
                    spellCheck={false}
                    placeholder="Start writing markdown. Use [[doc-name]] for internal links."
                    className="docs-editor-content min-h-[26rem] w-full resize-y rounded-[24px] border border-gray-200 bg-white px-5 py-4 font-mono text-sm leading-6 text-gray-900 outline-none focus:border-primary dark:border-white/10 dark:bg-black/20 dark:text-gray-100"
                  />
                ) : (
                  <EditorContent editor={editor} />
                )}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>

    {/* Promote-doc inline modal */}
    {showPromoteModal && selectedDoc && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setShowPromoteModal(false)}>
        <div className="relative w-full max-w-md rounded-[28px] border border-gray-200 bg-white p-6 shadow-2xl dark:border-white/10 dark:bg-[#161720]" onClick={(e) => e.stopPropagation()}>
          <button type="button" onClick={() => setShowPromoteModal(false)} className="absolute right-4 top-4 rounded-full p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
            <X className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-indigo-100 dark:bg-indigo-500/20">
              <Share2 className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Promote doc to group store</h2>
              <p className="text-xs text-gray-500">This is a move — the doc leaves this repo</p>
            </div>
          </div>
          <div className="mt-4 space-y-3">
            <div>
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Source</label>
              <p className="mt-1 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-xs text-gray-700 dark:border-white/10 dark:bg-white/5 dark:text-gray-300">.docs/{selectedDoc.path}.md</p>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Destination in group store</label>
              <div className="mt-1 flex items-center gap-2">
                <select
                  value={promoteFolder}
                  onChange={(e) => setPromoteFolder(e.target.value)}
                  className="shrink-0 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-900 focus:border-indigo-400 focus:outline-none dark:border-white/10 dark:bg-white/5 dark:text-white"
                >
                  <option value="features">features/</option>
                  <option value="contracts">contracts/</option>
                  <option value="">store root</option>
                </select>
                <input
                  type="text"
                  value={promoteFilename}
                  onChange={(e) => setPromoteFilename(e.target.value)}
                  placeholder="overview.md"
                  className="min-w-0 flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2 font-mono text-xs text-gray-900 focus:border-indigo-400 focus:outline-none dark:border-white/10 dark:bg-white/5 dark:text-white"
                />
              </div>
              <p className="mt-1 font-mono text-[11px] text-gray-400">
                → {promoteFolder ? `${promoteFolder}/` : ''}{promoteFilename.trim() || '…'}
              </p>
            </div>
          </div>
          {promoteError && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{promoteError}</p>}
          {promoteResult && (
            <div className="mt-3 rounded-xl border border-green-300/60 bg-green-50 px-3 py-2 text-xs text-green-800 dark:border-green-500/30 dark:bg-green-900/20 dark:text-green-300">
              Promoted successfully — doc moved to group store.
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={() => setShowPromoteModal(false)} className="rounded-xl border border-gray-200 px-4 py-2 text-xs font-semibold text-gray-600 hover:bg-gray-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5">
              Cancel
            </button>
            <button
              type="button"
              disabled={promoteApplying || !promoteFilename.trim() || !!promoteResult}
              onClick={async () => {
                setPromoteError(null);
                setPromoteApplying(true);
                try {
                  const filename = promoteFilename.trim();
                  const target = promoteFolder ? `${promoteFolder}/${filename}` : filename;
                  await applyDocsPromotion([{ source: `.docs/${selectedDoc.path}.md`, target }]);
                  setPromoteResult({ count: 1 });
                  // close modal + deselect + refresh docs list after short delay
                  setTimeout(() => {
                    setShowPromoteModal(false);
                    setSelectedDoc(null);
                    setDocsRefreshKey((c) => c + 1);
                  }, 1200);
                } catch (e) {
                  setPromoteError(e instanceof Error ? e.message : 'Promotion failed');
                } finally {
                  setPromoteApplying(false);
                }
              }}
              className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
            >
              {promoteApplying ? 'Promoting…' : 'Promote & move'}
            </button>
          </div>
        </div>
      </div>
    )}
    {promptState && createPortal(<PromptModal state={promptState} busy={false} onSubmit={submitPrompt} onCancel={cancelPrompt} />, document.body)}
    </>
  );
}