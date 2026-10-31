import type { RefObject } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface ConflictDialogProps {
  open: boolean;
  onLoadTheirs: () => void;
  onOverwrite: () => void;
  onCancel: () => void;
  /** Gets focus back when the dialog closes, since no trigger opened it. */
  returnFocus: RefObject<HTMLButtonElement | null>;
}

/** Shown on 412: someone saved the item after this editor loaded it. */
export function ConflictDialog({
  open,
  onLoadTheirs,
  onOverwrite,
  onCancel,
  returnFocus,
}: ConflictDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus.current?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Someone else saved this item</AlertDialogTitle>
          <AlertDialogDescription>
            It changed after you opened it. Load their version to see what they wrote (your changes
            here are lost), or save yours over it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="border bg-background text-foreground hover:bg-accent"
            onClick={onOverwrite}
          >
            Save mine over theirs
          </AlertDialogAction>
          <AlertDialogAction onClick={onLoadTheirs}>Load their version</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
