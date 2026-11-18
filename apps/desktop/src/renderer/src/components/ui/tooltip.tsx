import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as React from 'react';
import { cn } from '@/lib/utils';

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 8, collisionPadding = 8, hideWhenDetached = true, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      // A trigger that disappears without the pointer leaving it (a page kept mounted but
      // hidden, a navigation by keyboard) never closes its tooltip, so hide it instead.
      hideWhenDetached={hideWhenDetached}
      className={cn(
        // `max-w` + wrapping keeps long labels (file paths, run commands, error
        // text) from stretching into one unreadable line off the window edge. A compact
        // frosted chip with the menus' corners and no edge, so it reads lighter than a menu.
        'overlay-motion z-50 max-w-[min(22rem,calc(100vw-2rem))] origin-[var(--radix-tooltip-content-transform-origin)] overflow-hidden whitespace-pre-line break-words rounded-lg bg-popover/80 px-2.5 py-1.5 text-xs font-medium leading-relaxed text-popover-foreground shadow-[0_8px_24px_-6px_hsl(0_0%_0%/0.35)] backdrop-blur-xl data-[state=delayed-open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=delayed-open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1',
        className,
      )}
      {...props}
    >
      {props.children}
      <TooltipPrimitive.Arrow className="fill-popover/80" />
    </TooltipPrimitive.Content>
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

interface SimpleTooltipProps {
  label: React.ReactNode;
  children: React.ReactElement;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  /** Extra classes for the bubble, e.g. a wider `max-w` for prose. */
  className?: string;
  /**
   * Wrap the child in an inline span that becomes the hover target. Needed for
   * disabled controls, which never emit the pointer events Radix listens for.
   */
  wrapTrigger?: boolean;
  delayDuration?: number;
  /**
   * What screen readers announce instead of the label. Radix otherwise copies the label into a
   * hidden node for them, which mounts a rich label (one with controls or effects) twice.
   */
  ariaLabel?: string;
}

/**
 * The app-wide replacement for the native `title` attribute: same one-prop
 * ergonomics, but styled, positioned, and animated like the rest of the UI.
 */
function SimpleTooltip({
  label,
  children,
  side,
  align,
  className,
  wrapTrigger = false,
  delayDuration = 300,
  ariaLabel,
}: SimpleTooltipProps): React.JSX.Element {
  // Nothing to show, hand the child back untouched so callers can pass
  // optional values (an absent run command, a missing error) straight through.
  if (label === null || label === undefined || label === false || label === '') {
    return children;
  }

  return (
    <Tooltip delayDuration={delayDuration}>
      <TooltipTrigger asChild>
        {wrapTrigger ? <span className="inline-flex">{children}</span> : children}
      </TooltipTrigger>
      <TooltipContent side={side} align={align} className={className} aria-label={ariaLabel}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export { SimpleTooltip, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
