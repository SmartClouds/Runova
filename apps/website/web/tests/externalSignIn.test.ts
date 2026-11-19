import { describe, expect, it } from 'vitest';
import { finishUrl } from '../src/lib/account/externalSignIn';

describe('finishUrl', () => {
  it('hands the return path on to the API, which finishes the sign-in', () => {
    expect(finishUrl('?returnUrl=%2Faccount%2Fsecurity')).toBe(
      '/api/v1/external-sign-ins/current?returnUrl=%2Faccount%2Fsecurity',
    );
  });

  it('keeps a return path with a query of its own, as the apps authorize page has', () => {
    const back = '/account/authorize?client_id=runova-mobile&state=s';

    expect(finishUrl(`?returnUrl=${encodeURIComponent(back)}`)).toBe(
      `/api/v1/external-sign-ins/current?returnUrl=${encodeURIComponent(back)}`,
    );
  });

  it('drops anything else in the query', () => {
    expect(finishUrl('?returnUrl=%2Faccount&evil=1')).toBe(
      '/api/v1/external-sign-ins/current?returnUrl=%2Faccount',
    );
  });

  it('falls back to the account page without a return path', () => {
    expect(finishUrl('')).toBe('/api/v1/external-sign-ins/current?returnUrl=%2Faccount');
  });
});
