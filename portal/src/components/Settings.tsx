import { useState, useEffect } from 'react';
import { useApp } from '../AppContext';
import { Save, Plus, X } from 'lucide-react';
import { bulkRename } from '../api';
import type { TagDef, StatusDef, UserDef } from '../types';

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

const SimpleEditor = ({ items, setItems, placeholder }: { items: {name: string, originalName?: string}[], setItems: (items: any[]) => void, placeholder: string }) => {
  return (
    <div className="space-y-2">
      {items.map((item, idx) => (
        <div key={idx} className="flex gap-2 items-center">
          <input 
            value={item.name} 
            onChange={e => { const newArr = [...items]; newArr[idx].name = e.target.value; setItems(newArr); }}
            className="flex-1 bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-1.5 outline-none focus:border-primary text-sm font-medium"
            placeholder={placeholder}
          />
          <button onClick={() => setItems(items.filter((_, i) => i !== idx))} className="p-1.5 text-gray-400 hover:text-red-500 rounded"><X className="w-4 h-4" /></button>
        </div>
      ))}
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
  const [projects, setProjects] = useState('');
  const [enableBacklog, setEnableBacklog] = useState(true);
  const [requireComment, setRequireComment] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (config) {
      setColumns(config.columns.map(c => ({ ...c, originalName: c.name })));
      setHiddenStatuses(config.hiddenStatuses.map(c => ({ ...c, originalName: c.name })));
      setUsers(config.users.map(u => ({ ...u, originalName: u.name })));
      setTags(config.tags.map(t => ({ ...t, originalName: t.name })));
      setProjects(config.projects.join(', '));
      setEnableBacklog(config.enableBacklogScreen);
      setRequireComment(config.requireCommentOnStatusChange);
    }
  }, [config]);

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    
    // Compute Renames
    const tagRenames: Record<string, string> = {};
    tags.forEach(t => { if (t.originalName && t.originalName !== t.name) tagRenames[t.originalName] = t.name; });
    
    const userRenames: Record<string, string> = {};
    users.forEach(u => { if (u.originalName && u.originalName !== u.name) userRenames[u.originalName] = u.name; });
    
    const statusRenames: Record<string, string> = {};
    [...columns, ...hiddenStatuses].forEach(s => { if (s.originalName && s.originalName !== s.name) statusRenames[s.originalName] = s.name; });

    try {
      if (Object.keys(tagRenames).length > 0 || Object.keys(userRenames).length > 0 || Object.keys(statusRenames).length > 0) {
        await bulkRename({ tags: tagRenames, users: userRenames, statuses: statusRenames });
      }

      const cleanTags = tags.filter(c => c.name.trim()).map(({originalName, ...rest}) => rest);
      const cleanColumns = columns.filter(c => c.name.trim()).map(({originalName, ...rest}) => rest);
      const cleanHidden = hiddenStatuses.filter(c => c.name.trim()).map(({originalName, ...rest}) => rest);
      const cleanUsers = users.filter(c => c.name.trim()).map(({originalName, ...rest}) => rest);

      await saveConfig({
        columns: cleanColumns,
        hiddenStatuses: cleanHidden,
        users: cleanUsers,
        tags: cleanTags,
        projects: projects.split(',').map(s => s.trim()).filter(Boolean),
        enableBacklogScreen: enableBacklog,
        requireCommentOnStatusChange: requireComment
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

  if (!config) return null;

  const currentSavedPayload = JSON.stringify({
    columns: columns.filter(c => c.name.trim()).map(({originalName, ...rest}) => rest),
    hiddenStatuses: hiddenStatuses.filter(c => c.name.trim()).map(({originalName, ...rest}) => rest),
    users: users.filter(c => c.name.trim()).map(({originalName, ...rest}) => rest),
    tags: tags.filter(c => c.name.trim()).map(({originalName, ...rest}) => rest),
    projects: projects.split(',').map(s => s.trim()).filter(Boolean),
    enableBacklogScreen: enableBacklog,
    requireCommentOnStatusChange: requireComment
  });

  const originalPayload = JSON.stringify({
    columns: config.columns,
    hiddenStatuses: config.hiddenStatuses,
    users: config.users,
    tags: config.tags,
    projects: config.projects,
    enableBacklogScreen: config.enableBacklogScreen,
    requireCommentOnStatusChange: config.requireCommentOnStatusChange
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
            <SimpleEditor items={columns} setItems={setColumns as any} placeholder="Column Status Name" />
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
      </div>
    </div>
  );
}
