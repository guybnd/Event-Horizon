import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, GripVertical, Plus, Search, X } from 'lucide-react';
import type { Doc } from '../types';

interface FolderNode {
  name: string;
  path: string;
  folders: FolderNode[];
  docs: Doc[];
}

interface DocsSidebarProps {
  docs: Doc[];
  selectedPath: string | null;
  onSelectDoc: (path: string) => void;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  expandedFolders: Record<string, boolean>;
  onToggleFolder: (folderPath: string) => void;
  canCreate: boolean;
  createTargetFolder: string | null;
  newDocPath: string;
  onNewDocPathChange: (value: string) => void;
  newDocTitle: string;
  onNewDocTitleChange: (value: string) => void;
  onOpenCreateForm: (folderPath: string) => void;
  onCancelCreate: () => void;
  onCreateDoc: () => void;
  onReorderDocs: (directory: string, orderedPaths: string[]) => void;
  creating: boolean;
}

function sortDocsForSidebar(docs: Doc[]) {
  return [...docs].sort((left, right) => {
    const leftOrder = left.order ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.order ?? Number.MAX_SAFE_INTEGER;

    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }

    return left.title.localeCompare(right.title, undefined, { sensitivity: 'base' });
  });
}

function buildTree(docs: Doc[]) {
  const root: FolderNode = { name: '', path: '', folders: [], docs: [] };
  const folders = new Map<string, FolderNode>([['', root]]);

  const ensureFolder = (folderPath: string) => {
    const existingFolder = folders.get(folderPath);
    if (existingFolder) {
      return existingFolder;
    }

    const segments = folderPath.split('/').filter(Boolean);
    const name = segments[segments.length - 1] || folderPath;
    const nextFolder: FolderNode = { name, path: folderPath, folders: [], docs: [] };
    folders.set(folderPath, nextFolder);

    const parentPath = segments.slice(0, -1).join('/');
    ensureFolder(parentPath).folders.push(nextFolder);
    return nextFolder;
  };

  docs.forEach((doc) => {
    ensureFolder(doc.directory).docs.push(doc);
  });

  const sortFolder = (folder: FolderNode) => {
    folder.folders.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
    folder.docs = sortDocsForSidebar(folder.docs);
    folder.folders.forEach(sortFolder);
  };

  sortFolder(root);
  return root;
}

function getCreateTargetLabel(folderPath: string) {
  return folderPath ? `Create in ${folderPath}` : 'Create at the docs root';
}

function SortableDocButton({
  doc,
  depth,
  isSelected,
  onSelect,
  dragEnabled,
}: {
  doc: Doc;
  depth: number;
  isSelected: boolean;
  onSelect: () => void;
  dragEnabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: doc.path,
    disabled: !dragEnabled,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    marginLeft: `${depth * 16 + 12}px`,
  };

  return (
    <div ref={setNodeRef} style={style} className="flex items-start gap-1">
      {dragEnabled ? (
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="mt-1 rounded-lg p-1 text-gray-300 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/5 dark:hover:text-gray-300 cursor-grab active:cursor-grabbing"
          title={`Drag to reorder ${doc.title}`}
        >
          <GripVertical className="h-4 w-4" />
        </button>
      ) : (
        <div className="w-6 shrink-0" />
      )}
      <button
        type="button"
        onClick={onSelect}
        className={`flex min-w-0 flex-1 items-start gap-3 rounded-xl px-3 py-2 text-left transition-colors ${isSelected ? 'bg-primary/10 text-primary' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/5'}`}
      >
        <FileText className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{doc.title}</div>
          <div className="truncate text-[11px] text-gray-400">{doc.path}</div>
        </div>
      </button>
    </div>
  );
}

export function DocsSidebar({
  docs,
  selectedPath,
  onSelectDoc,
  searchQuery,
  onSearchQueryChange,
  expandedFolders,
  onToggleFolder,
  canCreate,
  createTargetFolder,
  newDocPath,
  onNewDocPathChange,
  newDocTitle,
  onNewDocTitleChange,
  onOpenCreateForm,
  onCancelCreate,
  onCreateDoc,
  onReorderDocs,
  creating,
}: DocsSidebarProps) {
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const filteredDocs = normalizedSearch
    ? docs.filter((doc) => `${doc.title} ${doc.path}`.toLowerCase().includes(normalizedSearch))
    : docs;
  const tree = buildTree(filteredDocs);
  const forceExpanded = normalizedSearch.length > 0;
  const dragEnabled = normalizedSearch.length === 0 && canCreate;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const docsByPath = new Map(docs.map((doc) => [doc.path, doc]));

  const handleDragEnd = (event: DragEndEvent) => {
    if (!dragEnabled || !event.over || event.active.id === event.over.id) {
      return;
    }

    const activePath = String(event.active.id);
    const overPath = String(event.over.id);
    const activeDoc = docsByPath.get(activePath);
    const overDoc = docsByPath.get(overPath);

    if (!activeDoc || !overDoc || activeDoc.directory !== overDoc.directory) {
      return;
    }

    const directoryDocs = sortDocsForSidebar(docs.filter((doc) => doc.directory === activeDoc.directory));
    const oldIndex = directoryDocs.findIndex((doc) => doc.path === activePath);
    const newIndex = directoryDocs.findIndex((doc) => doc.path === overPath);

    if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) {
      return;
    }

    const reorderedDocs = arrayMove(directoryDocs, oldIndex, newIndex);
    onReorderDocs(activeDoc.directory, reorderedDocs.map((doc) => doc.path));
  };

  const renderCreateForm = (folderPath: string, depth: number) => {
    if (createTargetFolder !== folderPath) {
      return null;
    }

    const isRootTarget = folderPath.length === 0;

    return (
      <div
        className="space-y-3 rounded-2xl border border-gray-200 bg-gray-50/80 p-4 dark:border-white/10 dark:bg-black/20"
        style={isRootTarget ? undefined : { marginLeft: `${depth * 16 + 12}px` }}
      >
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{getCreateTargetLabel(folderPath)}</div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Doc Path</label>
          <input
            value={newDocPath}
            onChange={(event) => onNewDocPathChange(event.target.value)}
            placeholder={isRootTarget ? 'architecture/overview' : 'new-page'}
            className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-primary dark:border-white/10 dark:bg-black/20"
          />
          <p className="mt-1 text-[11px] text-gray-500">
            {isRootTarget
              ? 'Use `/` to create nested folders. The `.md` extension is added automatically.'
              : 'Enter the child doc name or a nested path relative to this folder.'}
          </p>
        </div>

        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Title</label>
          <input
            value={newDocTitle}
            onChange={(event) => onNewDocTitleChange(event.target.value)}
            placeholder="Overview"
            className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-primary dark:border-white/10 dark:bg-black/20"
          />
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCreateDoc}
            disabled={creating || (!newDocPath.trim() && !newDocTitle.trim())}
            className={`flex-1 rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${creating || (!newDocPath.trim() && !newDocTitle.trim()) ? 'bg-gray-200 text-gray-400 dark:bg-white/10 dark:text-gray-500' : 'bg-primary text-white hover:bg-primary-hover'}`}
          >
            {creating ? 'Creating...' : 'Create Doc'}
          </button>
          <button
            type="button"
            onClick={onCancelCreate}
            className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-600 transition-colors hover:bg-gray-100 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  };

  const renderDocButton = (doc: Doc, depth: number) => (
    <SortableDocButton
      key={doc.path}
      doc={doc}
      depth={depth}
      isSelected={selectedPath === doc.path}
      onSelect={() => onSelectDoc(doc.path)}
      dragEnabled={dragEnabled}
    />
  );

  const renderFolder = (folder: FolderNode, depth: number) => {
    const isExpanded = forceExpanded || expandedFolders[folder.path] !== false || createTargetFolder === folder.path;

    return (
      <div key={folder.path} className="space-y-1">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onToggleFolder(folder.path)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/5"
            style={{ paddingLeft: `${depth * 16 + 12}px` }}
          >
            {isExpanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
            {isExpanded ? <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" /> : <Folder className="h-4 w-4 shrink-0 text-amber-500" />}
            <span className="truncate">{folder.name}</span>
          </button>

          {canCreate && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onOpenCreateForm(folder.path);
              }}
              className="rounded-xl p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/5 dark:hover:text-gray-200"
              title={`Create a doc in ${folder.path}`}
            >
              <Plus className="h-4 w-4" />
            </button>
          )}
        </div>

        {isExpanded && (
          <div className="space-y-1">
            {renderCreateForm(folder.path, depth + 1)}
            <SortableContext items={folder.docs.map((doc) => doc.path)} strategy={verticalListSortingStrategy}>
              {folder.docs.map((doc) => renderDocButton(doc, depth + 1))}
            </SortableContext>
            {folder.folders.map((childFolder) => renderFolder(childFolder, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="rounded-[28px] border border-gray-200 bg-white/80 p-4 shadow-xl shadow-gray-200/60 dark:border-white/10 dark:bg-[#161720] dark:shadow-none">
      <div className="flex items-center gap-3 border-b border-gray-200 pb-4 dark:border-white/10">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
          <FolderOpen className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h2 className="truncate text-base font-bold text-gray-900 dark:text-gray-100">Docs Library</h2>
          <p className="text-xs text-gray-500">Browse the workspace docs hierarchy and create pages where they belong.</p>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <div className="flex items-center gap-2 rounded-2xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600 dark:border-white/10 dark:bg-black/20 dark:text-gray-300">
          <Search className="h-4 w-4 text-gray-400" />
          <input
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            placeholder="Find docs by title or path"
            className="w-full bg-transparent outline-none placeholder:text-gray-400"
          />
          {searchQuery && (
            <button type="button" onClick={() => onSearchQueryChange('')} className="text-gray-400 transition-colors hover:text-gray-600 dark:hover:text-gray-200">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={() => onOpenCreateForm('')}
          disabled={!canCreate}
          className={`flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold transition-colors ${canCreate ? 'bg-primary text-white hover:bg-primary-hover' : 'bg-gray-200 text-gray-400 dark:bg-white/10 dark:text-gray-500'}`}
        >
          <Plus className="h-4 w-4" /> New Doc
        </button>

        {!canCreate && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
            This account has read-only docs access. Update the Docs Permissions setting to enable editing.
          </div>
        )}

        {renderCreateForm('', 0)}
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <div className="mt-4 max-h-[calc(100vh-18rem)] space-y-1 overflow-y-auto pr-1">
          {filteredDocs.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-gray-200 px-4 py-6 text-center text-sm text-gray-500 dark:border-white/10">
              {docs.length === 0 ? 'No docs yet. Create the first page to start the knowledge base.' : 'No docs matched the current search.'}
            </div>
          ) : (
            <>
              <SortableContext items={tree.docs.map((doc) => doc.path)} strategy={verticalListSortingStrategy}>
                {tree.docs.map((doc) => renderDocButton(doc, 0))}
              </SortableContext>
              {tree.folders.map((folder) => renderFolder(folder, 0))}
            </>
          )}
        </div>
      </DndContext>
    </aside>
  );
}