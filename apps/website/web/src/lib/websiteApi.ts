/** What a read of the website API gives: the value, or why there is none. */
export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'not-found' | 'unavailable' };

export interface WebsiteApiOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * A JSON GET against the website API at `baseUrl`. A 404 is not found; no URL, a slow or failed
 * request, any other error status or a body `parse` rejects are all unavailable.
 */
export function apiGetter(baseUrl: string | undefined, options: WebsiteApiOptions = {}) {
  const { fetch: fetchFn = globalThis.fetch, timeoutMs = 3_000 } = options;

  return async function get<T>(
    path: string,
    parse: (value: unknown) => T | null,
  ): Promise<ApiResult<T>> {
    if (!baseUrl) return { ok: false, reason: 'unavailable' };
    try {
      const response = await fetchFn(`${baseUrl.replace(/\/+$/, '')}${path}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 404) return { ok: false, reason: 'not-found' };
      if (response.ok) {
        const value = parse(await response.json());
        if (value) return { ok: true, value };
      }
    } catch {
      // Down, slow or not JSON: the same as any other failure.
    }
    return { ok: false, reason: 'unavailable' };
  };
}
