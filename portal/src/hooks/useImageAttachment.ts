import { useCallback, useRef } from 'react';
import { buildUnsupportedImageMessage, uploadTaskImageMarkdownLinks } from '../taskAssetUploads';
import type { CommentBoxHandle } from '../components/task-modal/CommentBox';

interface UseImageAttachmentOptions {
  taskId: string | undefined;
  commentBoxRef: React.RefObject<CommentBoxHandle | null>;
  replyDraft: string;
  setReplyDraft: (value: string) => void;
  commentRef: React.RefObject<HTMLTextAreaElement | null>;
  replyTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
  setCommentAssetError: (value: string) => void;
  setIsUploadingCommentAsset: (value: boolean) => void;
  setReplyAssetError: (value: string) => void;
  setIsUploadingReplyAsset: (value: boolean) => void;
}

function insertTextIntoDraft(
  currentValue: string,
  setValue: (value: string) => void,
  targetTextArea: HTMLTextAreaElement | null,
  text: string,
  selectionStart?: number,
  selectionEnd?: number,
) {
  const start = selectionStart ?? targetTextArea?.selectionStart ?? currentValue.length;
  const end = selectionEnd ?? targetTextArea?.selectionEnd ?? currentValue.length;
  const nextValue = currentValue.substring(0, start) + text + currentValue.substring(end);
  setValue(nextValue);
  setTimeout(() => {
    if (!targetTextArea) return;
    const nextCursorPosition = start + text.length;
    targetTextArea.focus();
    targetTextArea.setSelectionRange(nextCursorPosition, nextCursorPosition);
  }, 0);
}

export function useImageAttachment({
  taskId,
  commentBoxRef,
  replyDraft,
  setReplyDraft,
  commentRef,
  replyTextareaRef,
  setCommentAssetError,
  setIsUploadingCommentAsset,
  setReplyAssetError,
  setIsUploadingReplyAsset,
}: UseImageAttachmentOptions) {
  const attachImageFilesToDraft = async ({
    files,
    currentValue,
    setValue,
    targetTextArea,
    selectionStart,
    selectionEnd,
    setError,
    setUploading,
  }: {
    files: File[];
    currentValue: string;
    setValue: (value: string) => void;
    targetTextArea: HTMLTextAreaElement | null;
    selectionStart?: number;
    selectionEnd?: number;
    setError: (value: string) => void;
    setUploading: (value: boolean) => void;
  }) => {
    if (files.length === 0) return;
    if (!taskId) {
      setError('Save the ticket before attaching images.');
      return;
    }
    setUploading(true);
    setError('');
    try {
      const { markdownLinks, unsupportedFiles } = await uploadTaskImageMarkdownLinks(taskId, files);
      if (markdownLinks.length === 0) {
        setError(buildUnsupportedImageMessage(unsupportedFiles));
        return;
      }
      insertTextIntoDraft(currentValue, setValue, targetTextArea, markdownLinks.join('\n\n'), selectionStart, selectionEnd);
      if (unsupportedFiles.length > 0) {
        setError(buildUnsupportedImageMessage(unsupportedFiles));
      }
    } catch (error) {
      console.error(error);
      setError(error instanceof Error ? error.message : 'Failed to attach image.');
    } finally {
      setUploading(false);
    }
  };

  const attachCommentImageFiles = async (files: File[], selectionStart?: number, selectionEnd?: number) => {
    const current = commentBoxRef.current?.getValue() ?? '';
    await attachImageFilesToDraft({
      files,
      currentValue: current,
      setValue: (newValue) => commentBoxRef.current?.setValue(newValue),
      targetTextArea: commentRef.current,
      selectionStart,
      selectionEnd,
      setError: setCommentAssetError,
      setUploading: setIsUploadingCommentAsset,
    });
  };

  const attachReplyImageFiles = async (files: File[], selectionStart?: number, selectionEnd?: number) => {
    await attachImageFilesToDraft({
      files,
      currentValue: replyDraft,
      setValue: setReplyDraft,
      targetTextArea: replyTextareaRef.current,
      selectionStart,
      selectionEnd,
      setError: setReplyAssetError,
      setUploading: setIsUploadingReplyAsset,
    });
  };

  const attachReplyImageFilesRef = useRef(attachReplyImageFiles);
  attachReplyImageFilesRef.current = attachReplyImageFiles;

  const handleCommentPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files || []);
    if (files.length === 0) return;
    event.preventDefault();
    void attachCommentImageFiles(files, event.currentTarget.selectionStart, event.currentTarget.selectionEnd);
  };

  const handleCommentDragOver = (event: React.DragEvent<HTMLTextAreaElement>) => {
    if (!Array.from(event.dataTransfer.types || []).includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  const handleCommentDrop = (event: React.DragEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.dataTransfer.files || []);
    if (files.length === 0) return;
    event.preventDefault();
    void attachCommentImageFiles(files, event.currentTarget.selectionStart, event.currentTarget.selectionEnd);
  };

  const handleReplyPaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files || []);
    if (files.length === 0) return;
    event.preventDefault();
    void attachReplyImageFilesRef.current(files, event.currentTarget.selectionStart, event.currentTarget.selectionEnd);
  }, []);

  const handleReplyDragOver = useCallback((event: React.DragEvent<HTMLTextAreaElement>) => {
    if (!Array.from(event.dataTransfer.types || []).includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleReplyDrop = useCallback((event: React.DragEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.dataTransfer.files || []);
    if (files.length === 0) return;
    event.preventDefault();
    void attachReplyImageFilesRef.current(files, event.currentTarget.selectionStart, event.currentTarget.selectionEnd);
  }, []);

  return {
    attachCommentImageFiles,
    attachReplyImageFiles,
    handleCommentPaste,
    handleCommentDragOver,
    handleCommentDrop,
    handleReplyPaste,
    handleReplyDragOver,
    handleReplyDrop,
  };
}
