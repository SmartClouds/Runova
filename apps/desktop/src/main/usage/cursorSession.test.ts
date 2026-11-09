import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PartialUsageError } from './shared';

/**
 * Cursor usage read through the signed-in Cursor app. What matters here is where the plan's
 * limits come from, and that a failure never takes what was read along with it: a usage-based plan
 * reports them on the usage summary, an older plan only as a request quota, and a failing event
 * feed keeps the limits that came back. The network is faked per path; the account read is stubbed
 * so no real Cursor install is touched.
 */

const account = vi.hoisted(() => ({
  current: {
    accessToken: 'session-token' as string | null,
    userId: 'auth0|user_test' as string | null,
    email: 'dev@example.com',
    plan: { id: 'pro-plus', label: 'Pro+' } as { id: string; label: string } | null,
    signedOut: false,
    tokenExpired: false,
    missing: false,
  },
}));
vi.mock('./cursorAccount', () => ({ getCursorAccount: () => account.current }));

const { fetchCursorSessionUsage } = await import('./cursorSession');

const CYCLE_END = '2026-10-22T11:34:38.000Z';

const PRO_PLUS_SUMMARY = {
  billingCycleStart: '2026-09-22T11:34:38.000Z',
  billingCycleEnd: CYCLE_END,
  isUnlimited: false,
  individualUsage: {
    plan: {
      enabled: true,
      used: 7000,
      limit: 7000,
      autoPercentUsed: 66.685,
      apiPercentUsed: 100,
      totalPercentUsed: 67.4663951120163,
    },
    onDemand: { enabled: false, used: 0, limit: null },
  },
};

const NO_EVENTS = { usageEventsDisplay: [], totalUsageEventsCount: 0 };

/** A request-based plan's quota answer, with no cap: what a usage-based plan returns from it. */
const NO_QUOTA = { 'gpt-4': { numRequests: 0, maxRequestUsage: null }, startOfMonth: null };

type Answer = unknown | ((init: RequestInit | undefined) => unknown);

/** Answers keyed by path; an `Error` rejects the request, a number is an HTTP status. */
function fakeCursor(answers: Record<string, Answer>) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const answer = answers[url.pathname];
    if (answer === undefined) return new Response('not found', { status: 404 });
    const value = typeof answer === 'function' ? answer(init) : answer;
    if (value instanceof Error) throw value;
    if (typeof value === 'number') return new Response('', { status: value });
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    asked: (path: string) =>
      fetchMock.mock.calls.some(([u]) => new URL(String(u)).pathname === path),
  };
}

/** The error a read rejects with, or undefined when it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

beforeEach(() => {
  account.current = {
    accessToken: 'session-token',
    userId: 'auth0|user_test',
    email: 'dev@example.com',
    plan: { id: 'pro-plus', label: 'Pro+' },
    signedOut: false,
    tokenExpired: false,
    missing: false,
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a session Cursor does not accept', () => {
  it('reads the login redirect as a rejected session, without following it', async () => {
    const { fetchMock } = fakeCursor({
      '/api/dashboard/get-filtered-usage-events': 307,
      '/api/usage-summary': 401,
      '/api/usage': 401,
    });

    const error = await rejectionOf(fetchCursorSessionUsage());

    expect((error as Error).message).toBe(
      'Cursor session rejected. Sign in to the Cursor app again.',
    );
    for (const [, init] of fetchMock.mock.calls) expect(init?.redirect).toBe('manual');
  });
});

describe('fetchCursorSessionUsage', () => {
  it("takes a usage-based plan's limits from the usage summary", async () => {
    const cursor = fakeCursor({
      '/api/dashboard/get-filtered-usage-events': NO_EVENTS,
      '/api/usage-summary': PRO_PLUS_SUMMARY,
    });

    const usage = await fetchCursorSessionUsage();

    expect(usage.status).toBe('ok');
    expect(usage.subscription).toEqual({
      mode: 'subscription',
      plan: { id: 'pro-plus', label: 'Pro+' },
      windows: [
        { key: 'month', label: 'Monthly usage', percent: 67.4663951120163, resetAt: CYCLE_END },
        { key: 'month-auto', label: 'Auto', percent: 66.685, resetAt: CYCLE_END },
        { key: 'month-api', label: 'API', percent: 100, resetAt: CYCLE_END },
      ],
      source: 'account',
    });
    expect(usage.window).toMatchObject({ label: 'Plan usage', percent: 67.4663951120163 });
    expect(usage.limitsError).toBeUndefined();
    // The summary already answered, so the old request counter is not asked at all.
    expect(cursor.asked('/api/usage')).toBe(false);
  });

  it('signs the summary request with the Cursor session, as the dashboard does', async () => {
    const cursor = fakeCursor({
      '/api/dashboard/get-filtered-usage-events': NO_EVENTS,
      '/api/usage-summary': PRO_PLUS_SUMMARY,
    });

    await fetchCursorSessionUsage();

    const call = cursor.fetchMock.mock.calls.find(
      ([u]) => new URL(String(u)).pathname === '/api/usage-summary',
    );
    const headers = call?.[1]?.headers as Record<string, string>;
    expect(call?.[1]?.method).toBe('GET');
    expect(headers.Cookie).toBe(
      `WorkosCursorSessionToken=${encodeURIComponent('auth0|user_test::session-token')}`,
    );
  });

  it('falls back to the request quota of a plan the summary has no limits for', async () => {
    const cursor = fakeCursor({
      '/api/dashboard/get-filtered-usage-events': NO_EVENTS,
      '/api/usage-summary': 500,
      '/api/usage': {
        'gpt-4': { numRequests: 125, maxRequestUsage: 500, numTokens: 0 },
        startOfMonth: '2026-09-22T11:34:38.000Z',
      },
    });

    const usage = await fetchCursorSessionUsage();

    expect(cursor.asked('/api/usage')).toBe(true);
    // The quota rolls over a month after the period start Cursor reported.
    expect(usage.subscription?.windows).toEqual([
      { key: 'month', label: 'Monthly requests', percent: 25, resetAt: CYCLE_END },
    ]);
    expect(usage.window).toMatchObject({ label: 'Requests', used: 125, total: 500 });
    expect(usage.limitsError).toBeUndefined();
  });

  it('keeps the plan badge but shows no limit on an unlimited plan', async () => {
    fakeCursor({
      '/api/dashboard/get-filtered-usage-events': NO_EVENTS,
      '/api/usage-summary': { ...PRO_PLUS_SUMMARY, isUnlimited: true },
      '/api/usage': { 'gpt-4': { numRequests: 0, maxRequestUsage: null }, startOfMonth: null },
    });

    const usage = await fetchCursorSessionUsage();

    expect(usage.subscription?.plan).toEqual({ id: 'pro-plus', label: 'Pro+' });
    expect(usage.subscription?.windows).toEqual([]);
    expect(usage.window).toBeUndefined();
    // An unlimited plan has no limits, which is not the same as the limits being unknown.
    expect(usage.limitsError).toBeUndefined();
  });

  it('still loads the card when both limit endpoints fail, and says the limits are unknown', async () => {
    const cursor = fakeCursor({
      '/api/dashboard/get-filtered-usage-events': NO_EVENTS,
      '/api/usage-summary': new Error('handshake timed out'),
      '/api/usage': new Error('handshake timed out'),
    });

    const usage = await fetchCursorSessionUsage();

    expect(usage.status).toBe('ok');
    expect(usage.subscription).toBeUndefined();
    expect(usage.limitsError).toBe('Could not reach Cursor.');
    // A network failure is not worth a second wait on the quota endpoint.
    expect(cursor.asked('/api/usage')).toBe(false);
  });

  it('says the limits are unknown when the summary fails and the quota has no cap to show', async () => {
    const cursor = fakeCursor({
      '/api/dashboard/get-filtered-usage-events': NO_EVENTS,
      '/api/usage-summary': 500,
      // Zeros with no cap say nothing about a usage-based plan's limits, so they are not taken as none.
      '/api/usage': NO_QUOTA,
    });

    const usage = await fetchCursorSessionUsage();

    expect(cursor.asked('/api/usage')).toBe(true);
    expect(usage.status).toBe('ok');
    expect(usage.subscription).toBeUndefined();
    expect(usage.limitsError).toBe('Cursor returned HTTP 500');
  });

  it('reads a summary with no recognisable limits as a plan with none', async () => {
    fakeCursor({
      '/api/dashboard/get-filtered-usage-events': NO_EVENTS,
      '/api/usage-summary': { somethingElse: true },
      '/api/usage': NO_QUOTA,
    });

    const usage = await fetchCursorSessionUsage();

    expect(usage.limitsError).toBeUndefined();
    expect(usage.subscription).toEqual({
      mode: 'subscription',
      plan: { id: 'pro-plus', label: 'Pro+' },
      windows: [],
      source: 'account',
    });
  });

  it('keeps the limits when the plan name is missing from the account', async () => {
    account.current = { ...account.current, plan: null };
    fakeCursor({
      '/api/dashboard/get-filtered-usage-events': NO_EVENTS,
      '/api/usage-summary': PRO_PLUS_SUMMARY,
    });

    const usage = await fetchCursorSessionUsage();

    expect(usage.subscription?.plan).toBeNull();
    expect(usage.subscription?.windows.map((w) => w.key)).toEqual([
      'month',
      'month-auto',
      'month-api',
    ]);
    expect(usage.window).toMatchObject({ label: 'Plan usage' });
  });

  it('keeps the limits that came back when the event feed fails', async () => {
    fakeCursor({
      '/api/dashboard/get-filtered-usage-events': 500,
      '/api/usage-summary': PRO_PLUS_SUMMARY,
    });

    const error = await rejectionOf(fetchCursorSessionUsage());

    expect(error).toBeInstanceOf(PartialUsageError);
    const partial = error as PartialUsageError;
    expect(partial.message).toBe('Cursor returned HTTP 500');
    expect(partial.salvage.subscription?.windows).toHaveLength(3);
    expect(partial.salvage.window).toMatchObject({
      label: 'Plan usage',
      percent: 67.4663951120163,
    });
  });

  it('keeps an unlimited plan as having no limits when the event feed fails', async () => {
    fakeCursor({
      '/api/dashboard/get-filtered-usage-events': 500,
      '/api/usage-summary': { ...PRO_PLUS_SUMMARY, isUnlimited: true },
      '/api/usage': NO_QUOTA,
    });

    const error = await rejectionOf(fetchCursorSessionUsage());

    expect(error).toBeInstanceOf(PartialUsageError);
    expect((error as PartialUsageError).salvage.subscription).toEqual({
      mode: 'subscription',
      plan: { id: 'pro-plus', label: 'Pro+' },
      windows: [],
      source: 'account',
    });
  });

  it('fails as a plain error when the feed and the limits both cannot be read', async () => {
    fakeCursor({
      '/api/dashboard/get-filtered-usage-events': 401,
      '/api/usage-summary': new Error('handshake timed out'),
    });

    const error = await rejectionOf(fetchCursorSessionUsage());

    expect(error).not.toBeInstanceOf(PartialUsageError);
    expect((error as Error).message).toBe(
      'Cursor session rejected. Sign in to the Cursor app again.',
    );
  });

  it('gives up on a feed that never answers as a timeout, and keeps the limits', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (new URL(String(input)).pathname === '/api/usage-summary') {
          return new Response(JSON.stringify(PRO_PLUS_SUMMARY), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        // The feed never answers. Only the request's own abort ends it, as on a dead connection.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        });
      }),
    );

    const pending = rejectionOf(fetchCursorSessionUsage());
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await pending;

    expect(error).toBeInstanceOf(PartialUsageError);
    expect((error as PartialUsageError).message).toBe('Cursor did not answer in time.');
    expect((error as PartialUsageError).salvage.subscription?.windows).toHaveLength(3);
  });

  it('asks to sign in, without calling Cursor, when nobody is signed in', async () => {
    account.current = { ...account.current, accessToken: null, signedOut: true };
    const cursor = fakeCursor({});

    const usage = await fetchCursorSessionUsage();

    expect(usage.status).toBe('connect');
    expect(cursor.fetchMock).not.toHaveBeenCalled();
  });
});
