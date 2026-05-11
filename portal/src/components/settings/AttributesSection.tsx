import type { TagDef, PriorityDef } from '../../types';
import { TagEditor, PriorityEditor } from './shared';

interface AttributesSectionProps {
  tags: TagDef[];
  setTags: (items: TagDef[]) => void;
  priorities: PriorityDef[];
  setPriorities: (items: PriorityDef[]) => void;
}

export function AttributesSection({ tags, setTags, priorities, setPriorities }: AttributesSectionProps) {
  return (
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
  );
}
