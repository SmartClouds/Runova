import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { apiRequest, type Problem } from '@/lib/admin/api';
import {
  bucketDays,
  formatBytes,
  formatCount,
  type NamedCount,
  PERIOD_LABELS,
  PERIODS,
  type Period,
  percentOf,
  platformName,
  type Report,
  readPeriod,
  versionName,
} from '@/lib/admin/reports';
import { ErrorSummary } from './ErrorSummary';
import { Field } from './Field';
import { formatTime, type ListPage } from './useAdminList';

interface AuditEntry {
  id: number;
  at: string;
  actorKind: 'user' | 'api-client' | 'system';
  actorId: number | null;
  action: string;
  targetType: string;
  targetId: string;
}

const ACTIVITY_SIZE = 10;

const ACTION_LABELS: Record<string, string> = {
  'user.invite': 'Added a user',
  'user.update': 'Changed a user',
  'user.delete': 'Deleted a user',
  'user.password-reset': 'Reset a password',
  'user.two-factor-reset': 'Reset two-factor',
  'news.create': 'Wrote a news item',
  'news.update': 'Edited a news item',
  'news.archive': 'Archived a news item',
  'news.publish': 'Published a news item',
  'post.create': 'Wrote a post',
  'post.update': 'Edited a post',
  'post.archive': 'Archived a post',
  'post.publish': 'Published a post',
  'media.upload': 'Uploaded media',
  'media.delete': 'Deleted media',
  'api-client.create': 'Added an API client',
  'api-client.update': 'Changed an API client',
  'api-client.revoke': 'Revoked an API client',
  'api-client.rotate': 'Rotated an API client key',
};

/** `last 30 days`, for running text. */
const periodLabel = (days: number) =>
  (PERIOD_LABELS[days as Period] ?? `Last ${days} days`).toLowerCase();

export const actionLabel = (action: string) => ACTION_LABELS[action] ?? action;

export function actorLabel(entry: Pick<AuditEntry, 'actorKind' | 'actorId'>): string {
  if (entry.actorKind === 'system') return 'The site';
  const who = entry.actorKind === 'api-client' ? 'API client' : 'User';
  return entry.actorId === null ? who : `${who} ${entry.actorId}`;
}

/** Where an entry's target can be opened, when the admin has a page for it. */
function targetHref({ targetType, targetId }: AuditEntry): string | null {
  switch (targetType) {
    case 'user':
      return `/admin/users/${targetId}`;
    case 'news':
      return `/admin/news/${targetId}`;
    case 'post':
      return `/admin/blog/${targetId}`;
    case 'api-client':
      return `/admin/api-clients/${targetId}`;
    default:
      return null;
  }
}

/** One number with its name, and a line under it; a link when there is a list behind it. */
function Stat({
  label,
  value,
  note,
  href,
}: {
  label: string;
  value: string;
  note?: ReactNode;
  href?: string;
}) {
  return (
    <div className="grid content-start gap-1 rounded-box border p-4">
      <dt className="text-muted-foreground text-sm">
        {href ? (
          <a href={href} className="transition-colors duration-[120ms] hover:text-foreground">
            {label}
          </a>
        ) : (
          label
        )}
      </dt>
      <dd className="font-display font-extrabold text-3xl tabular-nums tracking-tight">{value}</dd>
      {note && <dd className="text-muted-foreground text-sm">{note}</dd>}
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="grid gap-4">
      <h2 id={id} className="font-display font-bold text-xl">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Sign-ups as one bar per day (or per run of days), with a readout for the bar under the pointer. */
function SignUpsChart({ report }: { report: Report }) {
  const bars = bucketDays(report.signUps);
  const perBar = Math.ceil(report.signUps.length / bars.length);
  const highest = Math.max(1, ...bars.map((bar) => bar.count));
  const total = report.signUps.reduce((sum, day) => sum + day.count, 0);
  const [hovered, setHovered] = useState<number | null>(null);
  const shown = hovered === null ? null : bars[hovered];

  return (
    <figure className="grid gap-3 rounded-box border p-4">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-semibold">
          Sign-ups {perBar === 1 ? 'per day' : `per ${perBar} days`}
        </span>
        <span className="text-muted-foreground text-sm tabular-nums" aria-live="polite">
          {shown
            ? `${shown.label}: ${formatCount(shown.count)}`
            : `${formatCount(total)} in the ${periodLabel(report.days)}`}
        </span>
      </figcaption>
      {/* The bars are drawn for sight; the table below says the same for everyone. */}
      <div
        aria-hidden="true"
        className="flex h-40 items-end gap-[2px] border-b"
        onPointerLeave={() => setHovered(null)}
      >
        {bars.map((bar, index) => (
          <div
            key={bar.label}
            data-testid="sign-up-bar"
            className="flex h-full min-w-0 flex-1 items-end"
            onPointerEnter={() => setHovered(index)}
          >
            <div
              className={`w-full rounded-t-inner transition-opacity duration-[120ms] ${
                bar.count === 0 ? 'bg-border' : 'bg-primary'
              } ${hovered !== null && hovered !== index ? 'opacity-60' : ''}`}
              style={{ height: bar.count === 0 ? '2px' : `${(bar.count / highest) * 100}%` }}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-muted-foreground text-xs" aria-hidden="true">
        <span>{bars[0]?.label}</span>
        <span>{bars[bars.length - 1]?.label}</span>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
          Show as a table
        </summary>
        <table className="mt-2 w-full max-w-sm text-left">
          <caption className="sr-only">Sign-ups</caption>
          <thead className="border-b text-muted-foreground">
            <tr>
              <th scope="col" className="py-1 pe-4 font-medium">
                {perBar === 1 ? 'Day' : 'Days'}
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                Sign-ups
              </th>
            </tr>
          </thead>
          <tbody>
            {bars.map((bar) => (
              <tr key={bar.label} className="border-b">
                <th scope="row" className="py-1 pe-4 font-normal">
                  {bar.label}
                </th>
                <td className="py-1 text-right tabular-nums">{formatCount(bar.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** A short ranked list with a bar for each share of the whole. */
function Breakdown({
  title,
  counts,
  name,
  empty,
}: {
  title: string;
  counts: NamedCount[];
  name: (raw: string) => string;
  empty: string;
}) {
  const highest = Math.max(1, ...counts.map((each) => each.count));
  return (
    <div className="grid content-start gap-3 rounded-box border p-4">
      <h3 className="font-semibold">{title}</h3>
      {counts.length === 0 ? (
        <p className="text-muted-foreground text-sm">{empty}</p>
      ) : (
        <ul className="grid gap-2 text-sm">
          {counts.map((each) => (
            <li key={each.name} className="grid gap-1">
              <div className="flex justify-between gap-4">
                <span>{name(each.name)}</span>
                <span className="tabular-nums">{formatCount(each.count)}</span>
              </div>
              <div className="h-2 rounded-full bg-border" aria-hidden="true">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${(each.count / highest) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** How many people use the site, what they do with it, and what is on it, for Admins. */
export default function ReportsView() {
  const [period, setPeriod] = useState<Period>(() => readPeriod(window.location.search));
  const [report, setReport] = useState<Report | null>(null);
  const [activity, setActivity] = useState<AuditEntry[] | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [loading, setLoading] = useState(true);
  const summary = useRef<HTMLDivElement>(null);

  const load = useCallback(async (days: Period) => {
    setLoading(true);
    const [next, entries] = await Promise.all([
      apiRequest<Report>(`/reports/current?days=${days}`),
      apiRequest<ListPage<AuditEntry>>(`/audit-entries?page=1&pageSize=${ACTIVITY_SIZE}`),
    ]);
    setLoading(false);
    if (!next.ok) {
      setProblem(next.problem);
      return;
    }
    setProblem(null);
    setReport(next.value);
    // The activity is a bonus: the report stands without it.
    setActivity(entries.ok ? entries.value.items : null);
  }, []);

  useEffect(() => {
    void load(period);
  }, [load, period]);

  useEffect(() => {
    if (problem) summary.current?.focus();
  }, [problem]);

  const choose = (next: Period) => {
    setPeriod(next);
    const search = next === 30 ? '' : `?days=${next}`;
    window.history.replaceState(null, '', `${window.location.pathname}${search}`);
  };

  const label = periodLabel(period);
  const users = report?.users;
  const staff = users ? users.admins + users.editors : 0;

  return (
    <div className="grid gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-1">
          <h1 className="font-display font-extrabold text-3xl tracking-tight">Reports</h1>
          {report && (
            <p className="text-muted-foreground text-sm">
              Counted {formatTime(report.generatedAt)}.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Field id="reports-period" label="Period" className="w-44">
            {(control) => (
              <NativeSelect
                {...control}
                value={period}
                onChange={(event) => choose(Number(event.target.value) as Period)}
              >
                {PERIODS.map((days) => (
                  <option key={days} value={days}>
                    {PERIOD_LABELS[days]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={() => void load(period)}
          >
            {loading && report ? 'Counting' : 'Refresh'}
          </Button>
        </div>
      </div>
      <ErrorSummary problem={problem} summaryRef={summary} />
      {!report && !problem && <p className="text-muted-foreground">Loading.</p>}
      {report && users && (
        <>
          <Section id="reports-users" title="Users">
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="All users" value={formatCount(users.total)} href="/admin/users" />
              <Stat
                label="Runova accounts"
                value={formatCount(users.accounts)}
                note="Signed up for the app"
                href="/admin/users?role=Account"
              />
              <Stat
                label="Staff"
                value={formatCount(staff)}
                note={`${formatCount(users.admins)} Admin, ${formatCount(users.editors)} Editor`}
              />
              <Stat label="Joined" value={formatCount(users.joined)} note={`In the ${label}`} />
              <Stat
                label="Active"
                value={formatCount(users.active)}
                note={`${percentOf(users.active, users.total)} of everyone, ${label}`}
              />
              <Stat
                label="Two-factor on"
                value={formatCount(users.twoFactor)}
                note={`${percentOf(users.twoFactor, users.total)} of everyone`}
              />
              <Stat label="Email not verified" value={formatCount(users.unconfirmed)} />
              <Stat
                label="Disabled"
                value={formatCount(users.disabled)}
                href="/admin/users?disabled=true"
              />
            </dl>
            <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
              <SignUpsChart report={report} />
              <div className="grid content-start gap-3 rounded-box border p-4">
                <h3 className="font-semibold">Newest users</h3>
                {report.newestUsers.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No one yet.</p>
                ) : (
                  <ul className="grid gap-3 text-sm">
                    {report.newestUsers.map((user) => (
                      <li key={user.id} className="grid">
                        <a
                          href={`/admin/users/${user.id}`}
                          className="font-medium transition-colors duration-[120ms] hover:text-primary"
                        >
                          {user.displayName}
                        </a>
                        <span className="break-all text-muted-foreground">{user.email}</span>
                        <span className="text-muted-foreground">
                          {user.staff ? 'Staff' : 'Runova account'}, joined{' '}
                          {formatTime(user.createdAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </Section>

          <Section id="reports-sessions" title="Sessions and computers">
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="Browser sessions"
                value={formatCount(report.sessions.web)}
                note={`Signed in and seen, ${label}`}
              />
              <Stat
                label="Desktop sessions"
                value={formatCount(report.sessions.desktop)}
                note={`Signed in and seen, ${label}`}
              />
            </dl>
            <div className="grid gap-4 sm:grid-cols-2">
              <Breakdown
                title="Desktop platforms"
                counts={report.sessions.platforms}
                name={platformName}
                empty="No desktop sessions in this period."
              />
              <Breakdown
                title="Desktop app versions"
                counts={report.sessions.appVersions}
                name={versionName}
                empty="No desktop sessions in this period."
              />
            </div>
          </Section>

          <Section id="reports-sync" title="Teams and sync">
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="Teams"
                value={formatCount(report.teams.total)}
                note={`${formatCount(report.teams.members)} members`}
              />
              <Stat
                label="Pending team invitations"
                value={formatCount(report.teams.pendingInvitations)}
              />
              <Stat
                label="Synced items"
                value={formatCount(report.sync.items)}
                note={`In ${formatCount(report.sync.scopes)} sync spaces`}
              />
              <Stat label="Synced data" value={formatBytes(report.sync.bytes)} />
            </dl>
          </Section>

          <Section id="reports-content" title="Content">
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="News"
                value={formatCount(report.content.newsPublished)}
                note={`Published; ${formatCount(report.content.newsScheduled)} scheduled, ${formatCount(report.content.newsDrafts)} drafts`}
                href="/admin/news"
              />
              <Stat
                label="Blog posts"
                value={formatCount(report.content.postsPublished)}
                note={`Published; ${formatCount(report.content.postsScheduled)} scheduled, ${formatCount(report.content.postsDrafts)} drafts`}
                href="/admin/blog"
              />
              <Stat label="Media files" value={formatCount(report.content.media)} />
              <Stat
                label="API clients"
                value={formatCount(report.apiClients.active)}
                note={`Active; ${formatCount(report.apiClients.inactive)} revoked or expired`}
                href="/admin/api-clients"
              />
              <Stat
                label="Latest release"
                value={report.latestRelease ?? 'None'}
                note="Of the desktop app"
              />
            </dl>
          </Section>

          {activity && (
            <Section id="reports-activity" title="Recent activity">
              {activity.length === 0 ? (
                <p className="text-muted-foreground text-sm">Nothing yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[36rem] text-left text-sm">
                    <caption className="sr-only">Recent activity</caption>
                    <thead className="border-b text-muted-foreground">
                      <tr>
                        <th scope="col" className="py-2 pe-4 font-medium">
                          When
                        </th>
                        <th scope="col" className="py-2 pe-4 font-medium">
                          Who
                        </th>
                        <th scope="col" className="py-2 font-medium">
                          What
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {activity.map((entry) => {
                        const href = targetHref(entry);
                        const what = `${actionLabel(entry.action)} (${entry.targetId})`;
                        return (
                          <tr key={entry.id} className="border-b">
                            <td className="py-2 pe-4 whitespace-nowrap">{formatTime(entry.at)}</td>
                            <td className="py-2 pe-4">
                              {entry.actorKind === 'user' && entry.actorId !== null ? (
                                <a
                                  href={`/admin/users/${entry.actorId}`}
                                  className="transition-colors duration-[120ms] hover:text-primary"
                                >
                                  {actorLabel(entry)}
                                </a>
                              ) : (
                                actorLabel(entry)
                              )}
                            </td>
                            <td className="py-2">
                              {href ? (
                                <a
                                  href={href}
                                  className="transition-colors duration-[120ms] hover:text-primary"
                                >
                                  {what}
                                </a>
                              ) : (
                                what
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>
          )}
        </>
      )}
    </div>
  );
}
