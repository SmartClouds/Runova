import { Bell, ExternalLink, Package, Send, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiRequest, type Problem } from '@/lib/account/api';
import { cn } from '@/lib/utils';
import { AppCheckbox, AppSelect } from './fields';
import {
  Card,
  CardHeader,
  EmptyState,
  LoadFailure,
  Notice,
  PageHeader,
  Pill,
  Rows,
  relativeTime,
  Shimmer,
  useLoad,
} from './ui';

interface AlertSettings {
  enabled: boolean;
  securityMinSeverity: 'critical' | 'high' | 'moderate' | 'low' | 'off';
  deprecated: boolean;
  major: boolean;
  minor: boolean;
  patch: boolean;
  inApp: boolean;
  telegram: boolean;
}

interface TelegramLink {
  available: boolean;
  linked: boolean;
  botUsername: string | null;
  chatName: string | null;
  linkedAt: string | null;
}

interface UserNotification {
  id: number;
  kind: string;
  title: string;
  body: string;
  severity: string | null;
  createdAt: string;
  readAt: string | null;
}

interface NotificationPage {
  items: UserNotification[];
  unread: number;
}

const SETTINGS = '/accounts/me/dependency-alert-settings';
const TELEGRAM = '/accounts/me/telegram-links/current';
const MESSAGES = '/notifications?pageSize=20';

const THRESHOLDS: { value: AlertSettings['securityMinSeverity']; label: string }[] = [
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

/**
 * Package update alerts (E51): what the account hears about, the Telegram chat it goes to, and
 * the messages so far. The same settings show in the desktop app, so each change is saved with the
 * version it was read at, and a change made elsewhere in between asks for a reload.
 */
export default function Notifications() {
  return (
    <>
      <PageHeader
        title="Notifications"
        description="Runova checks the packages of your projects once a day and tells you about security issues, deprecations and new releases."
      />
      <div className="space-y-5">
        <SettingsCard />
        <TelegramCard />
        <MessagesCard />
      </div>
    </>
  );
}

function SettingsCard() {
  const { value, problem, reload, setValue } = useLoadWithEtag<AlertSettings>(SETTINGS);
  const [saveProblem, setSaveProblem] = useState<Problem | null>(null);
  const ids = useId();

  // Saves run one after another, each with the version the one before it got back, so two
  // quick changes never send the same If-Match and lose one of them.
  const latest = useRef(value);
  latest.current = value;
  const queue = useRef<Promise<void>>(Promise.resolve());
  // Changes made but not saved yet, shown on top of what the server last sent.
  const unsaved = useRef<Partial<AlertSettings>[]>([]);

  function save(patch: Partial<AlertSettings>) {
    if (!value) return;
    setSaveProblem(null);
    // The box shows the new value at once and goes back if the server refuses it.
    unsaved.current.push(patch);
    setValue({ data: { ...value.data, ...patch }, etag: value.etag });
    queue.current = queue.current.then(async () => {
      const current = latest.current;
      if (!current) return;
      const response = await apiRequest<AlertSettings>(SETTINGS, {
        method: 'PATCH',
        body: patch,
        ...(current.etag ? { ifMatch: current.etag } : {}),
      });
      unsaved.current.shift();
      if (response.ok) {
        const saved = { data: response.value, etag: response.etag ?? current.etag };
        latest.current = saved;
        setValue({ ...saved, data: Object.assign({}, saved.data, ...unsaved.current) });
      } else {
        await reload();
        setSaveProblem(response.problem);
      }
    });
  }

  const settings = value?.data;
  const off = !settings?.enabled;
  return (
    <Card>
      <CardHeader
        icon={<Package />}
        title="Package update alerts"
        description="Only package names and versions from the desktop app reach the server, never your code or file paths. A team project tells every member, each by their own choices here."
      />
      {problem ? (
        <LoadFailure problem={problem} retry={reload} />
      ) : !settings ? (
        <Shimmer lines={3} />
      ) : (
        <div className="space-y-5 border-foreground/[0.07] border-t p-4 sm:p-5">
          {saveProblem && (
            <Notice tone="danger" title="That was not saved">
              <p>{saveProblem.detail || saveProblem.title}</p>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => void reload()}>
                Load again
              </Button>
            </Notice>
          )}
          <label htmlFor={`${ids}-enabled`} className="flex cursor-pointer items-start gap-3">
            <AppCheckbox
              id={`${ids}-enabled`}
              className="mt-0.5"
              checked={settings.enabled}
              onChange={(event) => save({ enabled: event.target.checked })}
              aria-label="Package update alerts"
            />
            <span className="text-sm">
              <span className="font-medium">Check my projects every day</span>
              <span className="block text-muted-foreground">
                Turning this off removes the package lists of your own projects from the server.
              </span>
            </span>
          </label>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label htmlFor="security-threshold" className={cn('text-sm', off && 'opacity-60')}>
              <ShieldAlert className="mr-1.5 inline size-4 text-destructive" aria-hidden />
              Security issues at
            </label>
            <AppSelect
              id="security-threshold"
              size="sm"
              value={settings.securityMinSeverity}
              disabled={off}
              onChange={(event) =>
                save({
                  securityMinSeverity: event.target.value as AlertSettings['securityMinSeverity'],
                })
              }
            >
              {THRESHOLDS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </AppSelect>
          </div>
          <fieldset className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4" disabled={off}>
            <legend className="mb-2 text-muted-foreground text-sm">Also tell me about</legend>
            {KINDS.map(({ key, label }) => (
              <label
                key={key}
                htmlFor={`${ids}-${key}`}
                className={cn(
                  'flex items-center gap-2 text-sm',
                  off ? 'opacity-60' : 'cursor-pointer',
                )}
              >
                <AppCheckbox
                  id={`${ids}-${key}`}
                  checked={settings[key]}
                  disabled={off}
                  onChange={(event) => save({ [key]: event.target.checked })}
                />
                {label}
              </label>
            ))}
          </fieldset>
        </div>
      )}
    </Card>
  );
}

function TelegramCard() {
  const { value, problem, reload } = useLoad<TelegramLink>(TELEGRAM);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [actionProblem, setActionProblem] = useState<Problem | null>(null);

  async function makeLink() {
    setActionProblem(null);
    const response = await apiRequest<{ url: string; expiresAt: string }>(
      '/accounts/me/telegram-link-codes',
      {
        method: 'POST',
      },
    );
    if (response.ok) setLink(response.value);
    else setActionProblem(response.problem);
  }

  async function unlink() {
    setActionProblem(null);
    const response = await apiRequest<void>(TELEGRAM, { method: 'DELETE' });
    if (!response.ok) setActionProblem(response.problem);
    setLink(null);
    await reload();
  }

  const actions = !value ? null : !value.available ? null : value.linked ? (
    <Button size="sm" variant="outline" onClick={() => void unlink()}>
      Unlink
    </Button>
  ) : (
    <>
      <Button size="sm" onClick={() => void makeLink()}>
        Link Telegram
      </Button>
      {link && (
        <Button size="sm" variant="ghost" onClick={() => void reload()}>
          I pressed Start
        </Button>
      )}
    </>
  );

  return (
    <Card>
      <CardHeader
        icon={<Send />}
        title="Telegram"
        description={
          !value
            ? 'Get the same alerts from the RunovaHQ bot.'
            : !value.available
              ? 'Telegram is not available on this site yet.'
              : value.linked
                ? `Alerts also go to ${value.chatName ?? 'your Telegram chat'}${value.linkedAt ? `, linked ${relativeTime(value.linkedAt)}` : ''}.`
                : 'Get the same alerts from the RunovaHQ bot. Link it once, then send /stop in the chat any time to stop.'
        }
        actions={actions}
      />
      {problem && <LoadFailure problem={problem} retry={reload} />}
      {(link || actionProblem) && (
        <div className="space-y-3 border-foreground/[0.07] border-t p-4 sm:p-5">
          {actionProblem && (
            <Notice tone="danger" title="That did not work">
              <p>{actionProblem.detail || actionProblem.title}</p>
            </Notice>
          )}
          {link && (
            <p className="text-sm">
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="link inline-flex items-center gap-1 font-medium"
              >
                Open Telegram and press Start <ExternalLink className="size-3.5" aria-hidden />
              </a>
              <span className="block text-muted-foreground text-xs">
                The link works once, for 15 minutes.
              </span>
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

function MessagesCard() {
  const { value, problem, reload } = useLoad<NotificationPage>(MESSAGES);

  async function markAll() {
    await apiRequest('/notification-read-markers', { method: 'POST', body: { before: null } });
    await reload();
  }

  return (
    <Card>
      <CardHeader
        icon={<Bell />}
        title="Messages"
        description="What the daily checks found, newest first. The desktop app shows the same ones."
        actions={
          value && value.unread > 0 ? (
            <Button size="sm" variant="outline" onClick={() => void markAll()}>
              Mark all as read
            </Button>
          ) : null
        }
      />
      {problem ? (
        <LoadFailure problem={problem} retry={reload} />
      ) : !value ? (
        <Shimmer lines={3} />
      ) : value.items.length === 0 ? (
        <EmptyState icon={<Bell />} title="No messages yet">
          Sign in to the desktop app and open your projects. The first check runs within the hour.
        </EmptyState>
      ) : (
        <Rows>
          {value.items.map((item) => (
            <li key={item.id} className="flex gap-3 px-4 py-3.5 sm:px-5">
              <span
                aria-hidden
                className={cn(
                  'mt-1.5 size-2 shrink-0 rounded-full',
                  item.readAt ? 'bg-transparent' : 'bg-primary',
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium text-sm">{item.title}</p>
                  {item.severity && (
                    <Pill
                      tone={
                        item.severity === 'critical' || item.severity === 'high'
                          ? 'danger'
                          : 'warning'
                      }
                    >
                      <ShieldAlert className="size-3" aria-hidden />
                      {item.severity}
                    </Pill>
                  )}
                  {!item.readAt && <span className="sr-only">Unread</span>}
                </div>
                <p className="mt-1 whitespace-pre-line text-muted-foreground text-sm leading-relaxed">
                  {item.body}
                </p>
                <p className="mt-1 text-muted-foreground text-xs">{relativeTime(item.createdAt)}</p>
              </div>
            </li>
          ))}
        </Rows>
      )}
    </Card>
  );
}

/** Like useLoad, keeping the ETag a write has to send back. */
function useLoadWithEtag<T>(path: string) {
  const [value, setValue] = useState<{ data: T; etag: string | null } | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const reload = useCallback(async () => {
    const response = await apiRequest<T>(path);
    if (response.ok) {
      setValue({ data: response.value, etag: response.etag });
      setProblem(null);
    } else if (response.problem.status === 401) {
      window.location.assign(
        `/account/sign-in?next=${encodeURIComponent(window.location.pathname)}`,
      );
    } else {
      setProblem(response.problem);
    }
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { value, problem, reload, setValue };
}
