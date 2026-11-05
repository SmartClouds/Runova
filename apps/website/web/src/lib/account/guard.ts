import { safeAccountPath } from './api';

/**
 * The gate in front of `/account/**`, the Runova account panel (E48). Every response is private
 * and kept out of search engines. The sign-in, sign-up and email-link pages render for anyone;
 * every other page renders only for a session the API recognises, and a signed-out visit goes to
 * sign in and comes back.
 */

export interface PanelAccount {
  id: number;
  email: string;
  displayName: string;
  staff: boolean;
}

export const ACCOUNT_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'private, no-store',
} as const;

export const SIGN_IN = '/account/sign-in';
const PUBLIC_PATHS = new Set([
  SIGN_IN,
  '/account/register',
  '/account/verify-email',
  '/account/forgot-password',
  '/account/reset-password',
]);
/** Pages a signed-in visit skips, straight on to the panel. */
const SIGNED_OUT_ONLY = new Set([SIGN_IN, '/account/register']);

export const isAccountPath = (pathname: string) => /^\/account(?:\/|$)/.test(pathname);

type Session =
  | { state: 'signed-in'; account: PanelAccount }
  | { state: 'signed-out' }
  | { state: 'unavailable' };

async function currentSession(cookie: string | null): Promise<Session> {
  if (!cookie?.includes('__Host-runova-session=')) return { state: 'signed-out' };
  const baseUrl = process.env.WEBSITE_API_INTERNAL_URL;
  if (!baseUrl) return { state: 'unavailable' };
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/v1/accounts/me`, {
      headers: { accept: 'application/json', cookie },
      signal: AbortSignal.timeout(3_000),
    });
    if (response.status === 401 || response.status === 403) return { state: 'signed-out' };
    if (!response.ok) return { state: 'unavailable' };
    const { id, email, displayName, staff } = await response.json();
    return { state: 'signed-in', account: { id, email, displayName, staff: staff === true } };
  } catch {
    return { state: 'unavailable' };
  }
}

function withHeaders(response: Response): Response {
  for (const [name, value] of Object.entries(ACCOUNT_HEADERS)) response.headers.set(name, value);
  return response;
}

const redirect = (location: string) =>
  new Response(null, { status: 302, headers: { Location: location } });

const unavailable = () =>
  new Response(
    '<!doctype html><html lang="en" class="dark"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><title>Account unavailable | Runova</title></head><body><main><h1>Your account is out of reach for a moment</h1><p>The site could not reach the server to check your sign-in. Try again in a minute.</p></main></body></html>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '30' } },
  );

interface AccountContext {
  url: URL;
  request: Request;
  locals: App.Locals;
}

export async function accountMiddleware(
  context: AccountContext,
  next: () => Promise<Response>,
): Promise<Response> {
  const { pathname, search } = context.url;
  if (!isAccountPath(pathname)) return next();

  const isPublic = PUBLIC_PATHS.has(pathname);
  const session = await currentSession(context.request.headers.get('cookie'));

  if (session.state === 'signed-in') {
    if (SIGNED_OUT_ONLY.has(pathname)) {
      return withHeaders(redirect(safeAccountPath(context.url.searchParams.get('next'))));
    }
    context.locals.account = session.account;
    return withHeaders(await next());
  }
  if (isPublic) return withHeaders(await next());
  if (session.state === 'unavailable') return withHeaders(unavailable());
  return withHeaders(redirect(`${SIGN_IN}?next=${encodeURIComponent(`${pathname}${search}`)}`));
}
