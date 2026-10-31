import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ConflictDialog } from './ConflictDialog';
import { ErrorSummary } from './ErrorSummary';
import type { useItemEditor } from './useItemEditor';

interface EditorShellProps {
  editor: Pick<
    ReturnType<typeof useItemEditor>,
    'phase' | 'problem' | 'message' | 'save' | 'saveButton' | 'summary' | 'conflict'
  >;
  title: string;
  /** Field errors the form has no field for. */
  unplaced: string[];
  children: ReactNode;
}

/**
 * The frame of an editor: its heading, the error summary, the form, the Save button and the
 * dialog a save over a newer version opens.
 */
export function EditorShell({ editor, title, unplaced, children }: EditorShellProps) {
  const { phase, problem, message } = editor;
  return (
    <div className="grid gap-6">
      <h1 className="font-display font-extrabold text-3xl tracking-tight">{title}</h1>
      <ErrorSummary problem={problem} unplaced={unplaced} summaryRef={editor.summary} />
      {phase === 'loading' && <p className="text-muted-foreground">Loading.</p>}
      {phase === 'ready' && (
        <form
          noValidate
          className="grid gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            void editor.save();
          }}
        >
          {children}
          <div className="flex flex-wrap items-center gap-4 border-t pt-6">
            <Button ref={editor.saveButton} type="submit">
              Save
            </Button>
            {message && (
              <p role="status" className="text-sm">
                {message}
              </p>
            )}
          </div>
          <ConflictDialog
            open={editor.conflict.open}
            onLoadTheirs={editor.conflict.loadTheirs}
            onOverwrite={editor.conflict.overwrite}
            onCancel={editor.conflict.cancel}
            returnFocus={editor.saveButton}
          />
        </form>
      )}
    </div>
  );
}
