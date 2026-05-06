import { useState, useEffect, useRef } from 'react';
import { Rnd } from 'react-rnd';
import { X, Save, MessageSquare, ArrowRight, Bold, Italic, Link as LinkIcon, List, Code, Maximize2, Minimize2, PanelRight, SendHorizontal, Trash2 } from 'lucide-react';
import { useApp } from '../AppContext';
import { createTask, updateTask, deleteTask } from '../api';
import type { TagDef } from '../types';

function TagSelector({ tags, onChange, availableTags, configTags }: { tags: string[], onChange: (tags: string[]) => void, availableTags: string[], configTags: TagDef[] }) {
  const [input, setInput] = useState('');
  const [focused, setFocused] = useState(false);

  const addTag = (tag: string) => {
    if (!tags.includes(tag)) onChange([...tags, tag]);
    setInput('');
  };

  const removeTag = (tag: string) => {
    onChange(tags.filter(t => t !== tag));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && input.trim()) {
      e.preventDefault();
      addTag(input.trim());
    } else if (e.key === 'Backspace' && !input && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    }
  };

  const unselected = availableTags.filter(t => !tags.includes(t) && t.toLowerCase().includes(input.toLowerCase()));

  return (
    <div className="relative flex-1">
      <div className={`flex flex-wrap items-center gap-1.5 w-full bg-gray-50 dark:bg-black/20 border ${focused ? 'border-primary' : 'border-gray-200 dark:border-white/10'} rounded-lg px-2 py-1.5 min-h-[38px] transition-colors cursor-text`} onClick={() => document.getElementById('tag-input')?.focus()}>
        {tags.map(tag => {
          const color = configTags.find(t => t.name === tag)?.color || 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
          return (
            <span key={tag} className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${color}`}>
              {tag}
              <button onClick={(e) => { e.stopPropagation(); removeTag(tag); }} className="hover:opacity-70"><X className="w-3 h-3" /></button>
            </span>
          );
        })}
        <input
          id="tag-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 200)}
          className="flex-1 min-w-[60px] bg-transparent outline-none text-sm text-gray-800 dark:text-gray-200"
          placeholder={tags.length === 0 ? "Add tags..." : ""}
        />
      </div>
      {focused && unselected.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-[#252630] border border-gray-200 dark:border-white/10 rounded-lg shadow-xl max-h-40 overflow-y-auto z-[60]">
          {unselected.map(tag => (
            <div 
              key={tag} 
              onMouseDown={(e) => { e.preventDefault(); addTag(tag); }}
              className="px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-white/5 cursor-pointer text-gray-700 dark:text-gray-300"
            >
              {tag}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function TaskModal() {
  const { isModalOpen, closeModal, modalTask, setModalTask, currentProject, currentUser, triggerRefresh, config } = useApp();
  
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [status, setStatus] = useState('Todo');
  const [assignee, setAssignee] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [newComment, setNewComment] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Layout States
  const [isWideMode, setIsWideMode] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (modalTask) {
      setTitle(modalTask.title || '');
      setBody(modalTask.body || '');
      setStatus(modalTask.status || 'Todo');
      setAssignee(modalTask.assignee || 'unassigned');
      setTags(modalTask.tags || []);
      setNewComment('');
      setConfirmDiscard(false);
      setConfirmDelete(false);
      setIsFullscreen(false);
    }
  }, [modalTask]);

  if (!isModalOpen || !config) return null;

  const allStatuses = [...config.columns, ...config.hiddenStatuses].map(s => s.name);
  const allUsers = config.users.map(u => u.name);
  const allTags = config.tags.map(t => t.name);

  const originalPayload = JSON.stringify({
    title: modalTask?.title || '',
    body: modalTask?.body || '',
    status: modalTask?.status || 'Todo',
    assignee: modalTask?.assignee || 'unassigned',
    tags: modalTask?.tags || []
  });

  const currentPayload = JSON.stringify({ title, body, status, assignee, tags });
  const isDirty = originalPayload !== currentPayload || newComment.trim() !== '';

  const handleCloseAttempt = () => {
    if (isDirty) {
      setConfirmDiscard(true);
    } else {
      closeModal();
    }
  };

  const handleSave = async (customHistory?: any[]) => {
    setSaving(true);
    const payload = { title, body, status, assignee, tags };
    
    let historyUpdates: any[] = customHistory || [];
    
    if (!customHistory && newComment.trim()) {
      historyUpdates.push({
        type: 'comment',
        user: currentUser,
        date: new Date().toISOString(),
        comment: newComment.trim()
      });
      setNewComment('');
    }

    try {
      if (modalTask?.id) {
        if (!customHistory && modalTask.status && modalTask.status !== status) {
           historyUpdates.push({
             type: 'status_change',
             from: modalTask.status,
             to: status,
             user: currentUser,
             date: new Date().toISOString(),
             comment: newComment.trim() ? "Included with comment" : undefined
           });
        }
        const newHistory = [...(modalTask.history || []), ...historyUpdates];
        const updatedTask = await updateTask(modalTask.id, { ...payload, history: newHistory, updatedBy: currentUser } as any);
        if (customHistory) setModalTask(updatedTask);
      } else {
        await createTask({ ...payload, history: historyUpdates, projectKey: currentProject, author: currentUser });
      }
      triggerRefresh();
      if (!customHistory) closeModal();
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!modalTask?.id) return;
    setSaving(true);
    try {
      await deleteTask(modalTask.id);
      triggerRefresh();
      closeModal();
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const sendCommentDirectly = async () => {
    if (!newComment.trim() || !modalTask?.id) return;
    
    const commentEntry = {
      type: 'comment',
      user: currentUser,
      date: new Date().toISOString(),
      comment: newComment.trim()
    };
    
    await handleSave([commentEntry]);
  };

  const insertMarkdown = (prefix: string, suffix: string = '') => {
    if (!textareaRef.current) return;
    const start = textareaRef.current.selectionStart;
    const end = textareaRef.current.selectionEnd;
    const text = body;
    const selectedText = text.substring(start, end);
    
    const newText = text.substring(0, start) + prefix + selectedText + suffix + text.substring(end);
    setBody(newText);
    
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(start + prefix.length, end + prefix.length);
      }
    }, 0);
  };

  return (
    <div className="fixed inset-0 z-50 pointer-events-none flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm pointer-events-auto" onClick={handleCloseAttempt} />
      
      <Rnd
        default={{ x: window.innerWidth / 2 - 400, y: Math.max(50, window.innerHeight / 2 - 400), width: 800, height: 'auto' }}
        minWidth={600}
        minHeight={600}
        maxHeight={window.innerHeight * 0.95}
        bounds="window"
        dragHandleClassName="modal-handle"
        className="bg-white dark:bg-[#1a1b23] border border-gray-200 dark:border-white/10 shadow-2xl rounded-xl flex flex-col pointer-events-auto overflow-hidden max-h-[95vh]"
        style={isFullscreen ? { x: 0, y: 0, width: '100%', height: '100%', transform: 'none' } : undefined}
        disableDragging={isFullscreen}
        enableResizing={!isFullscreen}
      >
        {!isFullscreen && (
          <div className="modal-handle flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-white/5 bg-gray-50 dark:bg-black/20 cursor-move">
            <div className="flex flex-col">
              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-0.5">
                {modalTask?.id ? modalTask.id : 'New Task'} {isDirty && <span className="text-amber-500 lowercase normal-case italic ml-1">(Unsaved changes)</span>}
              </span>
              <h2 className="font-semibold text-gray-800 dark:text-gray-200 leading-none">
                {title || 'Untitled Task'}
              </h2>
            </div>
            <div className="flex items-center gap-4">
              {modalTask?.id && (
                <button 
                  onClick={() => setConfirmDelete(true)}
                  title="Delete Task"
                  className="p-1.5 text-red-400 hover:text-white hover:bg-red-500 rounded transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
              <button 
                onClick={() => setIsWideMode(!isWideMode)}
                title="Toggle Wide Mode"
                className="p-1.5 text-gray-400 hover:text-primary bg-gray-200/50 dark:bg-white/5 rounded transition-colors"
              >
                <PanelRight className="w-4 h-4" />
              </button>
              
              <button 
                disabled={saving || !isDirty}
                onClick={() => handleSave()}
                className={`flex items-center gap-1.5 px-4 py-1.5 rounded-md transition-colors text-xs font-semibold shadow-sm ${
                  isDirty 
                    ? 'bg-primary hover:bg-primary-hover text-white shadow-primary/20 cursor-pointer' 
                    : 'bg-gray-200 dark:bg-white/10 text-gray-400 cursor-not-allowed'
                }`}
              >
                <Save className="w-3.5 h-3.5" />
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button onClick={handleCloseAttempt} className="text-gray-400 hover:text-gray-600 dark:hover:text-white transition-colors cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>
        )}
        
        <div style={{ maxHeight: isFullscreen ? 'none' : 'calc(90vh - 70px)' }} className={`flex-1 overflow-y-auto ${isFullscreen ? 'p-0' : 'p-6'} flex flex-col gap-6 text-sm text-gray-800 dark:text-gray-200`}>
          
          {/* Metadata Section - Rendered either as a sidebar or wide horizontal bar */}
          {!isFullscreen && (
            <div className={isWideMode ? "flex gap-4 bg-gray-50 dark:bg-black/10 p-4 rounded-xl border border-gray-100 dark:border-white/5 items-center" : "grid grid-cols-3 gap-6"}>
              
              <div className={isWideMode ? "flex-1" : "col-span-2 space-y-4 flex flex-col"}>
                {!isWideMode && (
                  <div>
                    <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5">Title</label>
                    <input 
                      className="w-full bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 outline-none focus:border-primary font-medium text-base"
                      value={title} onChange={e => setTitle(e.target.value)} placeholder="Task title..."
                    />
                  </div>
                )}
                
                {/* When in wide mode, title sits next to the toggles */}
                {isWideMode && (
                  <div className="flex-1 mr-4">
                    <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5">Title</label>
                    <input 
                      className="w-full bg-white dark:bg-black/40 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-1.5 outline-none focus:border-primary font-medium text-sm"
                      value={title} onChange={e => setTitle(e.target.value)} placeholder="Task title..."
                    />
                  </div>
                )}
              </div>

              <div className={isWideMode ? "flex items-end gap-4" : "col-span-1 space-y-5 bg-gray-50 dark:bg-black/10 p-4 rounded-xl border border-gray-100 dark:border-white/5 h-fit"}>
                <div className={isWideMode ? "w-32" : ""}>
                  <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5">Status</label>
                  <select 
                    className="w-full bg-white dark:bg-[#252630] border border-gray-200 dark:border-white/10 rounded-lg px-3 py-1.5 outline-none focus:border-primary cursor-pointer font-medium"
                    value={status} onChange={e => setStatus(e.target.value)}
                  >
                    {allStatuses.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>

                <div className={isWideMode ? "w-32" : ""}>
                  <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5">Assignee</label>
                  <select 
                    className="w-full bg-white dark:bg-[#252630] border border-gray-200 dark:border-white/10 rounded-lg px-3 py-1.5 outline-none focus:border-primary cursor-pointer font-medium"
                    value={assignee} onChange={e => setAssignee(e.target.value)}
                  >
                    <option value="unassigned">Unassigned</option>
                    {allUsers.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>

                <div className={isWideMode ? "w-64" : ""}>
                  <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5">Tags</label>
                  <TagSelector tags={tags} onChange={setTags} availableTags={allTags} configTags={config.tags} />
                </div>
              </div>

            </div>
          )}

          {/* Markdown Editor Section */}
          <div className={isFullscreen ? 'fixed inset-0 z-[100] bg-white dark:bg-[#1a1b23] flex flex-col' : 'flex-1 flex flex-col min-h-[300px]'}>
            {!isFullscreen && <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5">Description</label>}
            
            <div className={`flex-1 flex flex-col border border-gray-200 dark:border-white/10 ${isFullscreen ? 'border-0 h-full w-full max-w-5xl mx-auto' : 'rounded-lg bg-gray-50 dark:bg-black/20'}`}>
              <div className="flex items-center gap-1 p-2 border-b border-gray-200 dark:border-white/10 bg-gray-100/50 dark:bg-white/5">
                <button onClick={() => insertMarkdown('**', '**')} title="Bold" className="p-1.5 text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10 rounded"><Bold className="w-4 h-4" /></button>
                <button onClick={() => insertMarkdown('*', '*')} title="Italic" className="p-1.5 text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10 rounded"><Italic className="w-4 h-4" /></button>
                <div className="w-px h-4 bg-gray-300 dark:bg-white/10 mx-1" />
                <button onClick={() => insertMarkdown('- ')} title="Bullet List" className="p-1.5 text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10 rounded"><List className="w-4 h-4" /></button>
                <button onClick={() => insertMarkdown('`', '`')} title="Code" className="p-1.5 text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10 rounded"><Code className="w-4 h-4" /></button>
                <button onClick={() => insertMarkdown('[', '](url)')} title="Link" className="p-1.5 text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10 rounded"><LinkIcon className="w-4 h-4" /></button>
                
                <div className="flex-1" />
                <button 
                  onClick={() => setIsFullscreen(!isFullscreen)} 
                  title="Toggle Fullscreen" 
                  className="p-1.5 text-gray-500 hover:text-primary hover:bg-primary/10 rounded ml-auto flex items-center gap-2 text-xs font-medium"
                >
                  {isFullscreen ? <><Minimize2 className="w-4 h-4" /> Exit Fullscreen</> : <><Maximize2 className="w-4 h-4" /></>}
                </button>
              </div>
              <textarea 
                ref={textareaRef}
                className={`w-full flex-1 bg-transparent px-4 py-3 outline-none focus:ring-1 focus:ring-primary/50 resize-y font-mono text-sm leading-relaxed ${isFullscreen ? 'p-8 text-base' : ''}`}
                value={body} onChange={e => setBody(e.target.value)} placeholder="Markdown supported..."
              />
            </div>
          </div>

          {/* Comments Section (Hidden in Fullscreen) */}
          {!isFullscreen && (
            <div className="border-t border-gray-200 dark:border-white/10 pt-6 mt-2">
              <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-4 flex items-center gap-2">
                <MessageSquare className="w-4 h-4" /> Activity & Comments
              </h3>

              <div className="space-y-4 mb-6">
                {(!modalTask?.history || modalTask.history.length === 0) ? (
                  <p className="text-sm text-gray-500 italic">No activity yet.</p>
                ) : (
                  [...modalTask.history].reverse().map((entry, idx) => (
                    <div key={idx} className="flex gap-3">
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                        {entry.type === 'status_change' ? <ArrowRight className="w-3 h-3 text-primary" /> : <MessageSquare className="w-3 h-3 text-primary" />}
                      </div>
                      <div className="flex-1 bg-gray-50 dark:bg-black/20 border border-gray-100 dark:border-white/5 rounded-lg p-3">
                        <div className="flex justify-between items-center mb-1">
                          <span className="font-semibold text-xs text-gray-800 dark:text-gray-200">{entry.user}</span>
                          <span className="text-[10px] text-gray-500">{new Date(entry.date).toLocaleString()}</span>
                        </div>
                        {entry.type === 'status_change' && (
                          <div className="flex items-center gap-2 text-xs text-gray-500 mb-1.5">
                            Moved from <span className="font-semibold text-gray-700 dark:text-gray-300">{entry.from}</span>
                            <ArrowRight className="w-3 h-3" />
                            <span className="font-semibold text-gray-700 dark:text-gray-300">{entry.to}</span>
                          </div>
                        )}
                        {entry.comment && (
                          <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">{entry.comment}</p>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div className="relative">
                <textarea 
                  className="w-full bg-white dark:bg-black/40 border border-gray-200 dark:border-white/10 rounded-xl px-4 py-3 pb-12 outline-none focus:border-primary resize-none text-sm h-28 placeholder-gray-400"
                  value={newComment} onChange={e => setNewComment(e.target.value)} placeholder="Add a comment..."
                />
                <div className="absolute bottom-3 right-3 flex items-center">
                  <button 
                    disabled={saving || !newComment.trim() || !modalTask?.id}
                    onClick={sendCommentDirectly}
                    className="flex items-center gap-1.5 px-4 py-1.5 bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors text-xs font-semibold disabled:opacity-50 cursor-pointer shadow-sm"
                  >
                    <SendHorizontal className="w-3.5 h-3.5" />
                    {saving ? 'Sending...' : 'Send'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </Rnd>

      {/* Delete Confirmation Dialog */}
      {confirmDelete && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm pointer-events-auto">
          <div className="bg-white dark:bg-[#1a1b23] p-6 rounded-xl shadow-2xl w-[400px] border border-gray-200 dark:border-white/10">
            <h3 className="text-lg font-bold mb-2 text-red-500">Delete Task?</h3>
            <p className="text-sm text-gray-500 mb-6">Are you absolutely sure you want to delete this task? This will permanently delete the markdown file from disk.</p>
            <div className="flex justify-end gap-3">
              <button 
                onClick={() => setConfirmDelete(false)}
                className="px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-100 dark:hover:bg-white/5 cursor-pointer transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={handleDelete}
                disabled={saving}
                className="px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded-lg text-sm font-medium cursor-pointer transition-colors"
              >
                {saving ? 'Deleting...' : 'Delete Task'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Discard Confirmation Dialog */}
      {confirmDiscard && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm pointer-events-auto">
          <div className="bg-white dark:bg-[#1a1b23] p-6 rounded-xl shadow-2xl w-[400px] border border-gray-200 dark:border-white/10">
            <h3 className="text-lg font-bold mb-2">Discard changes?</h3>
            <p className="text-sm text-gray-500 mb-6">You have unsaved changes. Are you sure you want to close without saving?</p>
            <div className="flex justify-end gap-3">
              <button 
                onClick={() => setConfirmDiscard(false)}
                className="px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-100 dark:hover:bg-white/5 cursor-pointer transition-colors"
              >
                Keep Editing
              </button>
              <button 
                onClick={() => { setConfirmDiscard(false); closeModal(); }}
                className="px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded-lg text-sm font-medium cursor-pointer transition-colors"
              >
                Discard Changes
              </button>
              <button 
                onClick={() => { setConfirmDiscard(false); handleSave(); }}
                className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-medium cursor-pointer transition-colors"
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
