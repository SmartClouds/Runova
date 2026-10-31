import type * as React from 'react';

import { cn } from '@/lib/utils';

// shadcn/ui's NativeSelect (new-york): a plain <select>, so the keyboard and screen readers get the
// platform's own list, styled like Input.
function NativeSelect({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        'flex h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 py-1 text-base shadow-xs outline-none transition-[color,border-color] duration-[120ms] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive md:text-sm',
        className,
      )}
      {...props}
    />
  );
}

export { NativeSelect };
