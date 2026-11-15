import { describe, expect, it } from 'vitest';
import type { CloudflareRuleSpec } from '../cloudflareTypes';
import {
  ipLockDescription,
  ipLockPreview,
  ipLockTarget,
  MAX_IP_LOCK_ADDRESSES,
  parseAddresses,
} from './ipLock';
import { buildRule, describeRule, parseIpLock } from './rules';

/**
 * An IP limit: only the listed addresses can open a name, a path on it, or every name in the zone.
 * It is a WAF custom rule that blocks everyone else, written so the app can read it back and
 * change it later. Certificate checks from Let's Encrypt still get through.
 */

type IpLock = Extract<CloudflareRuleSpec, { kind: 'ip-lock' }>;

function lock(change: Partial<IpLock> = {}): IpLock {
  return {
    kind: 'ip-lock',
    hostname: 'app.example.com',
    path: null,
    match: 'prefix',
    ips: ['203.0.113.10'],
    ...change,
  };
}

const ACME = 'not starts_with(http.request.uri.path, "/.well-known/acme-challenge/")';

describe('buildRule for an IP limit', () => {
  it('blocks everyone but the listed addresses on a whole name, leaving certificate checks open', () => {
    expect(buildRule(lock({ ips: ['203.0.113.10', '2001:DB8::/32', '203.0.113.10'] }))).toEqual({
      ok: true,
      rule: {
        expression: `(http.host eq "app.example.com" and ${ACME} and not ip.src in {203.0.113.10 2001:db8::/32})`,
        action: 'block',
        first: false,
      },
    });
  });

  it('limits one path, or a path and everything under it', () => {
    expect(buildRule(lock({ path: '/admin', match: 'prefix' }))).toMatchObject({
      ok: true,
      rule: {
        expression:
          '(http.host eq "app.example.com" and starts_with(http.request.uri.path, "/admin") and not ip.src in {203.0.113.10})',
      },
    });
    expect(buildRule(lock({ path: '/login', match: 'exact' }))).toMatchObject({
      ok: true,
      rule: {
        expression:
          '(http.host eq "app.example.com" and http.request.uri.path eq "/login" and not ip.src in {203.0.113.10})',
      },
    });
  });

  it('keeps certificate checks open when a prefix covers them', () => {
    expect(buildRule(lock({ path: '/', match: 'prefix' }))).toMatchObject({
      ok: true,
      rule: {
        expression: `(http.host eq "app.example.com" and starts_with(http.request.uri.path, "/") and ${ACME} and not ip.src in {203.0.113.10})`,
      },
    });
  });

  it('covers every name in the zone when no name is picked', () => {
    expect(buildRule(lock({ hostname: null }))).toMatchObject({
      ok: true,
      rule: { expression: `(${ACME} and not ip.src in {203.0.113.10})` },
    });
    expect(buildRule(lock({ hostname: null, path: '/wp-admin' }))).toMatchObject({
      ok: true,
      rule: {
        expression:
          '(starts_with(http.request.uri.path, "/wp-admin") and not ip.src in {203.0.113.10})',
      },
    });
  });

  it('refuses a name, path or address that could change the expression', () => {
    for (const hostname of [
      'app.example.com" or true or "',
      '*.example.com',
      'app.example.com/x',
      '',
    ]) {
      expect(buildRule(lock({ hostname })), hostname).toMatchObject({ ok: false });
    }
    expect(buildRule(lock({ hostname: 'App.Example.com' }))).toMatchObject({
      ok: true,
      rule: { expression: expect.stringContaining('http.host eq "app.example.com"') },
    });
    for (const path of ['admin', '/a"b', '/a b', '']) {
      expect(buildRule(lock({ path })), path).toMatchObject({ ok: false });
    }
    expect(buildRule(lock({ ips: [] }))).toEqual({
      ok: false,
      problem: 'Add at least one IP address or range.',
    });
    expect(buildRule(lock({ ips: ['203.0.113.10}'] }))).toMatchObject({ ok: false });
    expect(
      buildRule(
        lock({ ips: Array.from({ length: MAX_IP_LOCK_ADDRESSES + 1 }, (_, i) => `10.0.${i}.1`) }),
      ),
    ).toMatchObject({ ok: false });
  });

  it('suggests a description from the name and path', () => {
    expect(describeRule(lock({ path: '/admin' }))).toBe('Only listed IPs, app.example.com/admin*');
    expect(describeRule(lock({ hostname: null }))).toBe('Only listed IPs, every name');
  });
});

describe('parseIpLock', () => {
  it('reads back every IP limit the app writes', () => {
    const specs = [
      lock(),
      lock({ path: '/admin', match: 'prefix' }),
      lock({ path: '/login', match: 'exact' }),
      lock({ path: '/', match: 'prefix' }),
      lock({ hostname: null }),
      lock({ hostname: null, path: '/wp-admin', match: 'exact' }),
      lock({ ips: ['203.0.113.0/24', '2001:db8::1'] }),
    ];
    for (const spec of specs) {
      const built = buildRule(spec);
      if (!built.ok) throw new Error(built.problem);
      expect(parseIpLock({ expression: built.rule.expression, action: 'block' })).toEqual(spec);
    }
  });

  it('says a whole name has a prefix match, whatever was asked for', () => {
    const built = buildRule(lock({ match: 'exact' }));
    if (!built.ok) throw new Error(built.problem);
    expect(parseIpLock({ expression: built.rule.expression, action: 'block' })).toEqual(lock());
  });

  it('leaves every other rule alone', () => {
    const built = buildRule(lock());
    if (!built.ok) throw new Error(built.problem);
    expect(parseIpLock({ expression: built.rule.expression, action: 'managed_challenge' })).toBe(
      null,
    );
    for (const expression of [
      '(ip.src.country in {"CN"})',
      '(ip.src in {203.0.113.10})',
      '(http.host eq "app.example.com" and not ip.src in {203.0.113.10})',
      '(http.host eq "app.example.com" or not ip.src in {203.0.113.10})',
      `(http.host eq "app.example.com" and ${ACME} and not ip.src in {203.0.113.10} and ssl)`,
      `(${ACME} and http.host eq "app.example.com" and not ip.src in {203.0.113.10})`,
      `(http.host eq "app.example.com" and ${ACME} and not ip.src in {203.0.113.5/24})`,
      `(http.host eq "app.example.com" and ${ACME} and not ip.src in {})`,
      '',
    ]) {
      expect(parseIpLock({ expression, action: 'block' }), expression).toBe(null);
    }
  });
});

describe('IP limit words', () => {
  it('names what is limited', () => {
    expect(ipLockTarget(lock(), 'example.com')).toBe('app.example.com');
    expect(ipLockTarget(lock({ path: '/admin' }), 'example.com')).toBe(
      'app.example.com/admin and below',
    );
    expect(ipLockTarget(lock({ path: '/login', match: 'exact' }), 'example.com')).toBe(
      'app.example.com/login',
    );
    expect(ipLockTarget(lock({ hostname: null }), 'example.com')).toBe('every name in example.com');
    expect(ipLockTarget(lock({ hostname: null, path: '/admin' }), 'example.com')).toBe(
      '/admin and below, on every name in example.com',
    );
  });

  it('says back who gets in, and what everyone else sees', () => {
    expect(ipLockPreview(lock(), 'example.com')).toBe(
      "Only 203.0.113.10 can open app.example.com. Everyone else gets Cloudflare's block page.",
    );
    expect(
      ipLockPreview(
        lock({ ips: ['203.0.113.10', '198.51.100.0/24'], path: '/admin' }),
        'example.com',
      ),
    ).toBe(
      "Only 203.0.113.10 and 198.51.100.0/24 can open app.example.com/admin and below. Everyone else gets Cloudflare's block page.",
    );
    expect(
      ipLockPreview(lock({ ips: ['203.0.113.10', '198.51.100.1', '198.51.100.2'] }), 'example.com'),
    ).toBe(
      "Only 203.0.113.10 and 2 more addresses can open app.example.com. Everyone else gets Cloudflare's block page.",
    );
    expect(ipLockPreview(lock({ ips: [] }), 'example.com')).toBe(
      'Add at least one address to say who can open app.example.com.',
    );
  });

  it('writes the Cloudflare description, kept short enough for it', () => {
    expect(ipLockDescription(lock({ path: '/admin' }))).toBe(
      'Only listed IPs, app.example.com/admin*',
    );
    expect(ipLockDescription(lock({ path: '/login', match: 'exact' }))).toBe(
      'Only listed IPs, app.example.com/login',
    );
    expect(ipLockDescription(lock({ hostname: null, path: '/a' }))).toBe(
      'Only listed IPs, every name /a*',
    );
    expect(ipLockDescription(lock({ path: `/${'a'.repeat(600)}` })).length).toBeLessThanOrEqual(
      500,
    );
  });
});

describe('parseAddresses', () => {
  it('splits typed or pasted text into addresses and ranges, in their usual spelling', () => {
    expect(parseAddresses('203.0.113.10, 2001:DB8::1\n198.51.100.0/24; 203.0.113.10')).toEqual([
      { kind: 'address', value: '203.0.113.10' },
      { kind: 'address', value: '2001:db8::1' },
      { kind: 'address', value: '198.51.100.0/24' },
    ]);
  });

  it('says why an entry cannot be used', () => {
    expect(parseAddresses('example.com 203.0.113.5/24')).toEqual([
      {
        kind: 'invalid',
        value: 'example.com',
        reason: 'This is not an IP address or a range like 203.0.113.0/24.',
      },
      {
        kind: 'invalid',
        value: '203.0.113.5/24',
        reason: '203.0.113.5/24 is not the start of its range. Use 203.0.113.0/24.',
      },
    ]);
    expect(parseAddresses('  ')).toEqual([]);
  });
});
