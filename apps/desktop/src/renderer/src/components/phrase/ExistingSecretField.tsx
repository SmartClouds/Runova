import { useState } from 'react';
import { Label } from '@/components/ui/label';
import { SecretInput } from '@/components/ui/secret-input';
import { cn } from '@/lib/utils';
import { PhraseInput, pastedPhrase } from './PhraseInput';

/**
 * A secret that already exists, to unlock or restore with (E107): a masked field, or the 24 word
 * boxes when it is a recovery phrase. Pasting a phrase into the field switches on its own.
 */
export function ExistingSecretField({
  id,
  label,
  value,
  onChange,
  autoFocus,
  placeholder,
  className,
  inputClassName,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
}): React.JSX.Element {
  const [byPhrase, setByPhrase] = useState(false);
  const [pasted, setPasted] = useState<string | undefined>(undefined);

  const switchTo = (phrase: boolean) => {
    setPasted(undefined);
    onChange('');
    setByPhrase(phrase);
  };

  return (
    <div className={cn('space-y-1.5', className)}>
      {byPhrase ? (
        <>
          <p className="text-sm font-medium leading-none">{label}</p>
          <PhraseInput autoFocus initial={pasted} onChange={onChange} />
        </>
      ) : (
        <>
          <Label htmlFor={id}>{label}</Label>
          <SecretInput
            id={id}
            value={value}
            onChange={onChange}
            autoFocus={autoFocus}
            placeholder={placeholder}
            className={inputClassName}
            onPaste={(event) => {
              const phrase = pastedPhrase(event);
              if (!phrase) return;
              event.preventDefault();
              setPasted(phrase);
              setByPhrase(true);
            }}
          />
        </>
      )}
      <button
        type="button"
        className="text-xs font-medium text-primary"
        onClick={() => switchTo(!byPhrase)}
      >
        {byPhrase ? 'Type it instead' : 'It is a recovery phrase'}
      </button>
    </div>
  );
}
