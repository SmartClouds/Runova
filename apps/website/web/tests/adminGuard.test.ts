import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminMiddleware, isAdminPath } from '../src/lib/admin/guard';

const API = 'http://api.internal';
const EDITOR = {
  id: 7,
  email: 'editor@runovahq.com',
  displayName: 'Sam Editor',
  roles: ['Editor'],
};

let meStatus = 200;
let seenCookies: (string | null)[] = [];

beforeEach(() => {
  meStatus = 200;
  seenCookies = [];
  process.env.WEBSITE_API_INTERNAL_URL = API;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      expect(input).toBe(`${API}/api/v1/users/me`);
      seenCookies.push(new Headers(init.headers).get('cookie'));
      if (meStatus === 0) throw new TypeError('connect ECONNREFUSED');
      return meStatus === 200 ? Response.json(EDITOR) : new Response(null, { status: meStatus });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function context(path: string, cookie?: string) {
  const url = new URL(path, 'https://runovahq.com');
  return {
    url,
    request: new Request(url, { headers: cookie ? { cookie } : {} }),
    locals: {} as App.Locals,
  };
}

const page = () => Promise.resolve(new Response('<html>page</html>', { status: 200 }));

describe('isAdminPath', () => {
  it('matches /admin and everything under it, and nothing else', () => {
    expect(isAdminPath('/admin')).toBe(true);
    expect(isAdminPath('/admin/news/3')).toBe(true);
    expect(isAdminPath('/administrator')).toBe(false);
    expect(isAdminPath('/news')).toBe(false);
  });
});

describe('adminMiddleware', () => {
  it('leaves pages outside /admin alone', async () => {
    const response = await adminMiddleware(context('/news'), page);

    expect(response.status).toBe(200);
    expect(response.headers.has('x-robots-tag')).toBe(false);
    expect(seenCookies).toEqual([]);
  });

  it('sends a signed-out visit to the sign-in page with the page to come back to', async () => {
    const response = await adminMiddleware(context('/admin/news/4?tab=body'), page);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      `/admin/sign-in?next=${encodeURIComponent('/admin/news/4?tab=body')}`,
    );
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('asks the API who the session belongs to and redirects when it has ended', async () => {
    meStatus = 401;

    const response = await adminMiddleware(context('/admin', '__Host-runova-session=old'), page);

    expect(seenCookies).toEqual(['__Host-runova-session=old']);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/sign-in?next=%2Fadmin');
  });

  it('renders the page for a signed-in editor and hands it the user', async () => {
    const ctx = context('/admin/blog', '__Host-runova-session=abc; XSRF-TOKEN=t');

    const response = await adminMiddleware(ctx, page);

    expect(response.status).toBe(200);
    expect(ctx.locals.adminUser).toEqual(EDITOR);
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('shows the sign-in page to a signed-out visitor, with noindex', async () => {
    const response = await adminMiddleware(context('/admin/sign-in'), page);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('sends a signed-in visitor from the sign-in page to the admin home', async () => {
    const response = await adminMiddleware(
      context('/admin/sign-in', '__Host-runova-session=abc'),
      page,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin');
  });

  it('answers 503 with Retry-After when the API can not say who is signed in', async () => {
    meStatus = 0;

    const response = await adminMiddleware(context('/admin', '__Host-runova-session=abc'), page);

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('30');
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(await response.text()).toContain('could not reach');
  });
});
