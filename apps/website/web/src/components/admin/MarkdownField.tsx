import { useMemo } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { renderPreview } from '@/lib/admin/markdown';
import { Field } from './Field';

interface MarkdownFieldProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  errors?: string[];
}

/** The Markdown body and a live preview of it, side by side on wide screens. */
export function MarkdownField({ id, value, onChange, errors }: MarkdownFieldProps) {
  const html = useMemo(() => renderPreview(value), [value]);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Field id={id} label="Body (Markdown)" errors={errors}>
        {(control) => (
          <Textarea
            {...control}
            className="min-h-80 font-mono"
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        )}
      </Field>
      <section aria-labelledby={`${id}-preview`} className="grid content-start gap-2">
        <h2 id={`${id}-preview`} className="font-medium text-sm leading-none">
          Preview
        </h2>
        <div
          className="prose min-h-80 rounded-md border p-4"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: renderPreview sanitizes with DOMPurify.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </section>
    </div>
  );
}
