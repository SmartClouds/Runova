import { describe, expect, it } from 'vitest';
import { addressInList, canonicalIp, checkCidr, ipVersion, isPublicAddress } from './ip';

/**
 * Addresses reach Cloudflare as DNS record contents, WAF expressions and IP access rules, and
 * they come from people typing, a DNS lookup and Cloudflare itself. These checks run in the
 * renderer too, so they cannot lean on node:net.
 */

describe('ipVersion', () => {
  it('knows IPv4 and IPv6 addresses', () => {
    expect(ipVersion('203.0.113.10')).toBe(4);
    expect(ipVersion('0.0.0.0')).toBe(4);
    expect(ipVersion('255.255.255.255')).toBe(4);
    expect(ipVersion('2001:db8::1')).toBe(6);
    expect(ipVersion('::')).toBe(6);
    expect(ipVersion('::1')).toBe(6);
    expect(ipVersion('2001:DB8:0:0:0:0:0:1')).toBe(6);
    expect(ipVersion('::ffff:192.0.2.1')).toBe(6);
    expect(ipVersion('fe80::1:2')).toBe(6);
  });

  it('refuses anything that only looks like one', () => {
    for (const text of [
      '',
      '203.0.113',
      '203.0.113.256',
      '203.0.113.01',
      '203.0.113.1.5',
      ' 203.0.113.1',
      '2001:db8::1::2',
      '2001:db8:0:0:0:0:0:0:1',
      '2001:db8:0:0:0:0:1',
      '12345::1',
      'g::1',
      '2001:db8::1%eth0',
      ':1',
      '1:',
      '::ffff:192.0.2',
      'example.com',
    ]) {
      expect(ipVersion(text), text).toBeNull();
    }
  });
});

describe('canonicalIp', () => {
  it('writes IPv6 the way Cloudflare returns it, so the same address compares equal', () => {
    expect(canonicalIp('2001:0DB8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1');
    expect(canonicalIp('2001:db8:0:0:1:0:0:1')).toBe('2001:db8::1:0:0:1');
    expect(canonicalIp('2001:db8:0:1:1:1:1:1')).toBe('2001:db8:0:1:1:1:1:1');
    expect(canonicalIp('0:0:0:0:0:0:0:0')).toBe('::');
    expect(canonicalIp('::ffff:192.0.2.1')).toBe('::ffff:c000:201');
    expect(canonicalIp('1::')).toBe('1::');
  });

  it('leaves IPv4 as it is and refuses what is not an address', () => {
    expect(canonicalIp('203.0.113.10')).toBe('203.0.113.10');
    expect(canonicalIp('nope')).toBeNull();
  });
});

describe('isPublicAddress', () => {
  it('accepts addresses the internet can reach', () => {
    for (const ip of ['203.0.113.10', '8.8.8.8', '172.32.0.1', '2001:db8::10', '2606:4700::1']) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });

  it('refuses private, loopback, link-local and other unreachable addresses', () => {
    for (const ip of [
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.20',
      '127.0.0.1',
      '169.254.10.10',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '240.0.0.1',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      'ff02::1',
      '::ffff:10.0.0.1',
      'not an address',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });
});

describe('checkCidr', () => {
  it('accepts a network in CIDR notation', () => {
    expect(checkCidr('203.0.113.0/24')).toEqual({
      ok: true,
      version: 4,
      prefix: 24,
      network: '203.0.113.0/24',
    });
    expect(checkCidr('2001:DB8::/32')).toEqual({
      ok: true,
      version: 6,
      prefix: 32,
      network: '2001:db8::/32',
    });
    expect(checkCidr('0.0.0.0/0')).toMatchObject({ ok: true, prefix: 0 });
  });

  it('says which network was meant when host bits are set', () => {
    expect(checkCidr('203.0.113.5/24')).toEqual({
      ok: false,
      problem: '203.0.113.5/24 is not the start of its range. Use 203.0.113.0/24.',
    });
    expect(checkCidr('2001:db8::1/64')).toEqual({
      ok: false,
      problem: '2001:db8::1/64 is not the start of its range. Use 2001:db8::/64.',
    });
  });

  it('refuses a prefix out of range or text that is not a range', () => {
    expect(checkCidr('203.0.113.0/33')).toMatchObject({ ok: false });
    expect(checkCidr('2001:db8::/129')).toMatchObject({ ok: false });
    expect(checkCidr('203.0.113.0/')).toMatchObject({ ok: false });
    expect(checkCidr('203.0.113.0/024')).toMatchObject({ ok: false });
    expect(checkCidr('203.0.113.0')).toMatchObject({ ok: false });
    expect(checkCidr('example.com/24')).toMatchObject({ ok: false });
  });
});

describe('addressInList', () => {
  it('finds an address listed on its own or inside a listed range', () => {
    expect(addressInList('203.0.113.10', ['198.51.100.1', '203.0.113.10'])).toBe(true);
    expect(addressInList('203.0.113.10', ['203.0.113.0/24'])).toBe(true);
    expect(addressInList('203.0.114.10', ['203.0.113.0/24'])).toBe(false);
    expect(addressInList('2001:DB8::1', ['2001:db8::/32'])).toBe(true);
    expect(addressInList('2001:db9::1', ['2001:db8::/32'])).toBe(false);
    expect(addressInList('10.1.2.3', ['0.0.0.0/0'])).toBe(true);
  });

  it('never matches across IPv4 and IPv6, or on text that is not an address', () => {
    expect(addressInList('203.0.113.10', ['::/0'])).toBe(false);
    expect(addressInList('2001:db8::1', ['0.0.0.0/0'])).toBe(false);
    expect(addressInList('nowhere', ['0.0.0.0/0'])).toBe(false);
    expect(addressInList('203.0.113.10', ['not a range', ''])).toBe(false);
  });
});
