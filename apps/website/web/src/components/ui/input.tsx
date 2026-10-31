import type * as React from 'react';

import { cn } from '@/lib/utils';

// shadcn/ui's Input (new-york), restyled with the site tokens.
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 py-1 text-base shadow-xs outline-none transition-[color,border-color] duration-[120ms] placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive md:text-sm file:mr-3 file:border-0 file:bg-transparent file:font-medium file:text-foreground file:text-sm',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
