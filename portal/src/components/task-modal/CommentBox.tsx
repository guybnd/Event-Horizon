import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { SendHorizontal } from 'lucide-react';

export interface CommentBoxHandle {
  getValue(): string;
  reset(): void;
  setValue(value: string): void;
}

interface CommentBoxProps {
  onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onDragOver: (event: React.DragEvent<HTMLTextAreaElement>) => void;
  onDrop: (event: React.DragEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  saving: boolean;
  isUploading: boolean;
  assetError: string;
  isRequireInput: boolean;
  disabled: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}

export const CommentBox = forwardRef<CommentBoxHandle, CommentBoxProps>(function CommentBox({
  onPaste, onDragOver, onDrop, onSend,
  saving, isUploading, assetError, isRequireInput, disabled, textareaRef,
}, ref) {
  const valueRef = useRef('');
  const [value, setValueState] = useState('');

  const setLocalValue = (newValue: string) => {
    valueRef.current = newValue;
    setValueState(newValue);
  };

  useImperativeHandle(ref, () => ({
    getValue: () => valueRef.current,
    reset: () => {
      valueRef.current = '';
      setValueState('');
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    },
    setValue: (newValue: string) => {
      valueRef.current = newValue;
      setValueState(newValue);
    },
  }), [textareaRef]);

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        autoFocus={isRequireInput}
        style={{ minHeight: '80px' }}
        className="w-full resize-none overflow-hidden rounded-xl border border-gray-200 bg-white px-4 py-3 pb-12 text-sm outline-none placeholder:text-gray-400 focus:border-primary dark:border-white/10 dark:bg-black/40 transition-all"
        value={value}
        onChange={(event) => {
          setLocalValue(event.target.value);
          event.target.style.height = 'auto';
          event.target.style.height = event.target.scrollHeight + 'px';
        }}
        onPaste={onPaste}
        onDragOver={onDragOver}
        onDrop={onDrop}
        placeholder={isRequireInput ? 'Type your response...' : 'Add a comment...'}
      />
      <div className="mt-2 flex items-center justify-between gap-3 px-1 text-[11px] text-gray-500 dark:text-gray-400">
        <span>Paste or drop PNG, JPG, or SVG images to attach them.</span>
        {isUploading && <span className="font-semibold text-primary">Uploading image...</span>}
      </div>
      {assetError && (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
          {assetError}
        </div>
      )}
      <div className="absolute bottom-3 right-3 flex items-center">
        <button
          disabled={saving || isUploading || !value.trim() || disabled}
          onClick={onSend}
          className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-primary-hover disabled:opacity-50"
        >
          <SendHorizontal className="h-3.5 w-3.5" />
          {saving ? 'Sending...' : 'Send'}
        </button>
      </div>
    </div>
  );
});
