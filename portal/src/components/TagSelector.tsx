import { useState } from 'react';
import { X } from 'lucide-react';
import type { TagDef } from '../types';

export function TagSelector({
  tags,
  onChange,
  availableTags,
  configTags,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  availableTags: string[];
  configTags: TagDef[];
}) {
  const [input, setInput] = useState('');
  const [focused, setFocused] = useState(false);

  const addTag = (tag: string) => {
    // Trim and reject empty/whitespace-only tags, and never add a duplicate —
    // an empty or repeated tag would break tag-keyed lists downstream.
    const trimmed = tag.trim();
    if (trimmed && !tags.includes(trimmed)) onChange([...tags, trimmed]);
    setInput('');
  };

  const removeTag = (tag: string) => {
    onChange(tags.filter((currentTag) => currentTag !== tag));
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && input.trim()) {
      event.preventDefault();
      addTag(input.trim());
    } else if (event.key === 'Backspace' && !input && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    }
  };

  const unselected = availableTags.filter(
    (tag) => !tags.includes(tag) && tag.toLowerCase().includes(input.toLowerCase())
  );

  return (
    <div className="relative flex-1">
      <div
        className={`flex min-h-[38px] w-full cursor-text flex-wrap items-center gap-1.5 rounded-lg border px-2 py-1.5 transition-colors ${
          focused
            ? 'border-primary'
            : 'border-gray-200 bg-gray-50 dark:border-white/10 dark:bg-black/20'
        }`}
        onClick={() => document.getElementById('tag-input')?.focus()}
      >
        {tags.map((tag, i) => {
          const color =
            configTags.find((configTag) => configTag.name === tag)?.color ||
            'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
          return (
            <span key={i} className={`flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${color}`}>
              {tag}
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  removeTag(tag);
                }}
                className="hover:opacity-70"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          );
        })}
        <input
          id="tag-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 200)}
          className="min-w-[60px] flex-1 bg-transparent text-sm text-gray-800 outline-none dark:text-gray-200"
          placeholder={tags.length === 0 ? 'Add tags...' : ''}
        />
      </div>
      {focused && unselected.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-[60] mt-1 max-h-40 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-xl dark:border-white/10 dark:bg-[#252630]">
          {unselected.map((tag) => (
            <div
              key={tag}
              onMouseDown={(event) => {
                event.preventDefault();
                addTag(tag);
              }}
              className="cursor-pointer px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/5"
            >
              {tag}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
