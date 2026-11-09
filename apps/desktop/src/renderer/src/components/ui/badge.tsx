import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@/lib/utils';

// Badges are borderless tinted chips like the page kit's. A border would only ever show the
// global `--border` colour, since the unlayered `* { border-color }` rule beats any border
// colour utility, so the outline variant draws its edge with an inset ring instead.
const badgeVariants = cva(
  'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors',
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow-[0_0_12px_-4px_hsl(var(--primary)/0.55)]',
        secondary: 'bg-foreground/[0.06] text-foreground/80',
        outline: 'text-muted-foreground ring-1 ring-inset ring-foreground/[0.12]',
        success: 'bg-success/12 text-success',
        warning: 'bg-warning/12 text-warning',
        destructive: 'bg-destructive/12 text-destructive',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

// A span because badges sit inside paragraphs and headings, where a div is invalid HTML.
function Badge({ className, variant, ...props }: BadgeProps): React.JSX.Element {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
