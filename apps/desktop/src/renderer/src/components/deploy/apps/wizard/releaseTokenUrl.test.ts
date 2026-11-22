import { describe, expect, it } from 'vitest';
import { NEW_TOKEN_URL, newReleaseTokenUrl } from './releaseTokenUrl';

function params(url: string): URLSearchParams {
  expect(url.startsWith(`${NEW_TOKEN_URL}?`)).toBe(true);
  return new URL(url).searchParams;
}

describe('newReleaseTokenUrl', () => {
  it('fills in a read-only token for the repository owner', () => {
    const query = params(newReleaseTokenUrl('acme/shop'));
    expect(query.get('name')).toBe('Runova releases acme/shop');
    expect(query.get('target_name')).toBe('acme');
    expect(query.get('contents')).toBe('read');
    expect(query.get('description')).toMatch(/acme\/shop/);
  });

  it('asks for nothing but Contents', () => {
    const keys = [...params(newReleaseTokenUrl('acme/shop')).keys()].sort();
    expect(keys).toEqual(['contents', 'description', 'name', 'target_name']);
  });

  it('keeps the name within the 40 characters GitHub allows', () => {
    const repository = `some-long-organization/${'x'.repeat(60)}`;
    const name = params(newReleaseTokenUrl(repository)).get('name') ?? '';
    expect(name.length).toBeLessThanOrEqual(40);
    expect(name.startsWith('Runova releases some-long-org')).toBe(true);
  });

  it('encodes dots and dashes so the owner and name survive the round trip', () => {
    const query = params(newReleaseTokenUrl('my-org/web.app_2'));
    expect(query.get('target_name')).toBe('my-org');
    expect(query.get('name')).toBe('Runova releases my-org/web.app_2');
  });
});
