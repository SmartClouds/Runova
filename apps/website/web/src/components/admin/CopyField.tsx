import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { Field } from './Field';

interface CopyFieldProps {
  id: string;
  label: string;
  value: string;
  hint?: string;
  className?: string;
}

/**
 * A read-only value with a button that copies it. When the browser will not let the page write
 * to the clipboard, the text is selected so the Admin can copy it by hand.
 */
export function CopyField({ id, label, value, hint, className }: CopyFieldProps) {
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setStatus('Copied.');
    } catch {
      input.current?.focus();
      input.current?.select();
      setStatus('The browser would not copy it. The text is selected: copy it by hand.');
    }
  };

  return (
    <Field id={id} label={label} hint={hint} className={className}>
      {(control) => (
        <div className="grid gap-2">
          <div className="flex gap-2">
            <Input
              {...control}
              ref={input}
              readOnly
              value={value}
              className="font-mono"
              onFocus={(event) => event.target.select()}
            />
            <Button type="button" variant="outline" onClick={copy}>
              Copy <span className="sr-only">{label.toLowerCase()}</span>
            </Button>
          </div>
          <p role="status" className={cn('text-sm', !status && 'sr-only')}>
            {status}
          </p>
        </div>
      )}
    </Field>
  );
}
