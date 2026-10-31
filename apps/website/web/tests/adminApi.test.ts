// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRequest, safeNextPath } from '../src/lib/admin/api';
import { errorsFor, errorsUnder, unplacedErrors } from '../src/lib/admin/problems';
import { fakeFetch, json, problem } from './helpers/fakeAdminFetch';

function setCookie(value: string) {
  document.cookie = value;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setCookie('XSRF-TOKEN=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/');
});

describe('apiRequest', () => {
  it('reads with a relative URL and no antiforgery header', async () => {
    const api = fakeFetch({ 'GET /api/v1/news/7': json({ id: 7 }, { headers: { etag: '"12"' } }) });

    const result = await apiRequest<{ id: number }>('/news/7');

    expect(result).toEqual({ ok: true, status: 200, value: { id: 7 }, etag: '"12"' });
    expect(api.fetch.mock.calls[0][0]).toBe('/api/v1/news/7');
    expect(api.seen[0].headers.has('x-xsrf-token')).toBe(false);
  });

  it('copies the XSRF-TOKEN cookie into the antiforgery header on every unsafe call', async () => {
    setCookie('XSRF-TOKEN=token-from-cookie; path=/');
    const api = fakeFetch({
      'POST /api/v1/news': json({ id: 1 }, { status: 201 }),
      'PUT /api/v1/news/1': json({ id: 1 }),
      'PATCH /api/v1/posts/1': json({ id: 1 }),
      'DELETE /api/v1/sessions/current': new Response(null, { status: 204 }),
    });

    await apiRequest('/news', { method: 'POST', body: { title: 'x' } });
    await apiRequest('/news/1', { method: 'PUT', body: {}, ifMatch: '"3"' });
    await apiRequest('/posts/1', { method: 'PATCH', body: {}, ifMatch: '"4"' });
    await apiRequest('/sessions/current', { method: 'DELETE' });

    for (const request of api.seen) {
      expect(request.headers.get('x-xsrf-token')).toBe('token-from-cookie');
    }
    expect(api.seen[0].headers.get('content-type')).toBe('application/json');
    expect(api.seen[1].headers.get('if-match')).toBe('"3"');
    expect(api.seen[2].headers.get('content-type')).toBe('application/merge-patch+json');
  });

  it('fetches a token first when there is no XSRF-TOKEN cookie yet', async () => {
    const api = fakeFetch({
      'GET /api/v1/csrf-tokens/current': json({ token: 'fresh' }),
      'POST /api/v1/sessions': new Response(null, { status: 204 }),
    });

    const result = await apiRequest('/sessions', { method: 'POST', body: { email: 'a' } });

    expect(result.ok).toBe(true);
    expect(api.seen.map((each) => each.path)).toEqual([
      '/api/v1/csrf-tokens/current',
      '/api/v1/sessions',
    ]);
    expect(api.seen[1].headers.get('x-xsrf-token')).toBe('fresh');
  });

  it('sends a FormData body as it is, so the browser sets the multipart boundary', async () => {
    setCookie('XSRF-TOKEN=t; path=/');
    const api = fakeFetch({ 'POST /api/v1/media': json({ id: 3 }, { status: 201 }) });
    const form = new FormData();
    form.set('alt', 'A cover');

    await apiRequest('/media', { method: 'POST', body: form });

    expect(api.seen[0].body).toBe(form);
    expect(api.seen[0].headers.has('content-type')).toBe(false);
  });

  it('turns problem details into a problem with its errors and extensions', async () => {
    fakeFetch({
      'PUT /api/v1/news/1': problem(412, 'precondition-failed', { currentVersion: '9' }),
      'POST /api/v1/news': problem(400, 'validation-failed', {
        errors: { title: ['A title is 5 to 160 characters.'] },
      }),
    });
    setCookie('XSRF-TOKEN=t; path=/');

    const stale = await apiRequest('/news/1', { method: 'PUT', body: {}, ifMatch: '"3"' });
    const invalid = await apiRequest('/news', { method: 'POST', body: {} });

    expect(stale).toMatchObject({
      ok: false,
      problem: { status: 412, type: 'precondition-failed', currentVersion: '9', errors: {} },
    });
    expect(invalid).toMatchObject({
      ok: false,
      problem: {
        status: 400,
        type: 'validation-failed',
        detail: 'One or more fields are not valid.',
        errors: { title: ['A title is 5 to 160 characters.'] },
      },
    });
  });

  it('reports a failed connection as a problem with status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    const result = await apiRequest('/news/1');

    expect(result).toMatchObject({ ok: false, problem: { status: 0, type: 'network' } });
  });
});

describe('problem errors', () => {
  const errors = {
    title: ['Too short.'],
    'technologies[0].versionRange': ['Not a range.'],
    'cveIds[1]': ['A CVE id looks like CVE-2026-41234.'],
    cveIds: ['At most 20.'],
    antiforgery: ['Send the header.'],
  };

  it('finds the messages of one field by its JSON path', () => {
    expect(errorsFor(errors, 'title')).toEqual(['Too short.']);
    expect(errorsFor(errors, 'technologies[0].versionRange')).toEqual(['Not a range.']);
    expect(errorsFor(errors, 'summary')).toEqual([]);
  });

  it('gathers a list field with the messages of its entries', () => {
    expect(errorsUnder(errors, 'cveIds')).toEqual([
      'At most 20.',
      'Entry 2: A CVE id looks like CVE-2026-41234.',
    ]);
  });

  it('lists the messages that no field on the form shows', () => {
    expect(unplacedErrors(errors, ['title', 'cveIds', 'technologies'])).toEqual([
      'Send the header.',
    ]);
  });
});

describe('safeNextPath', () => {
  it('keeps an admin path and refuses anything that could leave the admin area', () => {
    expect(safeNextPath('/admin/news/4?x=1')).toBe('/admin/news/4?x=1');
    expect(safeNextPath(null)).toBe('/admin');
    expect(safeNextPath('https://evil.example/admin')).toBe('/admin');
    expect(safeNextPath('//evil.example/admin')).toBe('/admin');
    expect(safeNextPath('/blog')).toBe('/admin');
    expect(safeNextPath('/admin/sign-in')).toBe('/admin');
    expect(safeNextPath('/admin\\..\\evil')).toBe('/admin');
  });
});
