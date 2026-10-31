import { describe, expect, it } from 'vitest';
import { HEALTH_ADD_PARAMS, healthAddHref, readHealthAddIntent } from './healthIntent';

/** The address Deploy builds to open Monitoring's add dialog for an app. */

function paramsOf(href: string): URLSearchParams {
  return new URLSearchParams(href.slice(href.indexOf('?') + 1));
}

describe('healthAddHref and readHealthAddIntent', () => {
  it('round-trips every field', () => {
    const href = healthAddHref({
      name: 'shop & co',
      url: 'https://shop.example.com/_runova/health?x=1',
      projectId: 'p1',
      environmentId: 'env-prod',
      serverLink: 'ssh:s1',
      appLink: { serverId: 's1', stackId: 'shop' },
      appName: 'shop',
      allowInsecure: true,
    });
    expect(href.startsWith('/monitoring?add=1&')).toBe(true);
    expect(readHealthAddIntent(paramsOf(href))).toEqual({
      name: 'shop & co',
      url: 'https://shop.example.com/_runova/health?x=1',
      projectId: 'p1',
      environmentId: 'env-prod',
      serverLink: 'ssh:s1',
      appLink: { serverId: 's1', stackId: 'shop' },
      appName: 'shop',
      allowInsecure: true,
    });
  });

  it('leaves out what was not given', () => {
    const href = healthAddHref({ name: 'shop' });
    expect(href).toBe('/monitoring?add=1&name=shop');
    expect(readHealthAddIntent(paramsOf(href))).toEqual({ name: 'shop' });
  });

  it('is not an intent without add=1', () => {
    expect(readHealthAddIntent(new URLSearchParams('name=shop'))).toBeNull();
    expect(readHealthAddIntent(new URLSearchParams('add=yes&name=shop'))).toBeNull();
  });

  it('drops a half app link, a bad server link and blank values', () => {
    expect(
      readHealthAddIntent(new URLSearchParams('add=1&appServer=s1&link=ftp:x&name=%20&insecure=0')),
    ).toEqual({});
  });

  it('names every param it writes, so the board can take them all back out', () => {
    const href = healthAddHref({
      name: 'a',
      url: 'https://a.example.com',
      projectId: 'p',
      environmentId: 'e',
      serverLink: 'ssh:s',
      appLink: { serverId: 's', stackId: 'a' },
      appName: 'a',
      allowInsecure: true,
    });
    const keys = [...paramsOf(href).keys()];
    expect(keys.every((key) => (HEALTH_ADD_PARAMS as readonly string[]).includes(key))).toBe(true);
  });
});
