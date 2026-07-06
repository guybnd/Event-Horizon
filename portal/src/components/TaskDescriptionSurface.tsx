import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Image from '@tiptap/extension-image';
import { Table } from '@tiptap/extension-table';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { marked } from 'marked';
import { Bold, Code, Eye, Heading1, Heading2, Italic, Link as LinkIcon, List, ListOrdered } from 'lucide-react';
import { buildUnsupportedImageMessage, uploadTaskImageMarkdownLinks } from '../taskAssetUploads';
import { normalizeTaskMarkdownBody, resolveTaskMarkdownHref } from '../taskMarkdownUtils';
import { parseAcceptanceCriteriaProgress } from '../lib/acceptanceCriteria';
import { EpicProgressBar } from './EpicProgressBar';

type TaskDescriptionSurfaceMode = 'popup' | 'full' | 'backlog';

marked.setOptions({ gfm: true, breaks: false });

const normalizeMarkdownBody = normalizeTaskMarkdownBody;

function renderMarkdownToHtml(markdown: string) {
  const rendered = marked.parse(markdown) as string;
  return rendered || '<p></p>';
}

function createTurndownService() {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });

  service.use(gfm);

  return service;
}

function getEditorDocumentSnapshot(editor: { getJSON: () => unknown }) {
  return JSON.stringify(editor.getJSON());
}

function getMarkdownImageParts(markdownLink: string) {
  const match = markdownLink.match(/^!\[(.*)\]\((.*)\)$/);
  if (!match) {
    return null;
  }

  return {
    alt: match[1] || '',
    src: match[2] || '',
  };
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
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      className={`flex h-7 w-7 items-center justify-center rounded-lg border transition-colors ${active ? 'border-primary bg-primary/10 text-primary' : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-100 dark:border-white/10 dark:bg-black/20 dark:text-gray-300 dark:hover:bg-white/5'} ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
    >
      <div className="scale-75 flex items-center justify-center">
        {children}
      </div>
    </button>
  );
}

export function TaskDescriptionSurface({
  value,
  onChange,
  taskId,
  mode = 'popup',
  emptyMessage = 'No description yet.',
  compact = false,
  hidePreviewHeader = false,
  placeholder = 'Click to edit description...',
  onSave,
  onCancel,
  saveDisabled = false,
  saveLabel = 'Save description',
  isSaving = false,
}: {
  value: string;
  onChange: (value: string) => void;
  taskId?: string;
  mode?: TaskDescriptionSurfaceMode;
  emptyMessage?: string;
  compact?: boolean;
  /** FLUX-744: hide the non-editing "Rendered Markdown / Click description to edit" header bar. The
   *  ticket sideview sets this — the bar is dead space there, and its save/dirty state is surfaced by
   *  the shared metadata bar instead. Defaults to shown so the legacy modal views are unaffected. */
  hidePreviewHeader?: boolean;
  placeholder?: string;
  onSave?: () => Promise<void> | void;
  onCancel?: () => void;
  saveDisabled?: boolean;
  saveLabel?: string;
  isSaving?: boolean;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [assetError, setAssetError] = useState('');

  const [isAssetDragOver, setIsAssetDragOver] = useState(false);
  const [isEditorFocused, setIsEditorFocused] = useState(false);
  const [hasTextSelection, setHasTextSelection] = useState(false);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const turndownServiceRef = useRef<TurndownService | null>(null);
  const isApplyingEditorContentRef = useRef(false);
  const lastSyncedValueRef = useRef<string | null>(null);
  const editorSnapshotRef = useRef('');
  const hasPendingUserEditRef = useRef(false);
  const pendingFocusPositionRef = useRef<number | null>(null);

  if (!turndownServiceRef.current) {
    turndownServiceRef.current = createTurndownService();
  }

  const syncEditorSelectionState = (activeEditor: NonNullable<typeof editor>) => {
    const { from, to } = activeEditor.state.selection;
    setHasTextSelection(from !== to);
  };

  const markUserEditIntent = () => {
    hasPendingUserEditRef.current = true;
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        link: {
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
          defaultProtocol: 'https',
        },
      }),
      Image,
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Placeholder.configure({ placeholder }),
    ],
    content: '<p></p>',
    editable: false,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: `${mode === 'full' ? 'min-h-[20rem]' : compact ? 'min-h-[12rem]' : 'min-h-[16rem]'} docs-editor-content task-description-editor-content w-full px-4 py-4 ${compact ? 'text-sm leading-6' : 'text-base leading-7'} text-gray-900 outline-none dark:text-gray-100`,
      },
      handleDOMEvents: {
        beforeinput: () => {
          markUserEditIntent();
          return false;
        },
        drop: () => {
          markUserEditIntent();
          return false;
        },
        paste: () => {
          markUserEditIntent();
          return false;
        },
      },
    },
    onUpdate: ({ editor: activeEditor }) => {
      if (isApplyingEditorContentRef.current) {
        return;
      }

      const nextSnapshot = getEditorDocumentSnapshot(activeEditor);
      if (nextSnapshot === editorSnapshotRef.current) {
        syncResolvedEditorLinks();
        return;
      }

      const nextMarkdown = normalizeMarkdownBody(turndownServiceRef.current?.turndown(activeEditor.getHTML()) || '');
      editorSnapshotRef.current = nextSnapshot;

      if (!hasPendingUserEditRef.current && nextMarkdown !== lastSyncedValueRef.current) {
        syncResolvedEditorLinks();
        return;
      }

      lastSyncedValueRef.current = nextMarkdown;
      hasPendingUserEditRef.current = false;
      onChange(nextMarkdown);
      syncResolvedEditorLinks();
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

  function syncResolvedEditorLinks() {
    if (!editor) {
      return;
    }

    requestAnimationFrame(() => {
      const editorRoot = editor.view.dom;

      editorRoot.querySelectorAll('img[src]').forEach((node) => {
        const rawSrc = node.getAttribute('src');
        const resolvedSrc = resolveTaskMarkdownHref(taskId, rawSrc ?? undefined);

        if (resolvedSrc && resolvedSrc !== rawSrc) {
          node.setAttribute('src', resolvedSrc);
        }
      });

      editorRoot.querySelectorAll('a[href]').forEach((node) => {
        const rawHref = node.getAttribute('href');
        const resolvedHref = resolveTaskMarkdownHref(taskId, rawHref ?? undefined);

        if (resolvedHref && resolvedHref !== rawHref) {
          node.setAttribute('href', resolvedHref);
        }

        if (resolvedHref && /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(resolvedHref)) {
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noreferrer');
        }
      });
    });
  }

  useEffect(() => {
    setAssetError('');
  }, [taskId]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    const normalizedValue = normalizeMarkdownBody(value);
    if (lastSyncedValueRef.current === normalizedValue) {
      syncResolvedEditorLinks();
      return;
    }

    isApplyingEditorContentRef.current = true;
    editor.commands.setContent(renderMarkdownToHtml(normalizedValue), { emitUpdate: false });
    editorSnapshotRef.current = getEditorDocumentSnapshot(editor);
    lastSyncedValueRef.current = normalizedValue;

    queueMicrotask(() => {
      isApplyingEditorContentRef.current = false;
      syncResolvedEditorLinks();
    });
  }, [editor, taskId, value]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    editor.setEditable(isEditing);
    editor.view.dom.classList.toggle('task-description-readonly-surface', !isEditing);
    if (isEditing) {
      const focusPosition = pendingFocusPositionRef.current;
      pendingFocusPositionRef.current = null;

      requestAnimationFrame(() => {
        const chain = editor.chain();

        if (typeof focusPosition === 'number') {
          chain.focus(focusPosition);
        } else {
          chain.focus();
        }

        chain.run();
        syncEditorSelectionState(editor);
        syncResolvedEditorLinks();
      });

      return;
    }

    pendingFocusPositionRef.current = null;
  }, [editor, isEditing]);

  useEffect(() => {
    if (!isEditing) {
      return undefined;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && surfaceRef.current?.contains(target)) {
        return;
      }

      setIsEditing(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [isEditing]);

  // FLUX-1148: advisory "X/Y criteria checked" indicator parsed from the ticket's own
  // `## Acceptance criteria` body section — null (no badge) when there's no such section.
  const acceptanceCriteria = parseAcceptanceCriteriaProgress(value);

  const overflowClass = mode === 'backlog' ? '' : 'overflow-hidden';
  const surfaceClassName = mode === 'full'
    ? `flex min-h-0 flex-1 flex-col ${overflowClass} rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-white/10 dark:bg-black/20`
    : `flex min-h-0 flex-1 flex-col ${overflowClass} rounded-xl border border-gray-200 bg-gray-50 dark:border-white/10 dark:bg-black/20`;
  const showToolbarActiveState = isEditorFocused && hasTextSelection;
  const hasPendingLocalDraft = Boolean(onSave && !saveDisabled);
  const isEmpty = normalizeMarkdownBody(value).trim().length === 0;

  const insertUploadedImages = (markdownLinks: string[]) => {
    if (!editor || markdownLinks.length === 0) {
      return;
    }

    const content = markdownLinks.flatMap((markdownLink) => {
      const parts = getMarkdownImageParts(markdownLink);
      if (!parts) {
        return [];
      }

      return [
        { type: 'image', attrs: { src: parts.src, alt: parts.alt } },
        { type: 'paragraph' },
      ];
    });

    if (content.length === 0) {
      return;
    }

    markUserEditIntent();
    editor.chain().focus().insertContent(content).run();
    syncResolvedEditorLinks();
  };

  const attachImageFiles = async (files: File[]) => {
    if (files.length === 0) {
      return;
    }

    if (!taskId) {
      setAssetError('Save the ticket before attaching images.');
      return;
    }


    setAssetError('');

    try {
      const { markdownLinks, unsupportedFiles } = await uploadTaskImageMarkdownLinks(taskId, files);

      if (markdownLinks.length === 0) {
        setAssetError(buildUnsupportedImageMessage(unsupportedFiles));
        return;
      }

      insertUploadedImages(markdownLinks);

      if (unsupportedFiles.length > 0) {
        setAssetError(buildUnsupportedImageMessage(unsupportedFiles));
      }
    } catch (error) {
      console.error(error);
      setAssetError(error instanceof Error ? error.message : 'Failed to attach image.');
    }
  };

  const handleEditorSurfaceMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (isEditing) {
      return;
    }

    const targetElement = event.target as HTMLElement;
    const anchor = targetElement.closest('a');
    if (anchor) {
      return;
    }

    const interactiveTarget = targetElement.closest('button, input, textarea, select');
    if (interactiveTarget) {
      return;
    }

    pendingFocusPositionRef.current = editor?.view.posAtCoords({
      left: event.clientX,
      top: event.clientY,
    })?.pos ?? null;
    event.preventDefault();
    setIsEditing(true);
  };

  const handleEditorSurfaceClick = (event: MouseEvent<HTMLDivElement>) => {
    if (isEditing) {
      return;
    }

    const targetElement = event.target as HTMLElement;
    const anchor = targetElement.closest('a');
    if (!anchor) {
      return;
    }

    event.preventDefault();

    const href = anchor.getAttribute('href') || '';
    const resolvedHref = resolveTaskMarkdownHref(taskId, href || undefined) || href;
    if (resolvedHref) {
      window.open(resolvedHref, '_blank', 'noopener,noreferrer');
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (!isEditing) {
      return;
    }

    const files = Array.from(event.clipboardData.files || []);
    if (files.length === 0) {
      return;
    }

    event.preventDefault();
    void attachImageFiles(files);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!isEditing) {
      return;
    }

    if (!Array.from(event.dataTransfer.types || []).includes('Files')) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setIsAssetDragOver(true);
  };

  const handleDragLeave = () => {
    if (!isEditing) {
      return;
    }

    setIsAssetDragOver(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!isEditing) {
      return;
    }

    const files = Array.from(event.dataTransfer.files || []);

    setIsAssetDragOver(false);
    if (files.length === 0) {
      return;
    }

    event.preventDefault();
    void attachImageFiles(files);
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
      markUserEditIntent();
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }

    if (editor.state.selection.empty) {
      markUserEditIntent();
      editor.chain().focus().insertContent({
        type: 'text',
        text: nextLink.trim(),
        marks: [{ type: 'link', attrs: { href: nextLink.trim() } }],
      }).run();
      return;
    }

    markUserEditIntent();
    editor.chain().focus().extendMarkRange('link').setLink({ href: nextLink.trim() }).run();
  };

  const runFormattingCommand = (command: () => void) => {
    markUserEditIntent();
    command();
  };

  const handleSaveClick = () => {
    if (!onSave) {
      return;
    }

    void Promise.resolve(onSave())
      .then(() => {
        setIsEditing(false);
      })
      .catch(() => {
        // Parent surface owns the save error state.
      });
  };

  const handleCancelClick = () => {
    setAssetError('');
    onCancel?.();
    setIsEditing(false);
  };

  return (
    <div ref={surfaceRef} className={`${surfaceClassName} ${isEditing && isAssetDragOver ? 'border-primary bg-primary/5 dark:border-primary/70 dark:bg-primary/10' : ''}`}>
      {isEditing ? (
        <>
            <div className="sticky top-0 z-20 mx-3 mt-3 mb-2 flex w-fit flex-wrap items-center gap-1 rounded-2xl border border-gray-200 bg-gray-50/90 px-2 py-1.5 shadow-sm backdrop-blur dark:border-white/10 dark:bg-[#161720]/90">
            <ToolbarButton label="Preview" onClick={() => setIsEditing(false)} disabled={isSaving}>
              <Eye className="h-4 w-4" />
            </ToolbarButton>
<ToolbarButton label="Heading 1" active={showToolbarActiveState && Boolean(editor?.isActive('heading', { level: 1 }))} onClick={() => runFormattingCommand(() => editor?.chain().focus().toggleHeading({ level: 1 }).run())} disabled={!editor || isSaving}>
                <Heading1 className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton label="Heading 2" active={showToolbarActiveState && Boolean(editor?.isActive('heading', { level: 2 }))} onClick={() => runFormattingCommand(() => editor?.chain().focus().toggleHeading({ level: 2 }).run())} disabled={!editor || isSaving}>
                <Heading2 className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton label="Bold" active={showToolbarActiveState && Boolean(editor?.isActive('bold'))} onClick={() => runFormattingCommand(() => editor?.chain().focus().toggleBold().run())} disabled={!editor || isSaving}>
                <Bold className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton label="Italic" active={showToolbarActiveState && Boolean(editor?.isActive('italic'))} onClick={() => runFormattingCommand(() => editor?.chain().focus().toggleItalic().run())} disabled={!editor || isSaving}>
                <Italic className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton label="Bullet List" active={showToolbarActiveState && Boolean(editor?.isActive('bulletList'))} onClick={() => runFormattingCommand(() => editor?.chain().focus().toggleBulletList().run())} disabled={!editor || isSaving}>
                <List className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton label="Numbered List" active={showToolbarActiveState && Boolean(editor?.isActive('orderedList'))} onClick={() => runFormattingCommand(() => editor?.chain().focus().toggleOrderedList().run())} disabled={!editor || isSaving}>
                <ListOrdered className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton label="Code Block" active={showToolbarActiveState && Boolean(editor?.isActive('codeBlock'))} onClick={() => runFormattingCommand(() => editor?.chain().focus().toggleCodeBlock().run())} disabled={!editor || isSaving}>
                <Code className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton label="Link" active={showToolbarActiveState && Boolean(editor?.isActive('link'))} onClick={handleSetLink} disabled={!editor || isSaving}>
              <LinkIcon className="h-4 w-4" />
            </ToolbarButton>
          </div>

        </>
      ) : hidePreviewHeader ? null : (
        <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-4 py-3 text-xs dark:border-white/10">
          <span className="font-bold uppercase tracking-wider text-gray-400">Rendered Markdown</span>
          <div className="flex items-center gap-3">
            {acceptanceCriteria && (
              <span
                className="flex items-center gap-1.5 font-semibold text-gray-500 dark:text-gray-400"
                title="Acceptance criteria checked (advisory — not a gate)"
              >
                <span className="w-12"><EpicProgressBar done={acceptanceCriteria.done} total={acceptanceCriteria.total} fillClass="bg-sky-500 dark:bg-sky-400" /></span>
                {acceptanceCriteria.done}/{acceptanceCriteria.total} criteria
              </span>
            )}
            <span className={`rounded-full px-3 py-1 font-semibold ${hasPendingLocalDraft ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-200' : 'bg-gray-100 text-gray-500 dark:bg-white/10 dark:text-gray-300'}`}>
              {hasPendingLocalDraft ? 'Unsaved draft' : 'Click description to edit'}
            </span>
          </div>
        </div>
      )}

      {assetError && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
          {assetError}
        </div>
      )}

      <div
        className={`task-description-editor-shell relative min-h-0 flex-1 overflow-y-auto ${!isEditing ? 'cursor-text' : ''}`}
        onMouseDownCapture={handleEditorSurfaceMouseDown}
        onClickCapture={handleEditorSurfaceClick}
        onPaste={handlePaste}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {!isEditing && isEmpty && (
          <div className="pointer-events-none absolute inset-0 px-4 py-4 text-sm italic text-gray-400 dark:text-gray-500">
            {emptyMessage}
          </div>
        )}
        <EditorContent editor={editor} />
      </div>

      {(onSave || onCancel) && (isEditing || hasPendingLocalDraft) && (
        <div className="flex items-center justify-end gap-3 border-t border-gray-200 px-4 py-3 dark:border-white/10">
          {onCancel && (
            <button
              type="button"
              onClick={handleCancelClick}
              disabled={isSaving}
              className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-600 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
            >
              Cancel
            </button>
          )}
          {onSave && (
            <button
              type="button"
              onClick={handleSaveClick}
              disabled={saveDisabled || isSaving}
              className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${saveDisabled || isSaving ? 'cursor-not-allowed bg-gray-200 text-gray-400 dark:bg-white/10 dark:text-gray-500' : 'bg-primary text-white hover:bg-primary-hover'}`}
            >
              {isSaving ? 'Saving...' : saveLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
