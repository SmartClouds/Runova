import { AlertTriangle, CheckCircle2, Info, Loader2 } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiRequest, type Problem, type StepUp } from '@/lib/account/api';
import { cn } from '@/lib/utils';
import { AppInput, PasswordInput } from './fields';

/** A glass card, as the app draws its sections. */
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cn('app-glass', className)}>{children}</section>;
}

/** A card's title row: the tinted icon tile, the title and a line about it, and actions. */
export function CardHeader({
  icon,
  title,
  description,
  actions,
  tone = 'primary',
}: {
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  tone?: 'primary' | 'destructive' | 'neutral';
}) {
  const tile = {
    primary: 'bg-primary/12 text-primary',
    destructive: 'bg-destructive/12 text-destructive',
    neutral: 'bg-foreground/[0.06] text-foreground/80',
  }[tone];
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 p-5">
      <div className="flex min-w-[min(100%,16rem)] flex-1 items-start gap-3">
        <div
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-inner [&_svg]:size-4',
            tile,
          )}
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1 pt-0.5">
          <h2 className="font-sans font-semibold text-[0.95rem] leading-tight tracking-normal">
            {title}
          </h2>
          {description && (
            <p className="mt-1 text-muted-foreground text-sm leading-relaxed">{description}</p>
          )}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** The hairline row list inside a card. */
export function Rows({ children }: { children: ReactNode }) {
  return (
    <ul className="divide-y divide-foreground/[0.07] border-foreground/[0.07] border-t">
      {children}
    </ul>
  );
}

/** A status chip. Never color alone: it always has its words, and an icon when it warns. */
export function Pill({
  tone = 'neutral',
  children,
}: {
  tone?: 'success' | 'warning' | 'danger' | 'neutral' | 'primary';
  children: ReactNode;
}) {
  const styles = {
    success: 'bg-success/12 text-success',
    warning: 'bg-warning/14 text-warning',
    danger: 'bg-destructive/12 text-destructive',
    neutral: 'bg-foreground/[0.07] text-muted-foreground',
    primary: 'bg-primary/12 text-primary',
  }[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium text-xs',
        styles,
      )}
    >
      {children}
    </span>
  );
}

/** A note inside a page: what happened and what to do, never only a mood. */
export function Notice({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: 'info' | 'success' | 'warning' | 'danger';
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'info' ? Info : AlertTriangle;
  const styles = {
    info: 'bg-severity-info/8 ring-severity-info/20 text-foreground',
    success: 'bg-success/8 ring-success/20 text-foreground',
    warning: 'bg-warning/8 ring-warning/25 text-foreground',
    danger: 'bg-destructive/8 ring-destructive/25 text-foreground',
  }[tone];
  const iconColor = {
    info: 'text-severity-info',
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-destructive',
  }[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('flex gap-3 rounded-inner p-3.5 text-sm ring-1 ring-inset', styles, className)}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', iconColor)} aria-hidden />
      <div className="min-w-0 space-y-1 leading-relaxed">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className="text-muted-foreground">{children}</div>}
      </div>
    </div>
  );
}

/** A shimmering placeholder while a card loads, the way the app shows loading. */
export function Shimmer({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-3 p-5" aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholders
          key={i}
          className="h-3.5 animate-pulse rounded-full bg-foreground/[0.07] motion-reduce:animate-none"
          style={{ width: `${88 - i * 17}%` }}
        />
      ))}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-muted-foreground text-sm">
      <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
      {label}
    </span>
  );
}

/** The page's own title, as the app's pages head themselves. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="font-display font-bold text-[1.75rem] tracking-tight md:text-[2rem]">
          {title}
        </h1>
        {description && <p className="mt-1.5 max-w-2xl text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

/** "3 minutes ago", "yesterday", "just now". */
export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  for (const [unit, size] of STEPS) {
    if (Math.abs(seconds) >= size) return RELATIVE.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

export function dateTime(iso: string): string {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );
}

export function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[unit]}`;
}

/** Loads a value from the API, with a reload, and the problem when it failed. */
export function useLoad<T>(path: string | null) {
  const [value, setValue] = useState<T | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    const response = await apiRequest<T>(path);
    setLoading(false);
    if (response.ok) {
      setValue(response.value);
      setProblem(null);
    } else {
      if (response.problem.status === 401) {
        window.location.assign(
          `/account/sign-in?next=${encodeURIComponent(window.location.pathname)}`,
        );
        return;
      }
      setProblem(response.problem);
    }
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { value, problem, loading, reload, setValue };
}

export function LoadFailure({ problem, retry }: { problem: Problem; retry: () => void }) {
  return (
    <div className="p-5">
      <Notice tone="danger" title="This did not load">
        <p>{problem.detail || problem.title}</p>
        <Button size="sm" variant="outline" className="mt-3" onClick={retry}>
          Try again
        </Button>
      </Notice>
    </div>
  );
}

/**
 * Asks for proof before a sensitive change: the password, or a two-factor code for an account
 * signed in with Google only. The caller sends it with the change; a wrong one comes back as a
 * field error the dialog shows.
 */
export function StepUpDialog({
  open,
  title,
  description,
  confirm,
  destructive,
  hasPassword,
  twoFactor,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  confirm: string;
  destructive?: boolean;
  hasPassword: boolean;
  twoFactor: boolean;
  onClose: () => void;
  /** Resolves to field errors, or null when it worked. */
  onConfirm: (stepUp: StepUp) => Promise<Record<string, string[]> | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setSecret('');
      setError(null);
      dialog.showModal();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  const usesCode = !hasPassword && twoFactor;
  const asks = hasPassword || twoFactor;
  const submit = async (event: { preventDefault(): void }) => {
    event.preventDefault();
    setBusy(true);
    const errors = await onConfirm({
      password: hasPassword ? secret : null,
      code: usesCode ? secret.replace(/\s/g, '') : null,
    });
    setBusy(false);
    if (errors) setError(Object.values(errors).flat()[0] ?? 'That did not work. Try again.');
  };
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="app-glass m-auto w-[min(28rem,calc(100vw-2rem))] p-0 text-foreground backdrop:bg-black/60 backdrop:backdrop-blur-sm"
    >
      <form onSubmit={submit} className="grid gap-4 p-6">
        <div>
          <h2 className="font-display font-semibold text-xl">{title}</h2>
          <div className="mt-1.5 text-muted-foreground text-sm leading-relaxed">{description}</div>
        </div>
        {asks ? (
          <div className="grid gap-2 text-sm">
            <label htmlFor="step-up-secret" className="font-medium">
              {usesCode ? 'Code from your authenticator app' : 'Your password'}
            </label>
            {usesCode ? (
              <AppInput
                id="step-up-secret"
                inputMode="numeric"
                autoComplete="one-time-code"
                className="font-mono tracking-[0.2em]"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                aria-invalid={error ? true : undefined}
                required
                autoFocus
              />
            ) : (
              <PasswordInput
                id="step-up-secret"
                autoComplete="current-password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                aria-invalid={error ? true : undefined}
                required
                autoFocus
              />
            )}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            You signed in with Google, so a sign-in in the last 10 minutes is the proof. If this
            fails, sign out and in again first.
          </p>
        )}
        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={busy}>
            {busy ? 'Working…' : confirm}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
