import { ChevronDown, Eye, EyeOff } from 'lucide-react';
import { type ComponentProps, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * The account panel's form controls, drawn like the app's (desktop `components/ui/input.tsx`,
 * `secret-input.tsx` and `checkbox.tsx`) rather than like the site's own shadcn fields. The
 * unlayered `.app-field` rule in global.css carries the app's wash, edge, hover, focus, invalid and
 * disabled states, so only shape and size are set here. tests/accountFields.test.tsx keeps every
 * control in the panel coming from this file.
 */
const FIELD = 'app-field flex h-9 w-full min-w-0 rounded-full px-3.5 py-1 text-foreground text-sm';

/** A one-line text field: the app's soft pill. */
export function AppInput({ className, ...props }: ComponentProps<'input'>) {
  return <input data-slot="input" className={cn(FIELD, className)} {...props} />;
}

/** A password field with the app's eye toggle sitting inside the pill's round end. */
export function PasswordInput({ className, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <AppInput
        {...props}
        type={visible ? 'text' : 'password'}
        spellCheck={false}
        className={cn('pr-10', visible && 'font-mono', className)}
      />
      <button
        type="button"
        onClick={() => setVisible((current) => !current)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        className="absolute top-1/2 right-1 grid size-7 -translate-y-1/2 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {visible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </button>
    </div>
  );
}

/** A select drawn as a field pill, with the app's chevron in place of the native arrow. */
export function AppSelect({
  className,
  size = 'default',
  ...props
}: Omit<ComponentProps<'select'>, 'size'> & { size?: 'default' | 'sm' }) {
  return (
    <div className={cn('relative', size === 'sm' ? 'inline-flex' : 'flex')}>
      <select
        className={cn(
          FIELD,
          'cursor-pointer appearance-none pr-8',
          size === 'sm' && 'h-8 w-auto px-3 pr-8',
          className,
        )}
        {...props}
      />
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}

/** A radio drawn like the app's checkbox, only round: a soft ring that fills with green. */
export function AppRadio({ className, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  return (
    <input
      type="radio"
      className={cn(
        'size-[18px] shrink-0 cursor-pointer appearance-none rounded-full border-[1.5px] border-foreground/30 bg-foreground/5 transition-all duration-150 hover:border-foreground/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40',
        'checked:border-primary checked:bg-primary checked:shadow-[inset_0_0_0_3.5px_hsl(var(--card)),0_0_10px_-2px_hsl(var(--primary)/0.7)]',
        className,
      )}
      {...props}
    />
  );
}
