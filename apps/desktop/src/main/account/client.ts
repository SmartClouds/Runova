import type {
  AccountActivityPage,
  AccountApiProblem,
  AccountProfile,
  AccountSession,
  StepUp,
} from '../../shared/accountTypes';
import type { LoopbackCode, LoopbackCodeRequest } from '../oauth/loopback';
import type { AccountState } from './state';

/**
 * The desktop's side of a Runova account (E48): signing in through the browser and the website
 * API's account routes. The person signs in on runovahq.com, never in the app, and approves this
 * computer; the app trades the one-time code (PKCE) for a short access token and a refresh token
 * that rotates on every use. The access token lives in memory; the refresh token is sealed in
 * account.json (state.ts). Requests carry no cookies.
 */

export const DEFAULT_ACCOUNT_API_URL = 'https://runovahq.com/api/v1';
export const DESKTOP_CLIENT_ID = 'runova-desktop';
const TIMEOUT_MS = 20_000;
/** Refresh a little before the server would refuse the token. */
const EXPIRY_MARGIN_MS = 60_000;

/** Only a development build may point the app at another server, for e2e tests and local work. */
export function accountApiBaseUrl(input: {
  isPackaged: boolean;
  env: Record<string, string | undefined>;
}): string {
  if (input.isPackaged) return DEFAULT_ACCOUNT_API_URL;
  const override = input.env.RUNOVA_ACCOUNT_API_URL?.trim();
  if (!override || !/^https?:\/\//i.test(override)) return DEFAULT_ACCOUNT_API_URL;
  return override.replace(/\/+$/, '');
}

/** The site the API belongs to, where the sign-in page is. */
export function siteUrlFor(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

export class AccountApiError extends Error {
  constructor(readonly problem: AccountApiProblem) {
    super(problem.detail);
    this.name = 'AccountApiError';
  }
}

export interface DeviceInfo {
  name: string;
  platform: 'windows' | 'macos' | 'linux';
  appVersion: string;
}

export interface AccountClientDeps {
  fetch: typeof globalThis.fetch;
  baseUrl: string;
  userAgent: string;
  state: AccountState;
  device?: DeviceInfo;
  receiveCode?: (request: LoopbackCodeRequest) => Promise<LoopbackCode>;
  onNeedsSignIn?: () => void;
  onSignedIn?: () => void;
  now?: () => number;
}

interface DeviceTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: number;
  account: AccountProfile;
}

const PROBLEM_BASE = 'https://runovahq.com/problems/';

async function problemFrom(response: Response): Promise<AccountApiProblem> {
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // The status says enough.
  }
  const type = typeof body.type === 'string' ? body.type.replace(PROBLEM_BASE, '') : 'unknown';
  const detail =
    typeof body.detail === 'string' && body.detail
      ? body.detail
      : response.status === 401
        ? 'Sign in to your Runova account again.'
        : `The Runova server answered ${response.status}.`;
  const errors =
    body.errors && typeof body.errors === 'object'
      ? (body.errors as Record<string, string[]>)
      : undefined;
  return { status: response.status, type, detail, ...(errors ? { errors } : {}) };
}

export function createAccountClient(deps: AccountClientDeps) {
  const now = deps.now ?? (() => Date.now());
  let access: { token: string; expiresAt: number } | null = null;
  let refreshing: Promise<string> | null = null;
  let needsSignIn = false;

  async function send(path: string, init: RequestInit & { token?: string }): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    headers.set('user-agent', deps.userAgent);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    if (init.token) headers.set('authorization', `Bearer ${init.token}`);
    return deps.fetch(`${deps.baseUrl}${path}`, {
      ...init,
      headers,
      credentials: 'omit',
      signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  async function takeTokens(tokens: DeviceTokens): Promise<void> {
    access = { token: tokens.accessToken, expiresAt: now() + tokens.expiresIn * 1000 };
    needsSignIn = false;
  }

  /** One refresh at a time; everyone waiting shares its result. */
  function refresh(): Promise<string> {
    refreshing ??= (async () => {
      try {
        const refreshToken = await deps.state.refreshToken();
        if (!refreshToken) throw signInAgain();
        const response = await send('/device-tokens', {
          method: 'POST',
          body: JSON.stringify({
            grantType: 'refresh_token',
            code: null,
            codeVerifier: null,
            redirectUri: null,
            refreshToken,
          }),
        });
        if (!response.ok) {
          const problem = await problemFrom(response);
          if (response.status === 401 || response.status === 400) {
            needsSignIn = true;
            access = null;
            deps.onNeedsSignIn?.();
          }
          throw new AccountApiError(problem);
        }
        const tokens = (await response.json()) as DeviceTokens;
        await deps.state.rotated(tokens.refreshToken);
        await takeTokens(tokens);
        return tokens.accessToken;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  function signInAgain(): AccountApiError {
    needsSignIn = true;
    deps.onNeedsSignIn?.();
    return new AccountApiError({
      status: 401,
      type: 'unauthorized',
      detail: 'Sign in to your Runova account again.',
    });
  }

  async function accessToken(): Promise<string> {
    if (access && access.expiresAt - EXPIRY_MARGIN_MS > now()) return access.token;
    return refresh();
  }

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init = (token: string): RequestInit & { token: string } => ({
      method,
      token,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let response = await send(path, init(await accessToken()));
    if (response.status === 401) {
      access = null;
      response = await send(path, init(await refresh()));
    }
    if (!response.ok) throw new AccountApiError(await problemFrom(response));
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  return {
    needsSignIn: () => needsSignIn,

    /** Opens the browser at the sign-in page and waits for the person to approve this computer. */
    async signIn(options: { signal?: AbortSignal } = {}): Promise<AccountProfile> {
      if (!deps.receiveCode || !deps.device) throw new Error('Signing in is not set up here.');
      const { deviceId } = await deps.state.snapshot();
      const device = deps.device;
      const site = siteUrlFor(deps.baseUrl);
      const received = await deps.receiveCode({
        label: 'Runova',
        buildUrl: ({ redirectUri, state, challenge }) => {
          const params = new URLSearchParams({
            client_id: DESKTOP_CLIENT_ID,
            redirect_uri: redirectUri,
            response_type: 'code',
            code_challenge: challenge,
            code_challenge_method: 'S256',
            state,
            device_name: device.name,
            platform: device.platform,
            app_version: device.appVersion,
            device_id: deviceId,
          });
          return `${site}/account/authorize?${params.toString()}`;
        },
      });
      const response = await send('/device-tokens', {
        method: 'POST',
        body: JSON.stringify({
          grantType: 'authorization_code',
          code: received.code,
          codeVerifier: received.verifier,
          redirectUri: received.redirectUri,
          refreshToken: null,
        }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (!response.ok) throw new AccountApiError(await problemFrom(response));
      const tokens = (await response.json()) as DeviceTokens;
      await deps.state.signedIn({
        account: {
          id: tokens.account.id,
          email: tokens.account.email,
          displayName: tokens.account.displayName,
        },
        sessionId: tokens.sessionId,
        refreshToken: tokens.refreshToken,
      });
      await takeTokens(tokens);
      deps.onSignedIn?.();
      return tokens.account;
    },

    /** Ends this computer's session on the server when it can, and always forgets it here. */
    async signOut(): Promise<void> {
      try {
        if (access || (await deps.state.refreshToken())) {
          await request<void>('DELETE', '/sessions/current');
        }
      } catch {
        // Offline or already ended: forgetting it here is what matters.
      } finally {
        access = null;
        needsSignIn = false;
        await deps.state.signedOut();
      }
    },

    async me(): Promise<AccountProfile> {
      const account = await request<AccountProfile>('GET', '/accounts/me');
      await deps.state.updateAccount({
        id: account.id,
        email: account.email,
        displayName: account.displayName,
      });
      return account;
    },

    async sessions(): Promise<AccountSession[]> {
      return (await request<{ items: AccountSession[] }>('GET', '/sessions')).items;
    },

    endSession: (id: number) =>
      request<void>('DELETE', `/sessions/${encodeURIComponent(String(id))}`),

    endOtherSessions: (stepUp: StepUp) =>
      request<void>('DELETE', '/sessions', {
        password: stepUp.password ?? null,
        code: stepUp.code ?? null,
      }),

    activities: (page = 1, pageSize = 50) =>
      request<AccountActivityPage>('GET', `/activities?page=${page}&pageSize=${pageSize}`),

    /** Any other account route, for the sync and teams clients built on this one. */
    request,
  };
}

export type AccountClient = ReturnType<typeof createAccountClient>;
