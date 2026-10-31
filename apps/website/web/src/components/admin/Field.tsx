import type { ReactNode } from 'react';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/** The props a field gives its control, so the label, hint and errors belong to it. */
export interface ControlProps {
  id: string;
  'aria-invalid'?: true;
  'aria-describedby'?: string;
}

interface FieldProps {
  id: string;
  label: ReactNode;
  /** The messages from the last failed save for this field. */
  errors?: string[];
  hint?: ReactNode;
  className?: string;
  children: (control: ControlProps) => ReactNode;
}

/** A label, its control, an optional hint and the field's errors right under it. */
export function Field({ id, label, errors = [], hint, className, children }: FieldProps) {
  const hintId = hint ? `${id}-hint` : null;
  const errorsId = errors.length > 0 ? `${id}-errors` : null;
  const describedBy = [hintId, errorsId].filter(Boolean).join(' ');
  return (
    <div className={cn('grid content-start gap-2', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children({
        id,
        ...(errorsId && { 'aria-invalid': true }),
        ...(describedBy && { 'aria-describedby': describedBy }),
      })}
      {hint && (
        <div id={hintId ?? undefined} className="text-muted-foreground text-sm">
          {hint}
        </div>
      )}
      <FieldErrors id={errorsId} errors={errors} />
    </div>
  );
}

export function FieldErrors({ id, errors }: { id: string | null; errors: string[] }) {
  if (!id || errors.length === 0) return null;
  return (
    <div id={id} className="grid gap-1 font-medium text-destructive text-sm">
      {errors.map((message) => (
        <p key={message}>{message}</p>
      ))}
    </div>
  );
}
