/**
 * The gate in front of `/admin/**`. Every admin response is private and kept out of search
 * engines, and a page other than sign-in and set-password renders only for a staff session the
 * API recognises. The pages for API clients and users render only for an Admin.
 */

/** A `UserDto` reduced to what the admin pages show. */
export interface AdminUser {
  id: number;
  email: string;
  displayName: string;
  roles: string[];
}

export const ADMIN_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'private, no-store',
} as const;

export const SIGN_IN_PATH = '/admin/sign-in';
export const SET_PASSWORD_PATH = '/admin/set-password';
/** The page an Editor sees, with 403, on a page for Admins only. */
export const FORBIDDEN_PATH = '/admin/forbidden';

/** Admin pages that render without a session. */
const PUBLIC_PATHS = [SIGN_IN_PATH, SET_PASSWORD_PATH];

export const isAdminOnlyPath = (pathname: string) =>
  /^\/admin\/(?:api-clients|users)(?:\/|$)/.test(pathname);

export const isAdmin = (user: AdminUser | undefined) => user?.roles.includes('Admin') === true;

const RETRY_AFTER_SECONDS = 30;

export const isAdminPath = (pathname: string) => /^\/admin(?:\/|$)/.test(pathname);

type Session =
  | { state: 'signed-in'; user: AdminUser }
  | { state: 'signed-out' }
  | { state: 'unavailable' };

/** Asks the API whose session the visitor's cookies hold, without ever throwing. */
async function currentSession(cookie: string | null): Promise<Session> {
  if (!cookie?.includes('__Host-runova-session=')) return { state: 'signed-out' };
  const baseUrl = process.env.WEBSITE_API_INTERNAL_URL;
  if (!baseUrl) return { state: 'unavailable' };
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/v1/users/me`, {
      headers: { accept: 'application/json', cookie },
      signal: AbortSignal.timeout(3_000),
    });
    if (response.status === 401 || response.status === 403) return { state: 'signed-out' };
    if (!response.ok) return { state: 'unavailable' };
    const { id, email, displayName, roles } = await response.json();
    return { state: 'signed-in', user: { id, email, displayName, roles } };
  } catch {
    return { state: 'unavailable' };
  }
}

function withAdminHeaders(response: Response): Response {
  for (const [name, value] of Object.entries(ADMIN_HEADERS)) response.headers.set(name, value);
  return response;
}

const redirect = (location: string) =>
  new Response(null, { status: 302, headers: { Location: location } });

const unavailable = () =>
  new Response(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><title>Admin unavailable | Runova</title></head><body><main><h1>The admin area is unavailable</h1><p>The site could not reach the API to check your session. Try again in a minute.</p></main></body></html>',
    {
      status: 503,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Retry-After': String(RETRY_AFTER_SECONDS),
      },
    },
  );

interface AdminContext {
  url: URL;
  request: Request;
  locals: App.Locals;
}

/**
 * The middleware for admin paths; anything else goes straight to `next`. `next` takes the path
 * to render instead, as Astro's rewrite does.
 */
export async function adminMiddleware(
  context: AdminContext,
  next: (rewrite?: string) => Promise<Response>,
): Promise<Response> {
  const { pathname, search } = context.url;
  if (!isAdminPath(pathname)) return next();

  const session = await currentSession(context.request.headers.get('cookie'));
  const isPublic = PUBLIC_PATHS.includes(pathname);

  if (session.state === 'signed-in') {
    if (pathname === SIGN_IN_PATH) return withAdminHeaders(redirect('/admin'));
    context.locals.adminUser = session.user;
    if (isAdminOnlyPath(pathname) && !isAdmin(session.user)) {
      const page = await next(FORBIDDEN_PATH);
      return withAdminHeaders(
        new Response(page.body, { status: 403, headers: new Headers(page.headers) }),
      );
    }
    return withAdminHeaders(await next());
  }
  if (isPublic) return withAdminHeaders(await next());
  if (session.state === 'unavailable') return withAdminHeaders(unavailable());
  const back = encodeURIComponent(`${pathname}${search}`);
  return withAdminHeaders(redirect(`${SIGN_IN_PATH}?next=${back}`));
}
