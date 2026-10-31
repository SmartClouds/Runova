import { Input } from '@/components/ui/input';
import { errorsFor, type FieldErrors } from '@/lib/admin/problems';
import type { Publishing, PublishMode } from '@/lib/admin/publishing';
import { Field, FieldErrors as Messages } from './Field';

const MODES: { mode: PublishMode; label: string }[] = [
  { mode: 'draft', label: 'Draft' },
  { mode: 'published', label: 'Publish now' },
  { mode: 'scheduled', label: 'Schedule' },
];

interface PublishingFieldsProps {
  id: string;
  value: Publishing;
  onChange: (value: Publishing) => void;
  errors: FieldErrors;
}

/** Draft, publish now, or schedule for a local time. */
export function PublishingFields({ id, value, onChange, errors }: PublishingFieldsProps) {
  const statusErrors = errorsFor(errors, 'status');
  return (
    <fieldset
      className="grid gap-3"
      aria-describedby={statusErrors.length > 0 ? `${id}-status-errors` : undefined}
    >
      <legend className="mb-2 font-medium text-sm">Publishing</legend>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {MODES.map(({ mode, label }) => (
          <label key={mode} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={`${id}-mode`}
              className="size-4 accent-primary"
              checked={value.mode === mode}
              onChange={() => onChange({ ...value, mode })}
            />
            {label}
          </label>
        ))}
      </div>
      <Messages id={`${id}-status-errors`} errors={statusErrors} />
      {value.mode === 'scheduled' && (
        <Field
          id={`${id}-at`}
          label="Publish at"
          hint="In your own time zone."
          errors={errorsFor(errors, 'publishedAt')}
          className="max-w-xs"
        >
          {(control) => (
            <Input
              {...control}
              type="datetime-local"
              value={value.scheduledAt}
              onChange={(event) => onChange({ ...value, scheduledAt: event.target.value })}
            />
          )}
        </Field>
      )}
    </fieldset>
  );
}

/** The publishing errors count as placed only while the field that shows them is on screen. */
export function publishingFieldNames(value: Publishing): string[] {
  return value.mode === 'scheduled' ? ['status', 'publishedAt'] : ['status'];
}
