import { describe, expect, it, vi } from 'vitest';
import { AccountApiError, accountApiBaseUrl, createAccountClient, siteUrlFor } from './client';
import { type AccountStatePort, createAccountState } from './state';

const BASE = 'https://runova.test/api/v1';
const ACCOUNT = {
  id: 42,
  email: 'sam@example.com',
  displayName: 'Sam',
  emailConfirmed: true,
  hasPassword: true,
  twoFactorEnabled: false,
  logins: [],
  staff: false,
  createdAt: '2026-11-05T08:00:00.000Z',
  lastSignInAt: null,
  version: '1',
};

function memoryState() {
  let file: unknown = null;
  const port: AccountStatePort = {
    read: async () => file,
    write: async (value) => {
      file = JSON.parse(JSON.stringify(value));
    },
    canSeal: () => true,
    seal: (plain) => `s:${plain}`,
    open: (sealed) => {
      if (!sealed.startsWith('s:')) throw new Error('no');
      return sealed.slice(2);
    },
  };
  return createAccountState(port);
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function fakeFetch(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const tokens = (n: number) =>
  Response.json({
    accessToken: `access-${n}`,
    refreshToken: `refresh-${n}`,
    expiresIn: 900,
    sessionId: 9,
    account: ACCOUNT,
  });

describe('accountApiBaseUrl and siteUrlFor', () => {
  it('uses runovahq.com in a packaged app and an override only in development', () => {
    expect(
      accountApiBaseUrl({ isPackaged: true, env: { RUNOVA_ACCOUNT_API_URL: 'http://x' } }),
    ).toBe('https://runovahq.com/api/v1');
    expect(
      accountApiBaseUrl({
        isPackaged: false,
        env: { RUNOVA_ACCOUNT_API_URL: 'http://127.0.0.1:9/api/v1/' },
      }),
    ).toBe('http://127.0.0.1:9/api/v1');
  });

  it('finds the site from the API address', () => {
    expect(siteUrlFor('https://runovahq.com/api/v1')).toBe('https://runovahq.com');
  });
});

describe('createAccountClient', () => {
  it('signs in through the browser and keeps the tokens', async () => {
    const state = memoryState();
    const { fetch, calls } = fakeFetch((url) =>
      url.endsWith('/device-tokens') ? tokens(1) : new Response(null, { status: 404 }),
    );
    let opened = '';
    const client = createAccountClient({
      fetch,
      baseUrl: BASE,
      userAgent: 'Runova/9 (win32)',
      state,
      device: { name: 'Sam’s PC', platform: 'windows', appVersion: '9.0.0' },
      receiveCode: async (request) => {
        opened = request.buildUrl({
          redirectUri: 'http://127.0.0.1:5000/callback',
          state: 'st',
          challenge: 'ch',
        });
        return {
          code: 'the-code',
          redirectUri: 'http://127.0.0.1:5000/callback',
          verifier: 'the-verifier',
        };
      },
    });

    const account = await client.signIn();

    const authorize = new URL(opened);
    expect(authorize.origin + authorize.pathname).toBe('https://runova.test/account/authorize');
    expect(authorize.searchParams.get('client_id')).toBe('runova-desktop');
    expect(authorize.searchParams.get('code_challenge')).toBe('ch');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('device_name')).toBe('Sam’s PC');
    expect(authorize.searchParams.get('device_id')).toBe((await state.snapshot()).deviceId);
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body).toEqual({
      grantType: 'authorization_code',
      code: 'the-code',
      codeVerifier: 'the-verifier',
      redirectUri: 'http://127.0.0.1:5000/callback',
      refreshToken: null,
    });
    expect(account.email).toBe('sam@example.com');
    expect(await state.refreshToken()).toBe('refresh-1');
    expect((await state.snapshot()).sessionId).toBe(9);
  });

  it('sends the access token and no cookies', async () => {
    const state = memoryState();
    await state.signedIn({ account: ACCOUNT, sessionId: 9, refreshToken: 'refresh-0' });
    const { fetch, calls } = fakeFetch((url) =>
      url.endsWith('/device-tokens') ? tokens(1) : Response.json(ACCOUNT),
    );
    const client = createAccountClient({ fetch, baseUrl: BASE, userAgent: 'UA', state });

    await client.me();

    const me = calls.find((c) => c.url.endsWith('/accounts/me'));
    expect(new Headers(me?.init.headers).get('authorization')).toBe('Bearer access-1');
    expect(me?.init.credentials).toBe('omit');
  });

  it('refreshes once when the access token is refused, then retries', async () => {
    const state = memoryState();
    await state.signedIn({ account: ACCOUNT, sessionId: 9, refreshToken: 'refresh-0' });
    let n = 0;
    let meCalls = 0;
    const { fetch } = fakeFetch((url) => {
      if (url.endsWith('/device-tokens')) return tokens(++n);
      meCalls += 1;
      return meCalls === 1 ? new Response(null, { status: 401 }) : Response.json(ACCOUNT);
    });
    const client = createAccountClient({ fetch, baseUrl: BASE, userAgent: 'UA', state });

    await client.me();

    expect(n).toBe(2);
    expect(await state.refreshToken()).toBe('refresh-2');
  });

  it('asks for one refresh when many requests need it at once', async () => {
    const state = memoryState();
    await state.signedIn({ account: ACCOUNT, sessionId: 9, refreshToken: 'refresh-0' });
    let n = 0;
    const { fetch } = fakeFetch(async (url) => {
      if (url.endsWith('/device-tokens')) {
        await new Promise((r) => setTimeout(r, 10));
        return tokens(++n);
      }
      return Response.json(ACCOUNT);
    });
    const client = createAccountClient({ fetch, baseUrl: BASE, userAgent: 'UA', state });

    await Promise.all([client.me(), client.me(), client.me()]);

    expect(n).toBe(1);
  });

  it('marks the sign-in as needing attention when the refresh token is refused', async () => {
    const state = memoryState();
    await state.signedIn({ account: ACCOUNT, sessionId: 9, refreshToken: 'refresh-0' });
    const { fetch } = fakeFetch(() =>
      Response.json(
        {
          type: 'https://runovahq.com/problems/unauthorized',
          title: 'x',
          status: 401,
          detail: 'Sign in again.',
        },
        { status: 401, headers: { 'content-type': 'application/problem+json' } },
      ),
    );
    const onNeedsSignIn = vi.fn();
    const client = createAccountClient({
      fetch,
      baseUrl: BASE,
      userAgent: 'UA',
      state,
      onNeedsSignIn,
    });

    await expect(client.me()).rejects.toBeInstanceOf(AccountApiError);
    expect(onNeedsSignIn).toHaveBeenCalled();
    expect(client.needsSignIn()).toBe(true);
  });

  it('turns problem details into an error with the fields', async () => {
    const state = memoryState();
    await state.signedIn({ account: ACCOUNT, sessionId: 9, refreshToken: 'refresh-0' });
    const { fetch } = fakeFetch((url) =>
      url.endsWith('/device-tokens')
        ? tokens(1)
        : Response.json(
            {
              type: 'https://runovahq.com/problems/validation-failed',
              title: 'x',
              status: 400,
              detail: 'One or more fields are not valid.',
              errors: { password: ['Enter your password to confirm.'] },
            },
            { status: 400, headers: { 'content-type': 'application/problem+json' } },
          ),
    );
    const client = createAccountClient({ fetch, baseUrl: BASE, userAgent: 'UA', state });

    const error = await client.endOtherSessions({ password: 'x' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AccountApiError);
    expect((error as AccountApiError).problem).toMatchObject({
      status: 400,
      type: 'validation-failed',
      errors: { password: ['Enter your password to confirm.'] },
    });
  });

  it('signs out on the server and forgets everything here, even when offline', async () => {
    const state = memoryState();
    await state.signedIn({ account: ACCOUNT, sessionId: 9, refreshToken: 'refresh-0' });
    const { fetch } = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const client = createAccountClient({ fetch, baseUrl: BASE, userAgent: 'UA', state });

    await client.signOut();

    expect((await state.snapshot()).account).toBeNull();
    expect(await state.refreshToken()).toBeNull();
  });
});
