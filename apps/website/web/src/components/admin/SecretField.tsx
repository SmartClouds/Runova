import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from './Field';

interface SecretFieldProps {
  id: string;
  label: string;
  saved: boolean;
  /** How the saved secret is named in "A … is saved" and the Replace button. */
  noun: string;
  value: string;
  errors: string[];
  onChange: (value: string) => void;
}

/** A secret the page never shows: "saved" with a Replace button, or an empty field to type one. */
export function SecretField({ id, label, saved, noun, value, errors, onChange }: SecretFieldProps) {
  const [replacing, setReplacing] = useState(false);
  useEffect(() => {
    if (!value) setReplacing(false);
  }, [value]);
  if (saved && !replacing) {
    return (
      <p className="text-sm">
        A {noun} is saved.{' '}
        <Button
          type="button"
          variant="link"
          className="h-auto px-0"
          aria-label={`Replace the ${noun}`}
          onClick={() => setReplacing(true)}
        >
          Replace
        </Button>
      </p>
    );
  }
  return (
    <Field
      id={id}
      label={label}
      errors={errors}
      hint={saved ? 'Leave it empty to keep the saved one.' : undefined}
    >
      {(control) => (
        <Input
          {...control}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoFocus={replacing}
        />
      )}
    </Field>
  );
}

export function Switch({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-center gap-2 font-medium text-sm">
      <input
        type="checkbox"
        className="size-4 accent-primary"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {children}
    </label>
  );
}
