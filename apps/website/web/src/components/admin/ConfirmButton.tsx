import type { ReactNode, Ref } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';

interface ConfirmButtonProps {
  /** The button that opens the question. */
  label: string;
  title: string;
  description: ReactNode;
  /** The button in the dialog that goes ahead. */
  confirmLabel: string;
  onConfirm: () => void;
  /** Fields that shape the action, such as how long an old key keeps working. */
  children?: ReactNode;
  /** The opening button, for an action whose result should hand focus back to it. */
  triggerRef?: Ref<HTMLButtonElement>;
}

/**
 * A button for an action that can not be taken back. It asks first; Cancel and Escape leave
 * everything as it was and give focus back to the button.
 */
export function ConfirmButton({
  label,
  title,
  description,
  confirmLabel,
  onConfirm,
  children,
  triggerRef,
}: ConfirmButtonProps) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button ref={triggerRef} type="button" variant="outline">
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: 'destructive' })}
            onClick={onConfirm}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
