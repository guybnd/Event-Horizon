import { useState, useEffect } from 'react';
import { useApp } from '../AppContext';
import { Save, Plus, X, GripVertical, AlertCircle, ChevronUp, ChevronDown, Equal } from 'lucide-react';
import { bulkRename, fetchSkillStatus, installWorkspaceSkill } from '../api';
import type { TagDef, StatusDef, UserDef, PriorityDef, DocsEditPermissions, BoardCardOpenMode } from '../types';
import { StatusBadge } from './StatusBadge';
import { getDefaultStatusColor, STATUS_COLOR_PALETTE } from '../statusStyles';
import { DEFAULT_READY_FOR_MERGE_STATUS, DEFAULT_REQUIRE_INPUT_STATUS, DEFAULT_ARCHIVE_STATUS } from '../workflow';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

const COLOR_PALETTE = [
  'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-400',
];

const SWATCH_COLORS: Record<string, string> = {
  gray: '#9ca3af',
  red: '#ef4444',
  orange: '#f97316',
  amber: '#f59e0b',
  emerald: '#10b981',
  blue: '#3b82f6',
  sky: '#0ea5e9',
  purple: '#8b5cf6',
  pink: '#ec4899',
};

function getPaletteSwatchColor(colorClass: string) {
  const match = colorClass.match(/(?:bg|text)-([a-z]+)-\d+/);
  if (!match) return SWATCH_COLORS.gray;

  return SWATCH_COLORS[match[1]] || SWATCH_COLORS.gray;
}

const TagEditor = ({ items, setItems }: { items: TagDef[], setItems: (items: TagDef[]) => void }) => {
  const [editingIdx, setEditingIdx] = useState<number | null>(null);

  return (
    <div className="space-y-3">
      {items.map((item, idx) => (
        <div key={idx} className="flex gap-4 items-center bg-gray-50 dark:bg-black/10 p-2 rounded-xl border border-gray-100 dark:border-white/5">
          <div className="w-40 flex items-center">
            {editingIdx === idx ? (
              <input 
                autoFocus
                value={item.name} 
                onChange={e => { const newArr = [...items]; newArr[idx].name = e.target.value; setItems(newArr); }}
                onBlur={() => setEditingIdx(null)}
                onKeyDown={(e) => { if (e.key === 'Enter') setEditingIdx(null); }}
                className="w-full bg-white dark:bg-black/40 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-1.5 outline-none focus:border-primary text-sm font-medium"
                placeholder="Tag Name"
              />
            ) : (
              <div 
                onClick={() => setEditingIdx(idx)}
                className={`px-3 py-1 rounded-md text-xs font-bold cursor-pointer transition-all hover:opacity-80 border border-transparent hover:border-black/10 dark:hover:border-white/20 w-fit ${item.color || COLOR_PALETTE[0]}`}
              >
                {item.name || 'Unnamed Tag'}
              </div>
            )}
          </div>
          
          <div className="flex gap-1.5 flex-wrap flex-1 border-l border-gray-200 dark:border-white/10 pl-4">
            {COLOR_PALETTE.map(color => (
              <button 
                key={color} 
                onClick={() => { const newArr = [...items]; newArr[idx].color = color; setItems(newArr); }}
                className={`w-6 h-6 rounded-full border-2 transition-all ${item.color === color ? 'border-primary shadow-sm scale-110' : 'border-transparent hover:scale-105'}`}
                style={{ backgroundColor: getPaletteSwatchColor(color) }}
              />
            ))}
          </div>
          <button onClick={() => setItems(items.filter((_, i) => i !== idx))} className="p-1.5 ml-auto text-gray-400 hover:text-red-500 rounded"><X className="w-4 h-4" /></button>
        </div>
      ))}
      <button onClick={() => setItems([...items, { name: '', color: COLOR_PALETTE[0] }])} className="flex items-center gap-1 text-xs font-bold text-primary hover:text-primary-hover px-2 py-1"><Plus className="w-3 h-3" /> Add Tag</button>
    </div>
  );
};

const StatusColorPicker = ({
  status,
  color,
  onChange,
}: {
  status: string;
  color?: string;
  onChange: (color: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  const resolvedColor = color || getDefaultStatusColor(status);

  return (
    <div
      className="relative shrink-0"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex h-11 w-44 items-center overflow-hidden rounded-xl border border-gray-200 bg-white px-2.5 transition-colors hover:border-primary/60 hover:bg-gray-50 dark:border-white/10 dark:bg-black/20 dark:hover:bg-white/5"
      >
        <StatusBadge
          status={status}
          colorClass={resolvedColor}
          className="max-w-full overflow-hidden text-[10px] font-bold uppercase tracking-[0.16em]"
        />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-20 mt-2 w-44 rounded-2xl border border-gray-200 bg-white p-3 shadow-lg dark:border-white/10 dark:bg-[#1a1b23]">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-gray-500 dark:text-gray-400">
            Status Color
          </div>
          <div className="grid grid-cols-4 gap-2">
            {STATUS_COLOR_PALETTE.map((paletteColor) => (
              <button
                key={paletteColor}
                type="button"
                onClick={() => {
                  onChange(paletteColor);
                  setOpen(false);
                }}
                className={`h-8 rounded-full border-2 transition-all ${resolvedColor === paletteColor ? 'border-primary shadow-sm scale-105' : 'border-transparent hover:scale-105'}`}
                style={{ backgroundColor: getPaletteSwatchColor(paletteColor) }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const StatusEditor = ({ items, setItems, placeholder, sortable = false }: { items: StatusDef[], setItems: (items: StatusDef[]) => void, placeholder: string, sortable?: boolean }) => {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragEnd = (event: DragEndEvent) => {
    if (!sortable) return;

    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = items.findIndex((_, i) => `status-${i}` === active.id);
    const newIndex = items.findIndex((_, i) => `status-${i}` === over.id);
    if (oldIndex !== -1 && newIndex !== -1) {
      setItems(arrayMove(items, oldIndex, newIndex));
    }
  };

  const rows = items.map((item, idx) => {
    const row = (
      <div className="flex flex-1 min-w-0 gap-3 items-center bg-gray-50 dark:bg-black/10 p-2 rounded-xl border border-gray-100 dark:border-white/5">
        <StatusColorPicker
          status={item.name || 'Unnamed Status'}
          color={item.color}
          onChange={(color) => {
            const newArr = [...items];
            newArr[idx].color = color;
            setItems(newArr);
          }}
        />
        <input
          value={item.name}
          onChange={e => { const newArr = [...items]; newArr[idx].name = e.target.value; setItems(newArr); }}
          className="min-w-0 flex-1 bg-white dark:bg-black/40 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-1.5 outline-none focus:border-primary text-sm font-medium"
          placeholder={placeholder}
        />
        <button onClick={() => setItems(items.filter((_, i) => i !== idx))} className="p-1.5 ml-auto text-gray-400 hover:text-red-500 rounded"><X className="w-4 h-4" /></button>
      </div>
    );

    if (sortable) {
      return <SortableRow key={`status-${idx}`} id={`status-${idx}`}>{row}</SortableRow>;
    }

    return <div key={`status-${idx}`}>{row}</div>;
  });

  const content = sortable ? (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={items.map((_, i) => `status-${i}`)} strategy={verticalListSortingStrategy}>
        {rows}
      </SortableContext>
    </DndContext>
  ) : <>{rows}</>;

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-gray-500 dark:text-gray-400">Click a status badge to change its color.</p>
      {content}
      <button onClick={() => setItems([...items, { name: '', color: STATUS_COLOR_PALETTE[0] }])} className="flex items-center gap-1 text-xs font-bold text-primary hover:text-primary-hover px-2 py-1"><Plus className="w-3 h-3" /> Add Status</button>
    </div>
  );
};

const PriorityEditor = ({ items, setItems }: { items: PriorityDef[], setItems: (items: PriorityDef[]) => void }) => {
  const PRIORITY_COLORS = ['text-red-500', 'text-orange-500', 'text-amber-500', 'text-emerald-500', 'text-blue-500', 'text-purple-500', 'text-gray-400'];
  const PRIORITY_ICONS = ['AlertCircle', 'ChevronUp', 'Equals', 'ChevronDown'];
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = items.findIndex((_, i) => `priority-${i}` === active.id);
    const newIndex = items.findIndex((_, i) => `priority-${i}` === over.id);
    if (oldIndex !== -1 && newIndex !== -1) {
      setItems(arrayMove(items, oldIndex, newIndex));
    }
  };

  return (
    <div className="space-y-3">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={items.map((_, i) => `priority-${i}`)} strategy={verticalListSortingStrategy}>
          {items.map((item, idx) => (
            <SortableRow key={`priority-${idx}`} id={`priority-${idx}`}>
              <div className="flex flex-1 gap-4 items-center bg-gray-50 dark:bg-black/10 p-2 rounded-xl border border-gray-100 dark:border-white/5">
                <input 
                  value={item.name} 
                  onChange={e => { const newArr = [...items]; newArr[idx].name = e.target.value; setItems(newArr); }}
                  className="w-32 bg-white dark:bg-black/40 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-1.5 outline-none focus:border-primary text-sm font-medium"
                  placeholder="Priority Name"
                />
                
                <div className="flex gap-1.5 border-l border-gray-200 dark:border-white/10 pl-4 items-center">
                  {PRIORITY_ICONS.map(icon => (
                    <button 
                      key={icon} 
                      onClick={() => { const newArr = [...items]; newArr[idx].icon = icon === 'Equals' ? 'Equal' : icon; setItems(newArr); }}
                      className={`p-1.5 rounded transition-all ${item.icon === (icon === 'Equals' ? 'Equal' : icon) ? 'bg-primary/20 text-primary' : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5'}`}
                    >
                      {icon === 'AlertCircle' && <AlertCircle className="w-4 h-4" />}
                      {icon === 'ChevronUp' && <ChevronUp className="w-4 h-4" />}
                      {icon === 'Equals' && <Equal className="w-4 h-4" />}
                      {icon === 'ChevronDown' && <ChevronDown className="w-4 h-4" />}
                    </button>
                  ))}
                </div>

                <div className="flex gap-1.5 border-l border-gray-200 dark:border-white/10 pl-4">
                  {PRIORITY_COLORS.map(color => (
                    <button 
                      key={color} 
                      onClick={() => { const newArr = [...items]; newArr[idx].color = color; setItems(newArr); }}
                      className={`w-6 h-6 rounded-full border-2 transition-all ${item.color === color ? 'border-primary shadow-sm scale-110' : 'border-transparent hover:scale-105'}`}
                      style={{
                        backgroundColor:
                          color === 'text-red-500' ? '#ef4444' :
                          color === 'text-orange-500' ? '#f97316' :
                          color === 'text-amber-500' ? '#f59e0b' :
                          color === 'text-emerald-500' ? '#10b981' :
                          color === 'text-blue-500' ? '#3b82f6' :
                          color === 'text-purple-500' ? '#8b5cf6' : '#9ca3af'
                      }}
                    />
                  ))}
                </div>
                <button onClick={() => setItems(items.filter((_, i) => i !== idx))} className="p-1.5 ml-auto text-gray-400 hover:text-red-500 rounded"><X className="w-4 h-4" /></button>
              </div>
            </SortableRow>
          ))}
        </SortableContext>
      </DndContext>
      <button onClick={() => setItems([...items, { name: '', color: PRIORITY_COLORS[0], icon: PRIORITY_ICONS[0] }])} className="flex items-center gap-1 text-xs font-bold text-primary hover:text-primary-hover px-2 py-1"><Plus className="w-3 h-3" /> Add Priority</button>
    </div>
  );
};

function SortableRow({ id, children }: { id: string, children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} className="flex gap-2 items-center">
      <button {...listeners} {...attributes} className="cursor-grab active:cursor-grabbing p-1 text-gray-300 hover:text-gray-500 dark:text-gray-600 dark:hover:text-gray-400 transition-colors">
        <GripVertical className="w-4 h-4" />
      </button>
      {children}
    </div>
  );
}

function SettingToggleCard({
  title,
  description,
  checked,
  onChange,
  children
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <span className="block text-sm font-bold text-gray-800 dark:text-gray-200 mb-0.5" onClick={() => onChange(!checked)} style={{ cursor: 'pointer' }}>{title}</span>
          <span className="text-xs text-gray-500 text-balance pr-4">{description}</span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {children}
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={checked}
              onChange={(e) => onChange(e.target.checked)}
            />
            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-primary"></div>
          </label>
        </div>
      </div>
    </div>
  );
}

const SimpleEditor = ({ items, setItems, placeholder, sortable = false }: { items: {name: string, originalName?: string}[], setItems: (items: any[]) => void, placeholder: string, sortable?: boolean }) => {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = items.findIndex((_, i) => `item-${i}` === active.id);
    const newIndex = items.findIndex((_, i) => `item-${i}` === over.id);
    if (oldIndex !== -1 && newIndex !== -1) {
      setItems(arrayMove(items, oldIndex, newIndex));
    }
  };

  const rows = items.map((item, idx) => {
    const row = (
      <>
        <input 
          value={item.name} 
          onChange={e => { const newArr = [...items]; newArr[idx].name = e.target.value; setItems(newArr); }}
          className="flex-1 bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-1.5 outline-none focus:border-primary text-sm font-medium"
          placeholder={placeholder}
        />
        <button onClick={() => setItems(items.filter((_, i) => i !== idx))} className="p-1.5 text-gray-400 hover:text-red-500 rounded"><X className="w-4 h-4" /></button>
      </>
    );

    if (sortable) {
      return <SortableRow key={`item-${idx}`} id={`item-${idx}`}>{row}</SortableRow>;
    }
    return <div key={idx} className="flex gap-2 items-center">{row}</div>;
  });

  const content = sortable ? (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={items.map((_, i) => `item-${i}`)} strategy={verticalListSortingStrategy}>
        {rows}
      </SortableContext>
    </DndContext>
  ) : <>{rows}</>;

  return (
    <div className="space-y-2">
      {content}
      <button onClick={() => setItems([...items, { name: '' }])} className="flex items-center gap-1 text-xs font-bold text-primary hover:text-primary-hover px-2 py-1"><Plus className="w-3 h-3" /> Add Item</button>
    </div>
  );
};

export function Settings() {
  const { config, saveConfig, triggerRefresh, setView } = useApp();
  
  const [activeTab, setActiveTab] = useState<'workflow' | 'attributes' | 'workspace' | 'preferences' | 'agent'>('workflow');
  const [columns, setColumns] = useState<StatusDef[]>([]);
  const [hiddenStatuses, setHiddenStatuses] = useState<StatusDef[]>([]);
  const [users, setUsers] = useState<UserDef[]>([]);
  const [tags, setTags] = useState<TagDef[]>([]);
  const [priorities, setPriorities] = useState<PriorityDef[]>([]);
  const [projects, setProjects] = useState('');
  const [enableBacklog, setEnableBacklog] = useState(true);
  const [requireComment, setRequireComment] = useState(true);
  const [boardCardOpenMode, setBoardCardOpenMode] = useState<BoardCardOpenMode>('full');
  const [animationsEnabled, setAnimationsEnabled] = useState(true);
  const [enableFireworks, setEnableFireworks] = useState(true);
  const [animationSpeed, setAnimationSpeed] = useState<'fast' | 'normal' | 'slow'>('normal');
  const [requireInputStatus, setRequireInputStatus] = useState(DEFAULT_REQUIRE_INPUT_STATUS);
  const [readyForMergeStatus, setReadyForMergeStatus] = useState(DEFAULT_READY_FOR_MERGE_STATUS);
  const [archiveStatus, setArchiveStatus] = useState(DEFAULT_ARCHIVE_STATUS);
  const [docsEditPermissions, setDocsEditPermissions] = useState<DocsEditPermissions>('all');
  const [docsAllowedUsers, setDocsAllowedUsers] = useState<string[]>([]);
  const [docsRoot, setDocsRoot] = useState('.docs');
  const [hoverPopupsEnabled, setHoverPopupsEnabled] = useState(true);
  const [hoverPopupDelay, setHoverPopupDelay] = useState(1500);
  const [generateDistinctFiles, setGenerateDistinctFiles] = useState(true);
  const [releaseNotesPath, setReleaseNotesPath] = useState('release-notes');
  const [saving, setSaving] = useState(false);
  const [workflowInstalled, setWorkflowInstalled] = useState(false);
  const [skillInstalled, setSkillInstalled] = useState(false);
  const [skillSourcePath, setSkillSourcePath] = useState('');
  const [skillSourcePaths, setSkillSourcePaths] = useState<string[]>([]);
  const [skillInstalledPath, setSkillInstalledPath] = useState('');
  const [instructionsInstalled, setInstructionsInstalled] = useState(false);
  const [instructionsSourcePath, setInstructionsSourcePath] = useState('');
  const [instructionsInstalledPath, setInstructionsInstalledPath] = useState('');
  const [skillLoading, setSkillLoading] = useState(true);
  const [skillInstalling, setSkillInstalling] = useState(false);
  const [targetFramework, setTargetFramework] = useState('auto');

  useEffect(() => {
    if (config) {
      setColumns(config.columns.map(c => ({ ...c, originalName: c.name })));
      setHiddenStatuses(config.hiddenStatuses.map(c => ({ ...c, originalName: c.name })));
      setUsers(config.users.map(u => ({ ...u, originalName: u.name })));
      setTags(config.tags.map(t => ({ ...t, originalName: t.name })));
      setPriorities(config.priorities.map(p => ({ ...p, originalName: p.name })) || []);
      setProjects(config.projects.join(', '));
      setEnableBacklog(config.enableBacklogScreen);
      setRequireComment(config.requireCommentOnStatusChange);
      setBoardCardOpenMode(config.boardCardOpenMode || 'full');
      setAnimationsEnabled(config.animationsEnabled ?? true);
      setEnableFireworks(config.enableFireworks ?? true);
      setAnimationSpeed(config.animationSpeed || 'normal');
      setRequireInputStatus(config.requireInputStatus || DEFAULT_REQUIRE_INPUT_STATUS);
      setReadyForMergeStatus(config.readyForMergeStatus || DEFAULT_READY_FOR_MERGE_STATUS);
      setArchiveStatus(config.archiveStatus || DEFAULT_ARCHIVE_STATUS);
      setDocsEditPermissions(config.docsEditPermissions || 'all');
      setDocsAllowedUsers(config.docsAllowedUsers || []);
      setDocsRoot(config.docsRoot || '.docs');
      setHoverPopupsEnabled(config.hoverPopupsEnabled ?? true);
      setHoverPopupDelay(config.hoverPopupDelay ?? 1500);
      if (config.releaseSettings) {
        setGenerateDistinctFiles(config.releaseSettings.generateDistinctFiles);
        setReleaseNotesPath(config.releaseSettings.releaseNotesPath || 'release-notes');
      }
    }
  }, [config]);

  const normalizedRequireInputStatus = requireInputStatus.trim() || DEFAULT_REQUIRE_INPUT_STATUS;
  const normalizedReadyForMergeStatus = readyForMergeStatus.trim() || DEFAULT_READY_FOR_MERGE_STATUS;
  const normalizedArchiveStatus = archiveStatus.trim() || DEFAULT_ARCHIVE_STATUS;
  const statusOptions = Array.from(
    new Set([...columns, ...hiddenStatuses].map((item) => item.name.trim()).filter(Boolean))
  );
  const isRequireInputStatusMissing = !statusOptions.includes(normalizedRequireInputStatus);
  const isReadyForMergeStatusMissing = !statusOptions.includes(normalizedReadyForMergeStatus);

  const getWorkflowStatusLocation = (statusName: string) => {
    if (columns.some((item) => item.name === statusName)) return 'Board';
    if (hiddenStatuses.some((item) => item.name === statusName)) return 'Hidden';
    return 'Missing';
  };

  const restoreWorkflowStatusToBoard = (statusName: string) => {
    const normalizedStatusName = statusName.trim();
    if (!normalizedStatusName) return;

    setHiddenStatuses((current) => current.filter((item) => item.name !== normalizedStatusName));
    setColumns((current) => {
      if (current.some((item) => item.name === normalizedStatusName)) {
        return current;
      }

      const next = [...current];
      const doneIndex = next.findIndex((item) => item.name === 'Done');
      const insertIndex = doneIndex === -1 ? next.length : doneIndex;
      next.splice(insertIndex, 0, { name: normalizedStatusName });
      return next;
    });
  };

  useEffect(() => {
    setSkillLoading(true);
    fetchSkillStatus(targetFramework)
      .then((status) => {
        setWorkflowInstalled(status.workflowInstalled);
        setSkillInstalled(status.skillInstalled);
        setSkillSourcePath(status.skillSourcePath);
        setSkillSourcePaths(status.skillSourcePaths || []);
        setSkillInstalledPath(status.skillInstalledPath);
        setInstructionsInstalled(status.instructionsInstalled);
        setInstructionsSourcePath(status.instructionsSourcePath || '');
        setInstructionsInstalledPath(status.instructionsInstalledPath || '');
      })
      .catch(console.error)
      .finally(() => setSkillLoading(false));
  }, [targetFramework]);

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);

    const currentRequireInputStatus = config.requireInputStatus || DEFAULT_REQUIRE_INPUT_STATUS;
    const currentReadyForMergeStatus = config.readyForMergeStatus || DEFAULT_READY_FOR_MERGE_STATUS;
    const nextColumns = columns.map((column) => ({ ...column }));
    const nextHiddenStatuses = hiddenStatuses.map((item) => ({ ...item }));

    const renameExistingWorkflowStatus = (items: StatusDef[], currentStatusName: string, nextStatusName: string) => {
      if (currentStatusName === nextStatusName) return false;

      const matchedItem = items.find((item) => item.name === currentStatusName || item.originalName === currentStatusName);
      if (matchedItem) {
        matchedItem.name = nextStatusName;
        return true;
      }
      return false;
    };

    renameExistingWorkflowStatus(nextColumns, currentRequireInputStatus, normalizedRequireInputStatus)
      || renameExistingWorkflowStatus(nextHiddenStatuses, currentRequireInputStatus, normalizedRequireInputStatus);

    renameExistingWorkflowStatus(nextColumns, currentReadyForMergeStatus, normalizedReadyForMergeStatus)
      || renameExistingWorkflowStatus(nextHiddenStatuses, currentReadyForMergeStatus, normalizedReadyForMergeStatus);
    
    // Compute Renames
    const tagRenames: Record<string, string> = {};
    tags.forEach(t => { if (t.originalName && t.originalName !== t.name) tagRenames[t.originalName] = t.name; });
    
    const userRenames: Record<string, string> = {};
    users.forEach(u => { if (u.originalName && u.originalName !== u.name) userRenames[u.originalName] = u.name; });
    
    const statusRenames: Record<string, string> = {};
    [...nextColumns, ...nextHiddenStatuses].forEach(s => { if (s.originalName && s.originalName !== s.name) statusRenames[s.originalName] = s.name; });
    if (currentRequireInputStatus !== normalizedRequireInputStatus) {
      statusRenames[currentRequireInputStatus] = normalizedRequireInputStatus;
    }
    if (currentReadyForMergeStatus !== normalizedReadyForMergeStatus) {
      statusRenames[currentReadyForMergeStatus] = normalizedReadyForMergeStatus;
    }

    const priorityRenames: Record<string, string> = {};
    priorities.forEach(p => { if (p.originalName && p.originalName !== p.name) priorityRenames[p.originalName] = p.name; });

    try {
      if (Object.keys(tagRenames).length > 0 || Object.keys(userRenames).length > 0 || Object.keys(statusRenames).length > 0 || Object.keys(priorityRenames).length > 0) {
        await bulkRename({ tags: tagRenames, users: userRenames, statuses: statusRenames, priorities: priorityRenames });
      }

      const cleanTags = tags.filter(c => c.name.trim()).map(({originalName, ...rest}) => rest);
      const cleanColumns = nextColumns.filter(c => c.name.trim()).map(({originalName, ...rest}) => rest);
      const cleanHidden = nextHiddenStatuses.filter(c => c.name.trim()).map(({originalName, ...rest}) => rest);
      const cleanUsers = users.filter(c => c.name.trim()).map(({originalName, ...rest}) => rest);
      const cleanPriorities = priorities.filter(p => p.name.trim()).map(({ originalName, ...rest }) => rest);
      const cleanDocsAllowedUsers = docsEditPermissions === 'specified'
        ? docsAllowedUsers
            .map((userName) => userRenames[userName] || userName)
            .filter((userName) => cleanUsers.some((user) => user.name === userName))
        : [];

      await saveConfig({
        columns: cleanColumns,
        hiddenStatuses: cleanHidden,
        users: cleanUsers,
        tags: cleanTags,
        priorities: cleanPriorities,
        projects: projects.split(',').map(s => s.trim()).filter(Boolean),
        enableBacklogScreen: enableBacklog,
        requireCommentOnStatusChange: requireComment,
        boardCardOpenMode,
        animationsEnabled,
        enableFireworks,
        animationSpeed,
        requireInputStatus: normalizedRequireInputStatus,
        readyForMergeStatus: normalizedReadyForMergeStatus,
        archiveStatus: normalizedArchiveStatus,
        docsEditPermissions,
        docsAllowedUsers: cleanDocsAllowedUsers,
        docsRoot,
        hoverPopupsEnabled,
        hoverPopupDelay,
        releaseSettings: {
          generateDistinctFiles,
          releaseNotesPath
        }
      });
      
      triggerRefresh(); // Refresh tasks cache on frontend to show renamed items
      alert('Settings & Global Renames saved successfully!');
    } catch (err) {
      console.error(err);
      alert('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleInstallSkill = async () => {
    setSkillInstalling(true);
    try {
      const result = await installWorkspaceSkill(targetFramework);
      setWorkflowInstalled(true);
      setSkillInstalled(true);
      setInstructionsInstalled(Boolean(result.instructionsInstalledPath));
      setSkillInstalledPath(result.skillInstalledPath);
      setInstructionsInstalledPath(result.instructionsInstalledPath || '');
      alert(`Installed Event Horizon workflow to ${result.skillInstalledPath}${result.instructionsInstalledPath ? `\nPatched instructions at ${result.instructionsInstalledPath}` : ''}`);
    } catch (error) {
      console.error(error);
      alert('Failed to install Event Horizon workflow');
    } finally {
      setSkillInstalling(false);
    }
  };

  const handleCopyInstallCommand = async () => {
    const command = `npm.cmd run install-skill -- --target c:\\GitHub\\EventHorizon --framework ${targetFramework}`;
    try {
      await navigator.clipboard.writeText(command);
      alert('Copied skill install command to clipboard');
    } catch (error) {
      console.error(error);
      alert(command);
    }
  };

  if (!config) return null;

  const currentSavedPayload = JSON.stringify({
    columns: columns.filter(c => c.name.trim()).map(({originalName, ...rest}) => rest),
    hiddenStatuses: hiddenStatuses.filter(c => c.name.trim()).map(({originalName, ...rest}) => rest),
    users: users.filter(c => c.name.trim()).map(({originalName, ...rest}) => rest),
    tags: tags.filter(c => c.name.trim()).map(({originalName, ...rest}) => rest),
    priorities: priorities.filter(p => p.name.trim()).map(({ originalName, ...rest }) => rest),
    projects: projects.split(',').map(s => s.trim()).filter(Boolean),
    enableBacklogScreen: enableBacklog,
    requireCommentOnStatusChange: requireComment,
    boardCardOpenMode,
    animationsEnabled,
    enableFireworks,
    animationSpeed,
    requireInputStatus: normalizedRequireInputStatus,
    readyForMergeStatus: normalizedReadyForMergeStatus,
    archiveStatus: normalizedArchiveStatus,
    docsEditPermissions,
    docsAllowedUsers: docsEditPermissions === 'specified' ? docsAllowedUsers : [],
    docsRoot,
    hoverPopupsEnabled,
    hoverPopupDelay
  });

  const originalPayload = JSON.stringify({
    columns: config.columns,
    hiddenStatuses: config.hiddenStatuses,
    users: config.users,
    tags: config.tags,
    priorities: config.priorities,
    projects: config.projects,
    enableBacklogScreen: config.enableBacklogScreen,
    requireCommentOnStatusChange: config.requireCommentOnStatusChange,
    boardCardOpenMode: config.boardCardOpenMode || 'full',
    animationsEnabled: config.animationsEnabled ?? true,
    enableFireworks: config.enableFireworks ?? true,
    animationSpeed: config.animationSpeed || 'normal',
    requireInputStatus: config.requireInputStatus || DEFAULT_REQUIRE_INPUT_STATUS,
    readyForMergeStatus: config.readyForMergeStatus || DEFAULT_READY_FOR_MERGE_STATUS,
    archiveStatus: config.archiveStatus || DEFAULT_ARCHIVE_STATUS,
    docsEditPermissions: config.docsEditPermissions || 'all',
    docsAllowedUsers: config.docsEditPermissions === 'specified' ? (config.docsAllowedUsers || []) : [],
    docsRoot: config.docsRoot || '.docs',
    hoverPopupsEnabled: config.hoverPopupsEnabled ?? true,
    hoverPopupDelay: config.hoverPopupDelay ?? 1500
  });

  const isDirty = currentSavedPayload !== originalPayload;

  const handleDiscard = () => {
    if (!config) return;
    setColumns(config.columns.map(c => ({ ...c, originalName: c.name })));
    setHiddenStatuses(config.hiddenStatuses.map(c => ({ ...c, originalName: c.name })));
    setUsers(config.users.map(u => ({ ...u, originalName: u.name })));
    setTags(config.tags.map(t => ({ ...t, originalName: t.name })));
    setPriorities(config.priorities.map(p => ({ ...p, originalName: p.name })) || []);
    setProjects(config.projects.join(', '));
    setEnableBacklog(config.enableBacklogScreen);
    setRequireComment(config.requireCommentOnStatusChange);
    setBoardCardOpenMode(config.boardCardOpenMode || 'full');      
    setAnimationsEnabled(config.animationsEnabled ?? true);
    setEnableFireworks(config.enableFireworks ?? true);
    setAnimationSpeed(config.animationSpeed || 'normal');      
    setRequireInputStatus(config.requireInputStatus || DEFAULT_REQUIRE_INPUT_STATUS);
    setReadyForMergeStatus(config.readyForMergeStatus || DEFAULT_READY_FOR_MERGE_STATUS);
    setArchiveStatus(config.archiveStatus || DEFAULT_ARCHIVE_STATUS);
    setDocsEditPermissions(config.docsEditPermissions || 'all');
    setDocsAllowedUsers(config.docsAllowedUsers || []);
    setDocsRoot(config.docsRoot || '.docs');
    setHoverPopupsEnabled(config.hoverPopupsEnabled ?? true);
    setHoverPopupDelay(config.hoverPopupDelay ?? 1500);
    setGenerateDistinctFiles(config.releaseSettings?.generateDistinctFiles ?? true);
    setReleaseNotesPath(config.releaseSettings?.releaseNotesPath || 'release-notes');
  };

  return (
    <>
      <div className="max-w-5xl mx-auto mb-12 flex gap-6 items-start">
      <div className="w-64 shrink-0 bg-white/80 dark:bg-[#1a1b23]/80 backdrop-blur-xl border border-gray-200 dark:border-white/10 rounded-2xl shadow-xl overflow-hidden sticky top-4">
        <div className="p-5 border-b border-gray-200 dark:border-white/10">
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100 flex items-center justify-between">
            Settings
            {isDirty && <div className="w-2 h-2 rounded-full bg-amber-500" title="Unsaved changes" />}
          </h2>
        </div>
        <div className="py-2 flex flex-col gap-1">
          <button 
            onClick={() => setActiveTab('workflow')}
            className={`w-full text-left px-5 py-2.5 text-sm font-medium transition-colors ${activeTab === 'workflow' ? 'bg-primary/10 text-primary border-r-2 border-primary' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-white/5 border-r-2 border-transparent'}`}
          >
            Workflow & Statuses
          </button>
          <button 
            onClick={() => setActiveTab('attributes')}
            className={`w-full text-left px-5 py-2.5 text-sm font-medium transition-colors ${activeTab === 'attributes' ? 'bg-primary/10 text-primary border-r-2 border-primary' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-white/5 border-r-2 border-transparent'}`}
          >
            Attributes
          </button>
          <button 
            onClick={() => setActiveTab('workspace')}
            className={`w-full text-left px-5 py-2.5 text-sm font-medium transition-colors ${activeTab === 'workspace' ? 'bg-primary/10 text-primary border-r-2 border-primary' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-white/5 border-r-2 border-transparent'}`}
          >
            Workspace
          </button>
          <button 
            onClick={() => setActiveTab('preferences')}
            className={`w-full text-left px-5 py-2.5 text-sm font-medium transition-colors ${activeTab === 'preferences' ? 'bg-primary/10 text-primary border-r-2 border-primary' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-white/5 border-r-2 border-transparent'}`}
          >
            Preferences
          </button>
          <button 
            onClick={() => setActiveTab('agent')}
            className={`w-full text-left px-5 py-2.5 text-sm font-medium transition-colors ${activeTab === 'agent' ? 'bg-primary/10 text-primary border-r-2 border-primary' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-white/5 border-r-2 border-transparent'}`}
          >
            Agent Integration
          </button>
        </div>
      </div>

      <div className="flex-1 bg-white/80 dark:bg-[#1a1b23]/80 backdrop-blur-xl border border-gray-200 dark:border-white/10 rounded-2xl shadow-xl flex flex-col min-h-[600px]">
        <div className="p-8 flex-1">
          <div className="flex items-center justify-between mb-8 pb-6 border-b border-gray-200 dark:border-white/10">
            <div>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {activeTab === 'workflow' && 'Workflow & Statuses'}
                {activeTab === 'attributes' && 'Attributes'}
                {activeTab === 'workspace' && 'Workspace'}
                {activeTab === 'preferences' && 'Preferences'}
                {activeTab === 'agent' && 'Agent Integration'}
              </h2>
            </div>
            {/* Action bar is now sticky at the bottom */}
          </div>

          <div className="space-y-10">
            {activeTab === 'workflow' && (
              <div>
                <p className="text-xs text-gray-500 mb-6">Manage board columns, hidden statuses, and the special workflow stages used for user prompts and final review. Click any status badge below to pick its color.</p>

          <div className="grid grid-cols-2 gap-10">
            <div>
              <h4 className="text-sm font-bold text-gray-800 dark:text-gray-200 mb-1">Board Columns</h4>
              <p className="text-xs text-gray-500 mb-4">Statuses that appear as lanes on your Kanban board.</p>
              <StatusEditor items={columns} setItems={setColumns} placeholder="Column Status Name" sortable />
            </div>
            <div>
              <h4 className="text-sm font-bold text-gray-800 dark:text-gray-200 mb-1">Hidden Statuses</h4>
              <p className="text-xs text-gray-500 mb-4">Statuses that don't appear as board columns (e.g. Backlog).</p>
              <StatusEditor items={hiddenStatuses} setItems={setHiddenStatuses} placeholder="Hidden Status Name" />
            </div>
            <div className="col-span-2 rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
              <div className="grid grid-cols-2 gap-6">
                <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-white/10 dark:bg-black/20">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                      <h4 className="text-sm font-bold text-gray-800 dark:text-gray-200">User Input Status</h4>
                      <p className="mt-1 text-xs text-gray-500">This replaces the old hardcoded `Require Input` workflow stage.</p>
                    </div>
                    <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-gray-600 dark:bg-white/10 dark:text-gray-300">
                      {getWorkflowStatusLocation(normalizedRequireInputStatus)}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <select
                      className="flex-1 bg-gray-50 dark:bg-[#252630] border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 outline-none focus:border-primary text-sm font-medium"
                      value={isRequireInputStatusMissing ? '__missing__' : normalizedRequireInputStatus}
                      onChange={e => setRequireInputStatus(e.target.value)}
                      disabled={statusOptions.length === 0}
                    >
                      {isRequireInputStatusMissing && (
                        <option value="__missing__" disabled>
                          {normalizedRequireInputStatus} (missing)
                        </option>
                      )}
                      {statusOptions.length === 0 ? (
                        <option value="">No statuses available</option>
                      ) : (
                        statusOptions.map((statusOption) => (
                          <option key={statusOption} value={statusOption}>
                            {statusOption}
                          </option>
                        ))
                      )}
                    </select>
                    <button
                      type="button"
                      onClick={() => restoreWorkflowStatusToBoard(normalizedRequireInputStatus)}
                      className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
                    >
                      Restore
                    </button>
                  </div>
                </div>

                <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-white/10 dark:bg-black/20">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                      <h4 className="text-sm font-bold text-gray-800 dark:text-gray-200">Ready for Merge Status</h4>
                      <p className="mt-1 text-xs text-gray-500">Tickets in this status wait for review and the `finish &lt;ticket&gt;` handoff.</p>
                    </div>
                    <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-gray-600 dark:bg-white/10 dark:text-gray-300">
                      {getWorkflowStatusLocation(normalizedReadyForMergeStatus)}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <select
                      className="flex-1 bg-gray-50 dark:bg-[#252630] border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 outline-none focus:border-primary text-sm font-medium"
                      value={isReadyForMergeStatusMissing ? '__missing__' : normalizedReadyForMergeStatus}
                      onChange={e => setReadyForMergeStatus(e.target.value)}
                      disabled={statusOptions.length === 0}
                    >
                      {isReadyForMergeStatusMissing && (
                        <option value="__missing__" disabled>
                          {normalizedReadyForMergeStatus} (missing)
                        </option>
                      )}
                      {statusOptions.length === 0 ? (
                        <option value="">No statuses available</option>
                      ) : (
                        statusOptions.map((statusOption) => (
                          <option key={statusOption} value={statusOption}>
                            {statusOption}
                          </option>
                        ))
                      )}
                    </select>
                    <button
                      type="button"
                      onClick={() => restoreWorkflowStatusToBoard(normalizedReadyForMergeStatus)}
                      className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
                    >
                      Restore
                    </button>
                  </div>
                </div>

                <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-white/10 dark:bg-black/20">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                      <h4 className="text-sm font-bold text-gray-800 dark:text-gray-200">Archive Status</h4>
                      <p className="mt-1 text-xs text-gray-500">Tickets in this status are hidden from the board but remain discoverable via search.</p>
                    </div>
                    <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-gray-600 dark:bg-white/10 dark:text-gray-300">
                      {getWorkflowStatusLocation(normalizedArchiveStatus)}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <select
                      className="flex-1 bg-gray-50 dark:bg-[#252630] border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 outline-none focus:border-primary text-sm font-medium"
                      value={statusOptions.includes(normalizedArchiveStatus) ? normalizedArchiveStatus : '__missing__'}
                      onChange={e => setArchiveStatus(e.target.value)}
                      disabled={statusOptions.length === 0}
                    >
                      {!statusOptions.includes(normalizedArchiveStatus) && (
                        <option value="__missing__" disabled>
                          {normalizedArchiveStatus} (missing)
                        </option>
                      )}
                      {statusOptions.length === 0 ? (
                        <option value="">No statuses available</option>
                      ) : (
                        statusOptions.map((statusOption) => (
                          <option key={statusOption} value={statusOption}>
                            {statusOption}
                          </option>
                        ))
                      )}
                    </select>
                    <button
                      type="button"
                      onClick={() => restoreWorkflowStatusToBoard(normalizedArchiveStatus)}
                      className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
                    >
                      Restore
                    </button>
                  </div>
                </div>
              </div>
            </div>
            </div>
            </div>
            )}

            {activeTab === 'attributes' && (
              <div className="grid grid-cols-2 gap-10">
          <div className="col-span-2">
            <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Global Tags</h3>
            <p className="text-xs text-gray-500 mb-4">Define available tags and their visual pill colors.</p>
            <TagEditor items={tags} setItems={setTags} />
          </div>
          <div className="col-span-2 border-t border-gray-200 dark:border-white/10 pt-10">
            <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Priority Levels</h3>
            <p className="text-xs text-gray-500 mb-4">Define task priority levels, icons, and colors.</p>
            <PriorityEditor items={priorities} setItems={setPriorities} />
          </div>
        </div>
            )}

            {activeTab === 'workspace' && (
        <div className="grid grid-cols-2 gap-10">
          <div>
            <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Users & Agents</h3>
            <p className="text-xs text-gray-500 mb-4">Available assignees for tickets.</p>
            <SimpleEditor items={users} setItems={setUsers as any} placeholder="Username" />
          </div>

          <div>
            <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Project Keys</h3>
            <p className="text-xs text-gray-500 mb-4">Comma-separated prefixes for Ticket IDs (e.g. FLUX, ART).</p>
            <input 
              className="w-full bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 outline-none focus:border-primary text-sm font-medium"
              value={projects} onChange={e => setProjects(e.target.value)} placeholder="FLUX, DEV..."
            />
          </div>

          <div className="col-span-2 rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
            <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Docs Workspace</h3>
            <p className="text-xs text-gray-500 mb-5">Configure the active docs storage path and control who can create, edit, and delete markdown files.</p>

            <div className="mb-6">
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Docs Root Path</label>
              <input
                type="text"
                value={docsRoot}
                onChange={(event) => setDocsRoot(event.target.value)}
                placeholder=".docs"
                className="w-full max-w-sm rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm transition-colors focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary dark:border-white/20 dark:bg-black/20 dark:text-white"
              />
              <p className="text-[11px] text-gray-500 mt-1">The path relative to your repository root where wiki markdown files are stored.</p>
            </div>

            <div className="grid gap-6 lg:grid-cols-[220px,minmax(0,1fr)]">
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Edit Access</label>
                <select
                  value={docsEditPermissions}
                  onChange={(event) => setDocsEditPermissions(event.target.value as DocsEditPermissions)}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
                >
                  <option value="all">All users</option>
                  <option value="specified">Only specified users</option>
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Allowed Editors</label>
                {users.filter((user) => user.name.trim()).length === 0 ? (
                  <div className="rounded-xl border border-dashed border-gray-200 px-4 py-3 text-sm text-gray-500 dark:border-white/10">
                    Add at least one user before restricting docs editing.
                  </div>
                ) : (
                  <div className={`flex flex-wrap gap-2 rounded-xl border border-gray-200 bg-white p-3 dark:border-white/10 dark:bg-black/20 ${docsEditPermissions === 'all' ? 'opacity-60' : ''}`}>
                    {users.filter((user) => user.name.trim()).map((user) => {
                      const isSelected = docsAllowedUsers.includes(user.name);
                      return (
                        <label
                          key={user.name}
                          className={`flex cursor-pointer items-center gap-2 rounded-full border px-3 py-2 text-sm font-medium transition-colors ${isSelected ? 'border-primary bg-primary/10 text-primary' : 'border-gray-200 text-gray-600 dark:border-white/10 dark:text-gray-300'}`}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            disabled={docsEditPermissions === 'all'}
                            onChange={(event) => {
                              if (event.target.checked) {
                                setDocsAllowedUsers((current) => [...current, user.name]);
                              } else {
                                setDocsAllowedUsers((current) => current.filter((name) => name !== user.name));
                              }
                            }}
                            className="h-4 w-4 rounded border-gray-300"
                          />
                          {user.name}
                        </label>
                      );
                    })}
                  </div>
                )}
                <p className="mt-2 text-xs text-gray-500">
                  {docsEditPermissions === 'all'
                    ? 'Everyone can edit docs. The selected list is ignored.'
                    : 'Only the checked users can edit docs. Other users see a read-only experience.'}
                </p>
              </div>
            </div>
          </div>
        </div>
            )}

            {activeTab === 'preferences' && (
        <div className="space-y-8">
          <div className="space-y-6">
          <div>
            <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Release Settings</h3>
            <p className="text-xs text-gray-500 mb-4 text-balance">Configure how release notes are generated when releasing Done tickets.</p>
            <div className="space-y-4 max-w-lg">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-bold text-gray-700 dark:text-gray-300">Release Notes Output</label>
                <div className="flex items-center gap-4 rounded-xl border border-gray-200 bg-white p-1 dark:border-white/10 dark:bg-black/20 w-fit">
                  <button
                    type="button"
                    onClick={() => setGenerateDistinctFiles(true)}
                    className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${generateDistinctFiles ? 'bg-primary text-white shadow-sm' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/5'}`}
                  >
                    Distinct file per version
                  </button>
                  <button
                    type="button"
                    onClick={() => setGenerateDistinctFiles(false)}
                    className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${!generateDistinctFiles ? 'bg-primary text-white shadow-sm' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/5'}`}
                  >
                    Append to single file
                  </button>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-bold text-gray-700 dark:text-gray-300">Release Notes Sub-Folder / File Path</label>
                <input 
                  value={releaseNotesPath} 
                  onChange={e => setReleaseNotesPath(e.target.value)}
                  className="w-full bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 outline-none focus:border-primary text-sm"
                  placeholder="e.g. release-notes"
                />
                <p className="text-[11px] text-gray-500">
                  {generateDistinctFiles 
                    ? `Will generate distinct files under .docs/${releaseNotesPath}/{version}.md`
                    : `Will append to the single file .docs/${releaseNotesPath}/release_notes.md`}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <span className="block text-sm font-bold text-gray-800 dark:text-gray-200 mb-0.5">Board Card Click Behavior</span>
                <span className="text-xs text-gray-500">Choose whether clicking a board card opens the full ticket view or the popup editor. The shipped default is full view.</span>
              </div>
              <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white p-1 dark:border-white/10 dark:bg-black/20">
                <button
                  type="button"
                  onClick={() => setBoardCardOpenMode('full')}
                  className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${boardCardOpenMode === 'full' ? 'bg-primary text-white shadow-sm' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/5'}`}
                >
                  Full View
                </button>
                <button
                  type="button"
                  onClick={() => setBoardCardOpenMode('popup')}
                  className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${boardCardOpenMode === 'popup' ? 'bg-primary text-white shadow-sm' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/5'}`}
                >
                  Popup View
                </button>
              </div>
            </div>
          </div>
          
          <SettingToggleCard
            title="Ticket Animations"
            description="Enable fluid layout animations when opening and closing tickets."
            checked={animationsEnabled}
            onChange={setAnimationsEnabled}
          >
            {animationsEnabled && (
              <select
                value={animationSpeed}
                onChange={(e) => setAnimationSpeed(e.target.value as 'fast' | 'normal' | 'slow')}
                className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
              >
                <option value="fast">Fast</option>
                <option value="normal">Normal</option>
                <option value="slow">Slow</option>
              </select>
            )}
          </SettingToggleCard>

          <SettingToggleCard
            title="Celebrate Done Tickets"
            description="Show fireworks when moving a ticket into the Done column."
            checked={enableFireworks}
            onChange={setEnableFireworks}
          />

          <SettingToggleCard
            title="Card Hover Preview"
            description="Show full description popup on hover. Optionally configure the delay in ms."
            checked={hoverPopupsEnabled}
            onChange={setHoverPopupsEnabled}
          >
            {hoverPopupsEnabled && (
              <div className="flex items-center gap-2">
                 <span className="text-xs text-gray-500 font-medium">Delay (ms)</span>
                 <input
                  type="number"
                  value={hoverPopupDelay}
                  onChange={(e) => setHoverPopupDelay(Number(e.target.value) || 1500)}
                  className="w-20 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
                  min="0"
                  step="100"
                />
              </div>
            )}
          </SettingToggleCard>

          <SettingToggleCard
            title="Enable Backlog Screen"
            description="If disabled, the backlog will simply appear as a normal column on the board (if not listed in Hidden Statuses)."
            checked={enableBacklog}
            onChange={setEnableBacklog}
          />

          <SettingToggleCard
            title="Require Comment on Status Change"
            description="Prompt for a comment pop-up when dragging a task to a new column on the board."
            checked={requireComment}
            onChange={setRequireComment}
          />
        </div>
        </div>
            )}

            {activeTab === 'agent' && (
        <div className="space-y-4">
          <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Agent Workflow</h3>
          <p className="text-xs text-gray-500 mb-4">Install and refresh the Event Horizon skill plus the always-on Copilot instructions for this workspace.</p>
          <div className="rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
            <div className="flex items-start justify-between gap-6">
              <div className="space-y-3 text-sm text-gray-600 dark:text-gray-300">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Target Framework</div>
                  <div className="mt-1">
                    <select
                      value={targetFramework}
                      onChange={(e) => setTargetFramework(e.target.value)}
                      className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
                    >
                      <option value="auto">Auto-Detect</option>
                      <option value="copilot">GitHub Copilot</option>
                      <option value="cursor">Cursor</option>
                      <option value="cline">Cline</option>
                      <option value="windsurf">Windsurf</option>
                      <option value="claude">Claude Code</option>
                      <option value="gemini">Gemini CLI</option>
                      <option value="generic">Generic / Other</option>
                    </select>
                  </div>
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Status</div>
                  <div className="mt-1 font-medium">{skillLoading ? 'Checking…' : workflowInstalled ? 'Installed in this repo' : 'Not fully installed in this repo'}</div>
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Source Skills</div>
                  <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">Edit these files to customise the agent workflow; re-run Install to propagate.</p>
                  <div className="mt-2 space-y-1.5">
                    {(skillSourcePaths.length > 0 ? skillSourcePaths : [
                      '.docs/skills/event-horizon-orchestrator.md',
                      '.docs/skills/event-horizon-grooming.md',
                      '.docs/skills/event-horizon-implementation.md',
                      '.docs/skills/event-horizon-release.md',
                    ]).map((p) => {
                      const basename = p.split('/').pop()?.replace('.md', '') ?? p;
                      const normalized = p.replace(/\\/g, '/');
                      const docsIdx = normalized.indexOf('/.docs/');
                      const docsRelative = docsIdx !== -1 ? normalized.slice(docsIdx + 7) : (normalized.split('/').pop() ?? p);
                      const docParam = docsRelative.replace(/\.md$/, '');
                      return (
                        <button
                          key={p}
                          type="button"
                          title={p}
                          onClick={() => {
                            const url = new URL(window.location.href);
                            url.pathname = '/docs';
                            url.searchParams.set('doc', docParam);
                            window.history.pushState({}, '', url.toString());
                            window.dispatchEvent(new CustomEvent('flux:navigate'));
                            setView('docs');
                          }}
                          className="flex w-full items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-left text-xs text-gray-700 transition-colors hover:border-primary/40 hover:bg-primary/5 dark:border-white/10 dark:bg-black/20 dark:text-gray-300 dark:hover:bg-white/5"
                        >
                          <span className="min-w-0 flex-1 truncate font-mono">{basename}</span>
                          <svg className="h-3.5 w-3.5 shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Workspace Skill Path</div>
                  <div className="mt-1 break-all">{skillInstalledPath || '.github/skills/event-horizon/orchestrator.md'}</div>
                </div>
                {instructionsSourcePath && (
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Instructions Source</div>
                    <div className="mt-1 break-all">{instructionsSourcePath}</div>
                  </div>
                )}
                {instructionsInstalledPath && (
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Instructions Path</div>
                    <div className="mt-1 break-all">{instructionsInstalledPath}</div>
                  </div>
                )}
                <div className="flex flex-wrap gap-2 pt-1 text-xs font-medium">
                  <span className={`rounded-full px-2.5 py-1 ${skillInstalled ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'}`}>
                    Skill: {skillInstalled ? 'Installed' : 'Missing'}
                  </span>
                  {(instructionsSourcePath || instructionsInstalledPath) && (
                    <span className={`rounded-full px-2.5 py-1 ${instructionsInstalled ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'}`}>
                      Instructions: {instructionsInstalled ? 'Installed' : 'Missing/Unpatched'}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 flex-col gap-3">
                <button
                  onClick={handleInstallSkill}
                  disabled={skillInstalling}
                  className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${skillInstalling ? 'bg-gray-200 text-gray-400 dark:bg-white/10 dark:text-gray-500' : 'bg-primary text-white hover:bg-primary-hover'}`}
                >
                  {skillInstalling ? 'Installing…' : workflowInstalled ? 'Reinstall Workflow' : 'Install Workflow'}
                </button>
                <button
                  onClick={handleCopyInstallCommand}
                  className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
                >
                  Copy Install Command
                </button>
              </div>
            </div>
          </div>
        </div>
            )}
          </div>
        </div>
      </div>
    </div>

    {/* Sticky Save/Action Bar */}
    <div 
      className={`fixed bottom-0 left-0 right-0 p-4 transition-transform duration-300 pointer-events-none z-50 ${isDirty ? 'translate-y-0' : 'translate-y-full'}`}
    >
      <div className="absolute inset-0 bg-gradient-to-t from-white/80 via-white/50 to-transparent dark:from-black/80 dark:via-black/50 dark:to-transparent pointer-events-none" />
      <div className="max-w-2xl mx-auto flex items-center justify-between bg-white dark:bg-[#1a1b23] border border-gray-200 dark:border-white/10 rounded-2xl shadow-2xl p-4 pointer-events-auto relative">
        <div className="flex flex-col">
          <span className="text-sm font-bold text-gray-900 dark:text-gray-100">Unsaved Changes</span>
          <span className="text-xs text-gray-500">You have modified your workspace settings.</span>
        </div>
        <div className="flex items-center gap-3">
          <button 
            onClick={handleDiscard}
            disabled={saving}
            className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/5 transition-colors"
          >
            Discard
          </button>
          <button 
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-6 py-2 rounded-lg bg-primary hover:bg-primary-hover text-white shadow-sm shadow-primary/20 transition-colors text-sm font-medium"
          >
            <Save className="w-4 h-4" /> {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
    </>
  );
}
