import { useState, useEffect } from 'react';
import { useApp } from '../AppContext';
import { Save, Plus, X, GripVertical, AlertCircle, ChevronUp, ChevronDown, Equal } from 'lucide-react';
import { bulkRename, fetchSkillStatus, installWorkspaceSkill } from '../api';
import type { TagDef, StatusDef, UserDef, PriorityDef } from '../types';
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
                className={`w-6 h-6 rounded-full border-2 transition-all ${color.split(' ')[0]} ${item.color === color ? 'border-primary shadow-sm scale-110' : 'border-transparent hover:scale-105'}`}
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
  const { config, saveConfig, triggerRefresh } = useApp();
  
  const [columns, setColumns] = useState<StatusDef[]>([]);
  const [hiddenStatuses, setHiddenStatuses] = useState<StatusDef[]>([]);
  const [users, setUsers] = useState<UserDef[]>([]);
  const [tags, setTags] = useState<TagDef[]>([]);
  const [priorities, setPriorities] = useState<PriorityDef[]>([]);
  const [projects, setProjects] = useState('');
  const [enableBacklog, setEnableBacklog] = useState(true);
  const [requireComment, setRequireComment] = useState(true);
  const [readyForMergeStatus, setReadyForMergeStatus] = useState('Ready');
  const [saving, setSaving] = useState(false);
  const [workflowInstalled, setWorkflowInstalled] = useState(false);
  const [skillInstalled, setSkillInstalled] = useState(false);
  const [skillSourcePath, setSkillSourcePath] = useState('');
  const [skillInstalledPath, setSkillInstalledPath] = useState('');
  const [instructionsInstalled, setInstructionsInstalled] = useState(false);
  const [instructionsSourcePath, setInstructionsSourcePath] = useState('');
  const [instructionsInstalledPath, setInstructionsInstalledPath] = useState('');
  const [skillLoading, setSkillLoading] = useState(true);
  const [skillInstalling, setSkillInstalling] = useState(false);

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
      setReadyForMergeStatus(config.readyForMergeStatus || 'Ready');
    }
  }, [config]);

  useEffect(() => {
    fetchSkillStatus()
      .then((status) => {
        setWorkflowInstalled(status.workflowInstalled);
        setSkillInstalled(status.skillInstalled);
        setSkillSourcePath(status.skillSourcePath);
        setSkillInstalledPath(status.skillInstalledPath);
        setInstructionsInstalled(status.instructionsInstalled);
        setInstructionsSourcePath(status.instructionsSourcePath || '');
        setInstructionsInstalledPath(status.instructionsInstalledPath || '');
      })
      .catch(console.error)
      .finally(() => setSkillLoading(false));
  }, []);

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);

    const normalizedReadyForMergeStatus = readyForMergeStatus.trim() || 'Ready';
    const currentReadyForMergeStatus = config.readyForMergeStatus || 'Ready';
    const nextColumns = columns.map((column) => ({ ...column }));
    const nextHiddenStatuses = hiddenStatuses.map((item) => ({ ...item }));

    const renameExistingWorkflowStatus = (items: StatusDef[]) => {
      const matchedItem = items.find((item) => item.name === currentReadyForMergeStatus || item.originalName === currentReadyForMergeStatus);
      if (matchedItem) {
        matchedItem.name = normalizedReadyForMergeStatus;
        return true;
      }
      return false;
    };

    const statusExists = (statusName: string) => [...nextColumns, ...nextHiddenStatuses].some((item) => item.name === statusName);
    const insertReadyStatus = () => {
      if (statusExists(normalizedReadyForMergeStatus)) return;
      const doneIndex = nextColumns.findIndex((item) => item.name === 'Done');
      const readyStatus = { name: normalizedReadyForMergeStatus };
      if (doneIndex === -1) {
        nextColumns.push(readyStatus);
      } else {
        nextColumns.splice(doneIndex, 0, readyStatus);
      }
    };

    if (currentReadyForMergeStatus !== normalizedReadyForMergeStatus) {
      const renamed = renameExistingWorkflowStatus(nextColumns) || renameExistingWorkflowStatus(nextHiddenStatuses);
      if (!renamed) {
        insertReadyStatus();
      }
    } else {
      insertReadyStatus();
    }
    
    // Compute Renames
    const tagRenames: Record<string, string> = {};
    tags.forEach(t => { if (t.originalName && t.originalName !== t.name) tagRenames[t.originalName] = t.name; });
    
    const userRenames: Record<string, string> = {};
    users.forEach(u => { if (u.originalName && u.originalName !== u.name) userRenames[u.originalName] = u.name; });
    
    const statusRenames: Record<string, string> = {};
    [...nextColumns, ...nextHiddenStatuses].forEach(s => { if (s.originalName && s.originalName !== s.name) statusRenames[s.originalName] = s.name; });
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

      await saveConfig({
        columns: cleanColumns,
        hiddenStatuses: cleanHidden,
        users: cleanUsers,
        tags: cleanTags,
        priorities: cleanPriorities,
        projects: projects.split(',').map(s => s.trim()).filter(Boolean),
        enableBacklogScreen: enableBacklog,
        requireCommentOnStatusChange: requireComment,
        readyForMergeStatus: normalizedReadyForMergeStatus
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
      const result = await installWorkspaceSkill();
      setWorkflowInstalled(true);
      setSkillInstalled(true);
      setInstructionsInstalled(Boolean(result.instructionsInstalledPath));
      setSkillInstalledPath(result.skillInstalledPath);
      setInstructionsInstalledPath(result.instructionsInstalledPath || '');
      alert(`Installed Event Horizon workflow to ${result.skillInstalledPath}${result.instructionsInstalledPath ? `\nPatched Copilot instructions at ${result.instructionsInstalledPath}` : ''}`);
    } catch (error) {
      console.error(error);
      alert('Failed to install Event Horizon workflow');
    } finally {
      setSkillInstalling(false);
    }
  };

  const handleCopyInstallCommand = async () => {
    const command = 'npm.cmd run install-skill -- --target c:\\GitHub\\EventHorizon --framework copilot';
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
    readyForMergeStatus: readyForMergeStatus.trim() || 'Ready'
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
    readyForMergeStatus: config.readyForMergeStatus || 'Ready'
  });

  const isDirty = currentSavedPayload !== originalPayload;

  return (
    <div className="max-w-4xl mx-auto bg-white/80 dark:bg-[#1a1b23]/80 backdrop-blur-xl border border-gray-200 dark:border-white/10 rounded-2xl shadow-xl p-8 mb-12">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Project Settings</h2>
          <p className="text-sm text-gray-500 mt-1">
            Manage global settings, tags, users, and board columns.
            {isDirty && <span className="text-amber-500 text-xs italic ml-2">(Unsaved changes)</span>}
          </p>
        </div>
        <button 
          onClick={handleSave}
          disabled={saving || !isDirty}
          className={`flex items-center gap-2 px-6 py-2 rounded-lg transition-colors font-medium shadow-sm ${
            isDirty 
              ? 'bg-primary hover:bg-primary-hover text-white shadow-primary/20 cursor-pointer'
              : 'bg-gray-200 dark:bg-white/10 text-gray-400 cursor-not-allowed'
          }`}
        >
          <Save className="w-4 h-4" /> {saving ? 'Saving...' : 'Save Configuration'}
        </button>
      </div>

      <div className="space-y-10">
        <div className="grid grid-cols-2 gap-10">
          <div>
            <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Board Columns</h3>
            <p className="text-xs text-gray-500 mb-4">Statuses that appear as lanes on your Kanban board.</p>
            <SimpleEditor items={columns} setItems={setColumns as any} placeholder="Column Status Name" sortable />
          </div>
          <div>
            <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Hidden Statuses</h3>
            <p className="text-xs text-gray-500 mb-4">Statuses that don't appear as board columns (e.g. Backlog).</p>
            <SimpleEditor items={hiddenStatuses} setItems={setHiddenStatuses as any} placeholder="Hidden Status Name" />
          </div>
        </div>

        <div className="border-t border-gray-200 dark:border-white/10 pt-10 grid grid-cols-2 gap-10">
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

        <div className="border-t border-gray-200 dark:border-white/10 pt-10 grid grid-cols-2 gap-10">
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
        </div>

        <div className="border-t border-gray-200 dark:border-white/10 pt-8 space-y-4">
          <label className="flex items-center gap-4 p-4 bg-gray-50 dark:bg-black/10 rounded-xl border border-gray-200 dark:border-white/5">
            <div className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-gray-800 dark:text-gray-200 mb-0.5">Ready for Merge Status</span>
              <span className="text-xs text-gray-500">Tickets moved into this status become a user prompt for final review and the `finish &lt;ticket&gt;` handoff.</span>
            </div>
            <input
              className="w-40 bg-white dark:bg-black/20 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 outline-none focus:border-primary text-sm font-medium"
              value={readyForMergeStatus}
              onChange={e => setReadyForMergeStatus(e.target.value)}
              placeholder="Ready"
            />
          </label>

          <label className="flex items-center gap-4 cursor-pointer p-4 bg-gray-50 dark:bg-black/10 rounded-xl border border-gray-200 dark:border-white/5 hover:border-primary transition-colors">
            <input 
              type="checkbox" 
              checked={enableBacklog} 
              onChange={e => setEnableBacklog(e.target.checked)}
              className="w-5 h-5 text-primary bg-white border-gray-300 rounded outline-none cursor-pointer"
            />
            <div>
              <span className="block text-sm font-bold text-gray-800 dark:text-gray-200 mb-0.5">Enable Backlog Screen</span>
              <span className="text-xs text-gray-500">If disabled, the backlog will simply appear as a normal column on the board (if not listed in Hidden Statuses).</span>
            </div>
          </label>

          <label className="flex items-center gap-4 cursor-pointer p-4 bg-gray-50 dark:bg-black/10 rounded-xl border border-gray-200 dark:border-white/5 hover:border-primary transition-colors">
            <input 
              type="checkbox" 
              checked={requireComment} 
              onChange={e => setRequireComment(e.target.checked)}
              className="w-5 h-5 text-primary bg-white border-gray-300 rounded outline-none cursor-pointer"
            />
            <div>
              <span className="block text-sm font-bold text-gray-800 dark:text-gray-200 mb-0.5">Require Comment on Status Change</span>
              <span className="text-xs text-gray-500">Prompt for a comment pop-up when dragging a task to a new column on the board.</span>
            </div>
          </label>
        </div>

        <div className="border-t border-gray-200 dark:border-white/10 pt-10">
          <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Agent Workflow</h3>
          <p className="text-xs text-gray-500 mb-4">Install and refresh the Event Horizon skill plus the always-on Copilot instructions for this workspace.</p>
          <div className="rounded-2xl border border-gray-200 bg-gray-50/80 p-5 dark:border-white/10 dark:bg-black/10">
            <div className="flex items-start justify-between gap-6">
              <div className="space-y-3 text-sm text-gray-600 dark:text-gray-300">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Status</div>
                  <div className="mt-1 font-medium">{skillLoading ? 'Checking…' : workflowInstalled ? 'Installed in this repo' : 'Not fully installed in this repo'}</div>
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Source Skill</div>
                  <div className="mt-1 break-all">{skillSourcePath || '.flux/skills/event-horizon-agent.md'}</div>
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Workspace Skill Path</div>
                  <div className="mt-1 break-all">{skillInstalledPath || '.github/skills/event-horizon/SKILL.md'}</div>
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Copilot Instructions Source</div>
                  <div className="mt-1 break-all">{instructionsSourcePath || '.flux/skills/event-horizon-copilot-instructions.md'}</div>
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Copilot Instructions Path</div>
                  <div className="mt-1 break-all">{instructionsInstalledPath || '.github/copilot-instructions.md'}</div>
                </div>
                <div className="flex flex-wrap gap-2 pt-1 text-xs font-medium">
                  <span className={`rounded-full px-2.5 py-1 ${skillInstalled ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'}`}>
                    Skill: {skillInstalled ? 'Installed' : 'Missing'}
                  </span>
                  <span className={`rounded-full px-2.5 py-1 ${instructionsInstalled ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'}`}>
                    Instructions: {instructionsInstalled ? 'Installed' : 'Missing'}
                  </span>
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
      </div>
    </div>
  );
}
