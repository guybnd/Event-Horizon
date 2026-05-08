import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, Bot, Check, ChevronRight, Copy, ExternalLink, GitBranch, MessageCircle, Trash2, X } from 'lucide-react';
import type { Task } from '../types';
import { useApp } from '../AppContext';
import { deleteTask, startTaskCliSession, updateTask } from '../api';
import { getArchiveStatus } from '../workflow';

const AGENT_COMMANDS = [
  { label: 'Implement', command: (id: string) => `implement ${id}` },
  { label: 'Groom', command: (id: string) => `groom ${id}` },
  { label: 'Finish', command: (id: string) => `finish ${id}` },
  { label: 'Review', command: (id: string) => `review ${id}` },
];

interface Props {
  task: Task;
  position: { x: number; y: number };
  onClose: () => void;
}

export function ContextMenu({ task, position, onClose }: Props) {
  const { config, currentUser, openTaskModal, openTaskFullView, triggerRefresh, readComments, markAllCommentsRead } = useApp();
  const menuRef = useRef<HTMLDivElement>(null);
  const [activeSubmenu, setActiveSubmenu] = useState<'transition' | 'agent' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  // Adjust position to keep menu on screen
  const [pos, setPos] = useState(position);
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    let { x, y } = position;
    if (x + rect.width + 4 > window.innerWidth) x = window.innerWidth - rect.width - 8;
    if (y + rect.height + 4 > window.innerHeight) y = window.innerHeight - rect.height - 8;
    setPos({ x: Math.max(8, x), y: Math.max(8, y) });
  }, [position]);

  // Close on outside click or Escape
  useEffect(() => {
    const handleDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  const allStatuses = [
    ...(config?.columns?.map(c => c.name) ?? []),
    ...(config?.hiddenStatuses?.map(h => h.name) ?? []),
  ].filter((s, i, arr) => arr.indexOf(s) === i && s !== task.status);

  const archiveStatus = getArchiveStatus(config);
  const commentIds = (task.history ?? []).filter(e => e.type === 'comment' && e.id).map(e => e.id!);
  const readIds = new Set(readComments[task.id] ?? []);
  const hasUnread = commentIds.some(id => !readIds.has(id));

  const boardCardOpenMode = config?.boardCardOpenMode || 'full';

  const handleOpen = () => {
    if (boardCardOpenMode === 'full') {
      openTaskFullView(task);
    } else {
      openTaskModal(task);
    }
    onClose();
  };

  const handleLaunchAgent = () => {
    onClose();
    void startTaskCliSession(task.id, 'claude', undefined, true).then(() => triggerRefresh());
  };

  const handleTransition = async (status: string) => {
    onClose();
    await updateTask(task.id, { status, updatedBy: currentUser } as any);
    triggerRefresh();
  };

  const handleArchive = async () => {
    onClose();
    await updateTask(task.id, { status: archiveStatus, updatedBy: currentUser } as any);
    triggerRefresh();
  };

  const handleDelete = async () => {
    onClose();
    await deleteTask(task.id);
    triggerRefresh();
  };

  const handleCopyCommand = (cmd: string) => {
    void navigator.clipboard.writeText(cmd);
    setCopied(cmd);
    setTimeout(() => {
      setCopied(null);
      onClose();
    }, 900);
  };

  const handleMarkRead = () => {
    markAllCommentsRead(task.id, commentIds);
    onClose();
  };

  return createPortal(
    <div
      ref={menuRef}
      style={{ position: 'fixed', top: pos.y, left: pos.x, zIndex: 1000000 }}
      className="min-w-[200px] rounded-xl border border-gray-200/80 bg-white/95 py-1 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-[#1e1f2a]/95"
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Open / Edit */}
      <MenuItem icon={<ExternalLink className="h-3.5 w-3.5" />} onClick={handleOpen}>
        Edit / Open
      </MenuItem>

      {/* Launch Agent */}
      <MenuItem icon={<Bot className="h-3.5 w-3.5" />} onClick={handleLaunchAgent}>
        Launch Agent
      </MenuItem>

      {/* Mark comments as read */}
      {hasUnread && (
        <MenuItem icon={<MessageCircle className="h-3.5 w-3.5" />} onClick={handleMarkRead}>
          Mark comments as read
        </MenuItem>
      )}

      <Divider />

      {/* Transition to → */}
      <SubMenuItem
        icon={<GitBranch className="h-3.5 w-3.5" />}
        label="Transition to"
        open={activeSubmenu === 'transition'}
        onOpen={() => setActiveSubmenu(activeSubmenu === 'transition' ? null : 'transition')}
      >
        {allStatuses.map((s) => (
          <MenuItem key={s} onClick={() => void handleTransition(s)}>
            {s}
          </MenuItem>
        ))}
      </SubMenuItem>

      {/* Copy agent command → */}
      <SubMenuItem
        icon={<Copy className="h-3.5 w-3.5" />}
        label="Copy agent command"
        open={activeSubmenu === 'agent'}
        onOpen={() => setActiveSubmenu(activeSubmenu === 'agent' ? null : 'agent')}
      >
        {AGENT_COMMANDS.map((item) => {
          const cmd = item.command(task.id);
          const isCopied = copied === cmd;
          return (
            <MenuItem
              key={item.label}
              icon={isCopied ? <Check className="h-3.5 w-3.5 text-green-500" /> : undefined}
              onClick={() => handleCopyCommand(cmd)}
            >
              <span className="flex-1">{item.label}</span>
              <span className="ml-2 truncate text-[10px] text-gray-400 dark:text-gray-500">{cmd}</span>
            </MenuItem>
          );
        })}
      </SubMenuItem>

      <Divider />

      {/* Archive */}
      {task.status !== archiveStatus && (
        <MenuItem icon={<Archive className="h-3.5 w-3.5" />} onClick={() => void handleArchive()}>
          Archive
        </MenuItem>
      )}

      {/* Delete */}
      {confirmDelete ? (
        <div className="flex items-center gap-1 px-3 py-1.5">
          <span className="flex-1 text-xs font-medium text-red-500">Confirm delete?</span>
          <button
            onClick={() => void handleDelete()}
            className="rounded px-2 py-0.5 text-[10px] font-semibold text-white bg-red-500 hover:bg-red-600 transition-colors"
          >
            Yes
          </button>
          <button
            onClick={() => setConfirmDelete(false)}
            className="rounded px-2 py-0.5 text-[10px] font-semibold text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/10 transition-colors"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : (
        <MenuItem
          icon={<Trash2 className="h-3.5 w-3.5" />}
          danger
          onClick={() => setConfirmDelete(true)}
        >
          Delete
        </MenuItem>
      )}
    </div>,
    document.body
  );
}

function Divider() {
  return <div className="my-1 border-t border-gray-100 dark:border-white/5" />;
}

function MenuItem({
  icon,
  danger,
  onClick,
  children,
}: {
  icon?: React.ReactNode;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
        danger
          ? 'text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10'
          : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/5'
      }`}
    >
      {icon && <span className={`flex-none ${danger ? 'text-red-400' : 'text-gray-400'}`}>{icon}</span>}
      {children}
    </button>
  );
}

function SubMenuItem({
  icon,
  label,
  open,
  onOpen,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  open: boolean;
  onOpen: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/5"
      >
        <span className="flex-none text-gray-400">{icon}</span>
        <span className="flex-1">{label}</span>
        <ChevronRight className={`h-3.5 w-3.5 flex-none text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="border-t border-gray-100 bg-gray-50/60 dark:border-white/5 dark:bg-white/3">
          {children}
        </div>
      )}
    </div>
  );
}
