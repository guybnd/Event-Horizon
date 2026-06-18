import type { TaskModalController } from '../../hooks/useTaskModalController';

type ModalDialogsProps = Pick<TaskModalController,
  | 'confirmDelete'
  | 'setConfirmDelete'
  | 'handleDelete'
  | 'saving'
  | 'confirmDiscard'
  | 'setConfirmDiscard'
  | 'closeModal'
  | 'handleSave'
  | 'isFullView'
>;

export function ModalDialogs({
  confirmDelete,
  setConfirmDelete,
  handleDelete,
  saving,
  confirmDiscard,
  setConfirmDiscard,
  closeModal,
  handleSave,
  isFullView,
}: ModalDialogsProps) {
  return (
    <>
      {confirmDelete && (
        <div className="pointer-events-auto fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-[400px] rounded-xl border border-gray-200 bg-white p-6 shadow-2xl dark:border-white/10 dark:bg-[#1a1b23]">
            <h3 className="mb-2 text-lg font-bold text-red-500">Delete Task?</h3>
            <p className="mb-6 text-sm text-gray-500">
              Are you absolutely sure you want to delete this task? This will permanently delete the markdown file from disk.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirmDelete(false)}
                className="cursor-pointer rounded-lg px-4 py-2 text-sm font-medium transition-colors hover:bg-gray-100 dark:hover:bg-white/5"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={saving}
                className="cursor-pointer rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-600"
              >
                {saving ? 'Deleting...' : 'Delete Task'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDiscard && (
        <div className="pointer-events-auto fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-[400px] rounded-xl border border-gray-200 bg-white p-6 shadow-2xl dark:border-white/10 dark:bg-[#1a1b23]">
            <h3 className="mb-2 text-lg font-bold">Discard changes?</h3>
            <p className="mb-6 text-sm text-gray-500">You have unsaved changes. Are you sure you want to close without saving?</p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirmDiscard(false)}
                className="cursor-pointer rounded-lg px-4 py-2 text-sm font-medium transition-colors hover:bg-gray-100 dark:hover:bg-white/5"
              >
                Keep Editing
              </button>
              <button
                onClick={() => {
                  setConfirmDiscard(false);
                  closeModal();
                }}
                className="cursor-pointer rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-600"
              >
                Discard Changes
              </button>
              <button
                onClick={() => {
                  setConfirmDiscard(false);
                  void handleSave(undefined, isFullView);
                }}
                className="cursor-pointer rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
