import type {
  SecurityThreshold,
  DependencyAlertSettings as Settings,
} from '@shared/dependencyAlerts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId } from 'react';
import { toast } from 'sonner';
import { Bell, Package, Send, Shield } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useAccountStatus } from '@/hooks/useAccount';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';

const THRESHOLDS: { value: SecurityThreshold; label: string }[] = [
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High and above' },
  { value: 'moderate', label: 'Moderate and above' },
  { value: 'low', label: 'Any severity' },
  { value: 'off', label: 'Never' },
];

const KINDS: { key: 'deprecated' | 'major' | 'minor' | 'patch'; label: string }[] = [
  { key: 'deprecated', label: 'Deprecated packages' },
  { key: 'major', label: 'Major updates' },
  { key: 'minor', label: 'Minor updates' },
  { key: 'patch', label: 'Patch updates' },
];

function isThreshold(value: string): value is SecurityThreshold {
  return THRESHOLDS.some((t) => t.value === value);
}

function Row({
  icon: Icon,
  title,
  description,
  control,
  children,
}: {
  icon: typeof Bell;
  title: string;
  description: React.ReactNode;
  control?: React.ReactNode;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-[min(100%,16rem)] flex-1 items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 space-y-1">
            <h3 className="text-sm font-semibold leading-none">{title}</h3>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
        </div>
        {control ? <div className="flex shrink-0 items-center gap-2">{control}</div> : null}
      </div>
      {children ? <div className="mt-3 pl-12">{children}</div> : null}
    </div>
  );
}

/**
 * The Package updates card in Settings > Notifications (E51). Runova checks the packages of every
 * project once a day on runovahq.com and tells the account what it asked for: security issues
 * from a chosen severity, deprecations, and major, minor or patch releases, in the app and on
 * Telegram. The settings belong to the account, so the website shows the same ones.
 */
export function DependencyAlertSettings(): React.JSX.Element {
  const queryClient = useQueryClient();
  const idPrefix = useId();
  const account = useAccountStatus();
  const signedIn = account.data?.state === 'signed-in';
  const settingsQuery = useQuery({
    queryKey: queryKeys.dependencyAlertSettings,
    queryFn: () => window.runova.dependencyAlerts.settings(),
    enabled: signedIn,
  });
  const telegramQuery = useQuery({
    queryKey: queryKeys.telegramLink,
    queryFn: () => window.runova.dependencyAlerts.telegramLink(),
    enabled: signedIn,
  });
  const save = useMutation({
    mutationFn: (patch: Partial<Settings>) => window.runova.dependencyAlerts.updateSettings(patch),
    meta: { silentLoading: true },
    onSuccess: (saved) => queryClient.setQueryData(queryKeys.dependencyAlertSettings, saved),
    onError: () => toast.error('Could not save the package update settings.'),
  });
  const connect = useMutation({
    mutationFn: () => window.runova.dependencyAlerts.telegramConnect(),
    onError: () => toast.error('Could not open Telegram. Try again from runovahq.com.'),
  });
  const unlink = useMutation({
    mutationFn: () => window.runova.dependencyAlerts.telegramUnlink(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.telegramLink }),
    onError: () => toast.error('Could not unlink Telegram.'),
  });

  if (account.data && !signedIn) {
    return (
      <Row
        icon={Package}
        title="Package update alerts"
        description="Sign in to your Runova account to hear when a package in one of your projects has a new version, a security issue or a deprecation. The checks run on runovahq.com once a day."
      />
    );
  }

  // The controls wait for the saved values, so they never flash the defaults first.
  if (!settingsQuery.data) {
    return (
      <div className="space-y-3 px-5 py-4" aria-label="Loading package update settings">
        <Skeleton className="h-9 rounded-lg" />
        <Skeleton className="h-16 rounded-lg" />
      </div>
    );
  }

  // What was just picked shows until the saved value comes back.
  const settings: Settings = { ...settingsQuery.data, ...(save.isPending ? save.variables : {}) };
  const off = !settings.enabled;
  const telegram = telegramQuery.data;

  return (
    <>
      <Row
        icon={Package}
        title="Package update alerts"
        description="Once a day runovahq.com checks the packages of each project (npm, NuGet and pub) and tells you what changed. Team projects tell every member. Turning it off removes the package lists of your own projects from the server."
        control={
          <Switch
            checked={settings.enabled}
            onCheckedChange={(checked) => save.mutate({ enabled: checked })}
            aria-label="Package update alerts"
          />
        }
      >
        <p className="text-xs text-muted-foreground">
          Only package names and versions are sent, never your code or file paths.
        </p>
      </Row>
      <Row
        icon={Shield}
        title="Security issues at"
        description="An advisory on a version a project uses tells you when it is at this severity or above."
        control={
          <Combobox
            ariaLabel="Security issues at"
            className="w-48"
            value={settings.securityMinSeverity}
            disabled={off}
            onChange={(value) => {
              if (isThreshold(value)) save.mutate({ securityMinSeverity: value });
            }}
            searchable={false}
            options={THRESHOLDS}
          />
        }
      />
      <Row
        icon={Bell}
        title="Also tell me about"
        description="Each new release or deprecation is told once."
      >
        <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4">
          {KINDS.map(({ key, label }) => {
            const id = `${idPrefix}-${key}`;
            return (
              <label
                key={key}
                htmlFor={id}
                className={cn(
                  'flex items-center gap-2 text-sm',
                  off ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
                )}
              >
                <Checkbox
                  id={id}
                  checked={settings[key]}
                  disabled={off}
                  onCheckedChange={(on) => save.mutate({ [key]: on === true })}
                />
                {label}
              </label>
            );
          })}
        </div>
      </Row>
      <Row
        icon={Send}
        title="Telegram"
        description={
          telegram?.available === false
            ? 'Telegram is not available on this server yet.'
            : telegram?.linked
              ? `Alerts also go to ${telegram.chatName ?? 'your Telegram chat'}.`
              : 'Get the same alerts from the RunovaHQ bot in Telegram.'
        }
        control={
          telegram?.available === false ? null : telegram?.linked ? (
            <>
              <Switch
                checked={settings.telegram}
                disabled={off}
                onCheckedChange={(checked) => save.mutate({ telegram: checked })}
                aria-label="Send alerts to Telegram"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={unlink.isPending}
                onClick={() => unlink.mutate()}
              >
                Unlink Telegram
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                disabled={connect.isPending || !telegram}
                onClick={() => connect.mutate()}
              >
                Link Telegram
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void queryClient.invalidateQueries({ queryKey: queryKeys.telegramLink })
                }
              >
                Check again
              </Button>
            </>
          )
        }
      />
    </>
  );
}
