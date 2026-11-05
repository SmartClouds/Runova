import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountMiddleware, isAccountPath } from '../src/lib/account/guard';

const API = 'http://api.internal';
const ACCOUNT = { id: 42, email: 'sam@example.com', displayName: 'Sam', staff: false };

let meStatus = 200;

beforeEach(() => {
  meStatus = 200;
  process.env.WEBSITE_API_INTERNAL_URL = API;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      expect(input).toBe(`${API}/api/v1/accounts/me`);
      if (meStatus === 0) throw new TypeError('connect ECONNREFUSED');
      return meStatus === 200 ? Response.json(ACCOUNT) : new Response(null, { status: meStatus });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function context(path: string, cookie?: string) {
  const url = new URL(path, 'https://runovahq.com');
  return {
    url,
    request: new Request(url, { headers: cookie ? { cookie } : {} }),
    locals: {} as App.Locals,
  };
}

const page = () => Promise.resolve(new Response('<html>page</html>', { status: 200 }));
const SESSION = '__Host-runova-session=abc';

describe('isAccountPath', () => {
  it('matches /account and below, and nothing else', () => {
    expect(isAccountPath('/account')).toBe(true);
    expect(isAccountPath('/account/teams/4')).toBe(true);
    expect(isAccountPath('/accounts')).toBe(false);
    expect(isAccountPath('/admin')).toBe(false);
  });
});

describe('accountMiddleware', () => {
  it('leaves other pages alone', async () => {
    const response = await accountMiddleware(context('/news'), page);

    expect(response.headers.has('x-robots-tag')).toBe(false);
  });

  it('sends a signed-out visit to sign in, with the page to come back to', async () => {
    const response = await accountMiddleware(
      context('/account/authorize?client_id=runova-desktop'),
      page,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      `/account/sign-in?next=${encodeURIComponent('/account/authorize?client_id=runova-desktop')}`,
    );
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('shows the sign-in and register pages to anyone', async () => {
    for (const path of [
      '/account/sign-in',
      '/account/register',
      '/account/verify-email',
      '/account/forgot-password',
      '/account/reset-password',
    ]) {
      expect((await accountMiddleware(context(path), page)).status, path).toBe(200);
    }
  });

  it('renders a private page for a live session and hands the page the account', async () => {
    const ctx = context('/account/sessions', SESSION);

    const response = await accountMiddleware(ctx, page);

    expect(response.status).toBe(200);
    expect(ctx.locals.account).toEqual(ACCOUNT);
  });

  it('sends a signed-in visit to the sign-in page on to the account, or to where it was going', async () => {
    const plain = await accountMiddleware(context('/account/sign-in', SESSION), page);
    const onward = await accountMiddleware(
      context('/account/sign-in?next=%2Faccount%2Fteams', SESSION),
      page,
    );

    expect(plain.headers.get('location')).toBe('/account');
    expect(onward.headers.get('location')).toBe('/account/teams');
  });

  it('follows a next whose query holds a loopback address, as the desktop sign-in does', async () => {
    const next = '/account/authorize?redirect_uri=http://127.0.0.1:5000/callback&state=abcdefgh';

    const response = await accountMiddleware(
      context(`/account/sign-in?next=${encodeURIComponent(next)}`, SESSION),
      page,
    );

    expect(response.headers.get('location')).toBe(next);
  });

  it('never follows a next that leaves the site, in any spelling', async () => {
    for (const next of [
      '//evil.example/account',
      '/account\\..\\x',
      'https://evil.example/account',
    ]) {
      const response = await accountMiddleware(
        context(`/account/sign-in?next=${encodeURIComponent(next)}`, SESSION),
        page,
      );
      expect(response.headers.get('location'), next).toBe('/account');
    }
  });

  it('never follows a next that leaves the site', async () => {
    const response = await accountMiddleware(
      context('/account/sign-in?next=https%3A%2F%2Fevil.example', SESSION),
      page,
    );

    expect(response.headers.get('location')).toBe('/account');
  });

  it('treats an ended session as signed out', async () => {
    meStatus = 401;

    const response = await accountMiddleware(context('/account', SESSION), page);

    expect(response.headers.get('location')).toBe('/account/sign-in?next=%2Faccount');
  });

  it('answers 503 when the API is down rather than signing the person out', async () => {
    meStatus = 0;

    const response = await accountMiddleware(context('/account', SESSION), page);

    expect(response.status).toBe(503);
  });
});
