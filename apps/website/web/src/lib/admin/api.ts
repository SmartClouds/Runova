/**
 * The admin pages' calls to the website API. They run in the browser and go to `/api/v1` on the
 * same origin (the proxy sends that path to the API), so the session cookie rides along and no
 * CORS is involved. Every unsafe call carries the antiforgery header the API asks for.
 */

export const API_BASE = '/api/v1';

const XSRF_COOKIE = 'XSRF-TOKEN';
const XSRF_HEADER = 'X-XSRF-TOKEN';

/** An RFC 9457 problem from the API, or `network` when no answer came at all. */
export interface Problem {
  /** The HTTP status, or 0 when the request never got an answer. */
  status: number;
  /** The slug after `https://runovahq.com/problems/`, such as `validation-failed`. */
  type: string;
  title: string;
  detail: string;
  /** Messages by the JSON path of the request field; empty unless the type is validation-failed. */
  errors: Record<string, string[]>;
  /** On 412: the version the resource has now, bare (`14`), not yet an ETag (`"14"`). */
  currentVersion?: string;
  /** On 423: seconds until the account unlocks. */
  retryAfter?: number;
}

export type ApiResponse<T> =
  | { ok: true; status: number; value: T; etag: string | null }
  | { ok: false; problem: Problem };

export interface ApiRequestInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** JSON-encoded unless it is FormData, which goes as multipart. */
  body?: unknown;
  /** The ETag the change was made against. */
  ifMatch?: string;
}

const NETWORK_PROBLEM: Problem = {
  status: 0,
  type: 'network',
  title: 'No answer from the server.',
  detail: 'The server could not be reached. Check the connection and try again.',
  errors: {},
};

function readCookie(name: string): string | null {
  for (const part of document.cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/** The token from the readable cookie, or a new one from the API when the cookie is not set yet. */
async function antiforgeryToken(): Promise<string | null> {
  const cookie = readCookie(XSRF_COOKIE);
  if (cookie) return cookie;
  const response = await apiRequest<{ token: string }>('/csrf-tokens/current');
  return response.ok ? response.value.token : null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseErrors(value: unknown): Record<string, string[]> {
  if (!isObject(value)) return {};
  const errors: Record<string, string[]> = {};
  for (const [key, messages] of Object.entries(value)) {
    if (Array.isArray(messages)) {
      errors[key] = messages.filter((each): each is string => typeof each === 'string');
    }
  }
  return errors;
}

async function readProblem(response: Response): Promise<Problem> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // An empty or non-JSON error body still has a status worth showing.
  }
  const value = isObject(body) ? body : {};
  const type = typeof value.type === 'string' ? value.type.replace(/^.*\/problems\//, '') : '';
  return {
    status: response.status,
    type,
    title: typeof value.title === 'string' ? value.title : response.statusText,
    detail: typeof value.detail === 'string' ? value.detail : '',
    errors: parseErrors(value.errors),
    ...(typeof value.currentVersion === 'string' && { currentVersion: value.currentVersion }),
    ...(typeof value.retryAfter === 'number' && { retryAfter: value.retryAfter }),
  };
}

/** One call to `/api/v1<path>`. It never throws: a failure comes back as a problem. */
export async function apiRequest<T = unknown>(
  path: string,
  init: ApiRequestInit = {},
): Promise<ApiResponse<T>> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };

  if (method !== 'GET') {
    const token = await antiforgeryToken();
    if (token) headers[XSRF_HEADER] = token;
  }
  if (init.ifMatch) headers['If-Match'] = init.ifMatch;

  let body: BodyInit | undefined;
  if (init.body instanceof FormData) {
    body = init.body;
  } else if (init.body !== undefined) {
    headers['Content-Type'] =
      method === 'PATCH' ? 'application/merge-patch+json' : 'application/json';
    body = JSON.stringify(init.body);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body,
      credentials: 'same-origin',
    });
  } catch {
    return { ok: false, problem: NETWORK_PROBLEM };
  }

  if (!response.ok) return { ok: false, problem: await readProblem(response) };
  const text = await response.text();
  return {
    ok: true,
    status: response.status,
    value: (text ? JSON.parse(text) : null) as T,
    etag: response.headers.get('etag'),
  };
}

/**
 * Where to go after signing in: the `next` path when it is a page of the admin area, otherwise
 * `/admin`. A full URL, a protocol-relative one or a path outside `/admin` is never followed.
 */
export function safeNextPath(next: string | null): string {
  if (!next || !/^\/admin(?:[/?#]|$)/.test(next) || /[\\]|\/\//.test(next)) return '/admin';
  if (/^\/admin\/sign-in(?:[/?#]|$)/.test(next)) return '/admin';
  return next;
}
