import type { RefObject } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { CopyField } from './CopyField';

interface SecretDialogProps {
  open: boolean;
  keyId: string;
  secret: string;
  /** Called once the Admin says the secret is saved; the caller then forgets it. */
  onDone: () => void;
  /**
   * Where focus goes once the dialog closes. Without it Radix returns focus to what had it when
   * the dialog opened, which is lost when that was a dialog that has closed since.
   */
  returnFocusTo?: RefObject<HTMLElement | null>;
}

/**
 * The one look an Admin gets at an API client's secret, right after it was made. The API never
 * hands it out again, so the dialog does not close on Escape or a click outside, only once the
 * Admin says it is saved.
 */
export function SecretDialog({ open, keyId, secret, onDone, returnFocusTo }: SecretDialogProps) {
  return (
    <AlertDialog open={open}>
      <AlertDialogContent
        onEscapeKeyDown={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => {
          if (!returnFocusTo?.current) return;
          event.preventDefault();
          returnFocusTo.current.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Copy the secret now</AlertDialogTitle>
          <AlertDialogDescription>
            This is the only time the secret is shown. Store it where the other system keeps its
            credentials. If it gets lost, rotate the secret to make a new one.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <dl className="grid gap-1 text-sm">
          <dt className="font-medium">Key id</dt>
          <dd className="font-mono">{keyId}</dd>
        </dl>
        <CopyField id="api-client-secret" label="Secret" value={secret} />
        <AlertDialogFooter>
          <AlertDialogAction onClick={onDone}>I have saved the secret</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
