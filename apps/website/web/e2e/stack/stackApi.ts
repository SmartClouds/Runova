// Calls to the API through the stack's proxy, shared by the stack specs and the seed script: the
// owner's session, new API clients, and requests those clients sign.
import { type APIRequestContext, request } from '@playwright/test';
import { signRequest } from '../../../../../docs/website/examples/sign-request.ts';
import { OWNER, STACK_URL } from './stackConfig.ts';

export interface Key {
  keyId: string;
  secret: string;
}

/** A request context on the stack's origin, which trusts Caddy's local certificate. */
export const newContext = () => request.newContext({ baseURL: STACK_URL, ignoreHTTPSErrors: true });

/** A random suffix, so every run's items are its own on a stack that keeps its database. */
export const unique = () =>
  `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/** An API call with the antiforgery header; anything but a 2xx throws. */
export async function call(context: APIRequestContext, path: string, data: unknown) {
  const token = (await (await context.get('/api/v1/csrf-tokens/current')).json()).token;
  const response = await context.post(`/api/v1${path}`, {
    data,
    headers: { 'X-XSRF-TOKEN': token },
  });
  if (!response.ok()) {
    throw new Error(`POST ${path} answered ${response.status()}: ${await response.text()}`);
  }
  return response;
}

/** A session as the owner, signed in through the proxy with its Secure cookies. */
export async function ownerSession() {
  const context = await newContext();
  await call(context, '/sessions', {
    email: OWNER.email,
    password: OWNER.password,
    twoFactorCode: null,
    recoveryCode: null,
  });
  return context;
}

/** A new API client with these scopes, made by the owner. */
export async function apiClient(scopes: string[]): Promise<Key> {
  const owner = await ownerSession();
  try {
    const created = await call(owner, '/api-clients', {
      name: `Stack client ${unique()}`,
      scopes,
      ipAllowlist: [],
      expiresAt: null,
    });
    const { keyId, secret } = await created.json();
    return { keyId, secret };
  } finally {
    await owner.dispose();
  }
}

/** A POST signed with `key`. The response comes back whatever its status. */
export function signedPost(
  context: APIRequestContext,
  key: Key,
  path: string,
  body: string | Buffer,
  contentType = 'application/json',
) {
  const url = `/api/v1${path}`;
  return context.post(url, {
    headers: { ...signRequest({ ...key, method: 'POST', url, body }), 'Content-Type': contentType },
    data: body,
  });
}
