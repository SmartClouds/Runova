// Fixtures for the admin specs. Each worker gets an Editor of its own, with two-factor on, made
// through the real API by the owner account, and a browser that is signed in as that Editor. A
// spec for the Admin pages signs the browser in as the owner instead, with `adminSession`.
import {
  type APIRequestContext,
  type APIResponse,
  type BrowserContextOptions,
  test as base,
  request,
} from '@playwright/test';
import { ADMIN_BASE_URL, OWNER } from './stackConfig.ts';
import { type Authenticator, nextCode } from './totp.ts';

export { expect } from '@playwright/test';

export interface Editor extends Authenticator {
  email: string;
  password: string;
  displayName: string;
}

type StorageState = Exclude<BrowserContextOptions['storageState'], string | undefined>;

export const SIGNED_OUT: StorageState = { cookies: [], origins: [] };

export const newApiContext = () =>
  request.newContext({ baseURL: ADMIN_BASE_URL, ignoreHTTPSErrors: true });

async function antiforgeryToken(context: APIRequestContext): Promise<string> {
  const { cookies } = await context.storageState();
  const cookie = cookies.find((each) => each.name === 'XSRF-TOKEN');
  if (cookie) return decodeURIComponent(cookie.value);
  const response = await context.get('/api/v1/csrf-tokens/current');
  return (await response.json()).token;
}

/** An API call with the antiforgery header; anything but a 2xx fails the test. */
export async function apiCall(
  context: APIRequestContext,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  data?: unknown,
): Promise<APIResponse> {
  const response = await context.fetch(`/api/v1${path}`, {
    method,
    data,
    headers: { 'X-XSRF-TOKEN': await antiforgeryToken(context) },
  });
  if (!response.ok()) {
    throw new Error(`${method} ${path} answered ${response.status()}: ${await response.text()}`);
  }
  return response;
}

export const signIn = (
  context: APIRequestContext,
  email: string,
  password: string,
  twoFactorCode: string | null = null,
) => apiCall(context, 'POST', '/sessions', { email, password, twoFactorCode, recoveryCode: null });

let editorCount = 0;

/** A new Editor: invited by the owner, password set from the link, two-factor turned on. */
export async function createEditor(owner: APIRequestContext, workerIndex: number) {
  editorCount += 1;
  const tag = `${workerIndex}-${editorCount}-${Date.now()}`;
  const editor: Editor = {
    email: `editor-${tag}@e2e.runovahq.test`,
    password: `editor-password-${tag}`,
    displayName: `Editor ${workerIndex}.${editorCount}`,
    secret: '',
    lastStep: -1,
  };
  const invited = await apiCall(owner, 'POST', '/users', {
    email: editor.email,
    displayName: editor.displayName,
    roles: ['Editor'],
  });
  const token = new URL((await invited.json()).setupLink.url).hash.replace(/^#token=/, '');

  const context = await newApiContext();
  try {
    await apiCall(context, 'POST', '/password-setups', { token, password: editor.password });
    await signIn(context, editor.email, editor.password);
    const setup = await apiCall(context, 'POST', '/users/me/two-factor');
    editor.secret = (await setup.json()).sharedKey;
    await apiCall(context, 'PUT', '/users/me/two-factor', { code: await nextCode(editor) });
  } finally {
    await context.dispose();
  }
  return editor;
}

/** The cookies of a fresh session, signed in with the code when the account has two-factor on. */
async function sessionState(
  email: string,
  password: string,
  code: () => Promise<string | null>,
): Promise<StorageState> {
  const context = await newApiContext();
  try {
    await signIn(context, email, password, await code());
    return await context.storageState();
  } finally {
    await context.dispose();
  }
}

export const test = base.extend<
  Record<never, never>,
  {
    owner: APIRequestContext;
    editor: Editor;
    editorSession: StorageState;
    adminSession: StorageState;
  }
>({
  owner: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture names from this pattern.
    async ({}, use) => {
      const context = await newApiContext();
      await signIn(context, OWNER.email, OWNER.password);
      await use(context);
      await context.dispose();
    },
    { scope: 'worker' },
  ],
  editor: [
    async ({ owner }, use, workerInfo) => use(await createEditor(owner, workerInfo.workerIndex)),
    { scope: 'worker' },
  ],
  // One session per worker: every code works once, so a sign-in per test would wait on the clock.
  editorSession: [
    async ({ editor }, use) =>
      use(await sessionState(editor.email, editor.password, () => nextCode(editor))),
    { scope: 'worker' },
  ],
  adminSession: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture names from this pattern.
    async ({}, use) => use(await sessionState(OWNER.email, OWNER.password, async () => null)),
    { scope: 'worker' },
  ],
  // Pages start signed in as the worker's Editor unless a spec asks for SIGNED_OUT.
  storageState: async ({ editorSession }, use) => use(editorSession),
});

/** A title no other test or run uses, so a spec can find its own item on the public pages. */
export const uniqueTitle = (prefix: string) =>
  `${prefix} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
