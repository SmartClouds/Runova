import { motion, useAnimationControls, useReducedMotion } from 'framer-motion';
import { type ReactNode, useEffect } from 'react';
import type { IconProps } from '@/components/icons';
import { cn } from '@/lib/utils';

/**
 * The frame for the setup and lock screens: one card in the middle of the page with the lock
 * emblem on top. The two rings echo a keyhole plate, and the card nudges sideways when a
 * password is refused.
 */
export function VaultAccessCard({
  icon: Icon,
  title,
  description,
  shakeKey = 0,
  wide = false,
  children,
}: {
  icon: React.ForwardRefExoticComponent<IconProps>;
  title: string;
  description?: ReactNode;
  /** Bump to play the shake once, e.g. after a wrong password. */
  shakeKey?: number;
  /** Room for a recovery phrase's 24 words. */
  wide?: boolean;
  children: ReactNode;
}): React.JSX.Element {
  const reduceMotion = useReducedMotion();
  const controls = useAnimationControls();

  useEffect(() => {
    if (!shakeKey || reduceMotion) return;
    void controls.start({ x: [0, -8, 7, -5, 3, 0], transition: { duration: 0.36 } });
  }, [shakeKey, reduceMotion, controls]);

  return (
    <div className="flex min-h-full flex-1 items-center justify-center p-6">
      <motion.div
        animate={controls}
        className={cn(
          'glass w-full rounded-[calc(var(--radius)+2px)] px-8 pb-8 pt-9 transition-[max-width] duration-200',
          wide ? 'max-w-xl' : 'max-w-md',
        )}
      >
        <div className="mb-6 flex flex-col items-center text-center">
          {/* The glowing tile every empty state uses, with a faint keyhole ring around it. */}
          <div className="relative mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/12 text-primary shadow-[0_0_40px_-12px_hsl(var(--primary)/0.7)]">
            <span
              aria-hidden
              className="absolute -inset-2 rounded-[1.25rem] ring-1 ring-inset ring-primary/20"
            />
            <Icon className="relative h-6 w-6" />
          </div>
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          {description && (
            <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {children}
      </motion.div>
    </div>
  );
}
