import { useState } from 'react';
import { Plus, X, GripVertical, AlertCircle, ChevronUp, ChevronDown, Equal } from 'lucide-react';
import type { TagDef, StatusDef, PriorityDef } from '../../types';
import { StatusBadge } from '../StatusBadge';
import { getDefaultStatusColor, STATUS_COLOR_PALETTE } from '../../statusStyles';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

export const COLOR_PALETTE = [
  'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-400',
];

export const SWATCH_COLORS: Record<string, string> = {
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

export function getPaletteSwatchColor(colorClass: string) {
  const match = colorClass.match(/(?:bg|text)-([a-z]+)-\d+/);
  if (!match) return SWATCH_COLORS.gray;
  return SWATCH_COLORS[match[1]] || SWATCH_COLORS.gray;
}

export function SortableRow({ id, children }: { id: string; children: React.ReactNode }) {
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

export const StatusColorPicker = ({
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

export const TagEditor = ({ items, setItems }: { items: TagDef[]; setItems: (items: TagDef[]) => void }) => {
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

export const StatusEditor = ({ items, setItems, placeholder, sortable = false }: { items: StatusDef[]; setItems: (items: StatusDef[]) => void; placeholder: string; sortable?: boolean }) => {
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

export const PriorityEditor = ({ items, setItems }: { items: PriorityDef[]; setItems: (items: PriorityDef[]) => void }) => {
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

export function SettingToggleCard({
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

export const SimpleEditor = ({ items, setItems, placeholder, sortable = false }: { items: { name: string; originalName?: string }[]; setItems: (items: any[]) => void; placeholder: string; sortable?: boolean }) => {
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
