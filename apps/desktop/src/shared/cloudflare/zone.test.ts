import { describe, expect, it } from 'vitest';
import {
  checkPurgeHosts,
  checkPurgePrefixes,
  checkPurgeUrls,
  PURGE_URL_LIMIT,
  sslAdvice,
} from './zone';

describe('sslAdvice', () => {
  it('steers a proxied domain towards Full (strict)', () => {
    expect(sslAdvice('strict')).toMatchObject({ level: 'ok', recommended: 'strict' });
    expect(sslAdvice('origin_pull')).toMatchObject({ level: 'ok', recommended: 'origin_pull' });
    expect(sslAdvice('full')).toMatchObject({ level: 'improve', recommended: 'strict' });
    expect(sslAdvice('flexible')).toMatchObject({ level: 'warning', recommended: 'strict' });
    expect(sslAdvice('off')).toMatchObject({ level: 'warning', recommended: 'strict' });
  });

  it('explains why in words, without leaning on colour', () => {
    expect(sslAdvice('flexible').message).toMatch(/plain HTTP/);
    expect(sslAdvice('full').message).toMatch(/not checked/);
    expect(sslAdvice('off').message).toMatch(/no HTTPS/);
    expect(sslAdvice('strict').message).toMatch(/checks the server's certificate/);
  });
});

describe('checkPurgeUrls', () => {
  it('takes one URL per line, skipping blank lines and repeats', () => {
    expect(checkPurgeUrls('https://example.com/app.css\n\n  https://example.com/a.js \n')).toEqual({
      ok: true,
      urls: ['https://example.com/app.css', 'https://example.com/a.js'],
    });
    expect(checkPurgeUrls('https://example.com/a\nhttps://example.com/a')).toEqual({
      ok: true,
      urls: ['https://example.com/a'],
    });
  });

  it('refuses anything that is not a web address, an empty list and too many at once', () => {
    expect(checkPurgeUrls('  \n ')).toEqual({
      ok: false,
      problem: 'Enter at least one URL to purge.',
    });
    expect(checkPurgeUrls('example.com/app.css')).toEqual({
      ok: false,
      problem: 'example.com/app.css is not a full web address. Start it with https://.',
    });
    expect(checkPurgeUrls('ftp://example.com/file')).toMatchObject({ ok: false });
    expect(checkPurgeUrls(`https://example.com/${'a'.repeat(3000)}`)).toMatchObject({
      ok: false,
    });
    const many = Array.from(
      { length: PURGE_URL_LIMIT + 1 },
      (_, index) => `https://example.com/${index}`,
    );
    expect(checkPurgeUrls(many.join('\n'))).toEqual({
      ok: false,
      problem: `Cloudflare purges up to ${PURGE_URL_LIMIT} URLs at a time.`,
    });
  });
  it('refuses a URL outside the domain when it knows the domain', () => {
    expect(checkPurgeUrls('https://other.com/a.css', 'example.com')).toEqual({
      ok: false,
      problem: 'https://other.com/a.css is not under example.com.',
    });
    expect(checkPurgeUrls('https://www.example.com/a.css', 'example.com')).toEqual({
      ok: true,
      urls: ['https://www.example.com/a.css'],
    });
  });
});

describe('checkPurgePrefixes', () => {
  it('takes one folder per line, without the scheme and with the name in lower case', () => {
    expect(
      checkPurgePrefixes('https://Example.com/Blog/\n\n www.example.com/shop \nexample.com/Blog/'),
    ).toEqual({
      ok: true,
      items: ['example.com/Blog/', 'www.example.com/shop'],
    });
  });

  it('points a bare name at Hostnames, and refuses a query, an empty list and too many', () => {
    expect(checkPurgePrefixes(' \n')).toEqual({
      ok: false,
      problem: 'Enter at least one folder to purge.',
    });
    expect(checkPurgePrefixes('example.com/')).toEqual({
      ok: false,
      problem:
        'example.com/ is a whole hostname. Add a folder after it, like example.com/blog/, or pick Hostnames.',
    });
    expect(checkPurgePrefixes('example.com/blog?page=2')).toEqual({
      ok: false,
      problem: 'example.com/blog?page=2 has a query or a #. Keep just the name and the folder.',
    });
    expect(checkPurgePrefixes('exa mple.com/blog')).toEqual({
      ok: false,
      problem: 'exa mple.com/blog is not a folder address. Write it like example.com/blog/.',
    });
    expect(checkPurgePrefixes(`example.com/${'a'.repeat(3000)}`)).toEqual({
      ok: false,
      problem: 'Keep each folder under 2048 characters.',
    });
    const many = Array.from({ length: PURGE_URL_LIMIT + 1 }, (_, index) => `example.com/${index}/`);
    expect(checkPurgePrefixes(many.join('\n'))).toEqual({
      ok: false,
      problem: `Cloudflare purges up to ${PURGE_URL_LIMIT} folders at a time.`,
    });
  });

  it('refuses a folder outside the domain when it knows the domain', () => {
    expect(checkPurgePrefixes('shop.other.com/blog', 'example.com')).toEqual({
      ok: false,
      problem: 'shop.other.com/blog is not under example.com.',
    });
    expect(checkPurgePrefixes('notexample.com/blog', 'example.com')).toMatchObject({ ok: false });
    expect(checkPurgePrefixes('shop.example.com/blog', 'example.com')).toMatchObject({ ok: true });
  });
});

describe('checkPurgeHosts', () => {
  it('takes one hostname per line, without a scheme or a closing slash, in lower case', () => {
    expect(checkPurgeHosts('https://WWW.example.com/\nshop.example.com\nwww.example.com')).toEqual({
      ok: true,
      items: ['www.example.com', 'shop.example.com'],
    });
  });

  it('points a path at Folders, and refuses a bad name, an empty list and too many', () => {
    expect(checkPurgeHosts('')).toEqual({
      ok: false,
      problem: 'Enter at least one hostname to purge.',
    });
    expect(checkPurgeHosts('example.com/blog')).toEqual({
      ok: false,
      problem: 'example.com/blog is a folder. Pick Folders to purge it.',
    });
    expect(checkPurgeHosts('*.example.com')).toEqual({
      ok: false,
      problem: '*.example.com is not a hostname. Write it like www.example.com.',
    });
    expect(checkPurgeHosts('localhost')).toMatchObject({ ok: false });
    expect(checkPurgeHosts('-bad.example.com')).toMatchObject({ ok: false });
    const many = Array.from({ length: PURGE_URL_LIMIT + 1 }, (_, index) => `s${index}.example.com`);
    expect(checkPurgeHosts(many.join('\n'))).toEqual({
      ok: false,
      problem: `Cloudflare purges up to ${PURGE_URL_LIMIT} hostnames at a time.`,
    });
  });

  it('refuses a hostname outside the domain when it knows the domain', () => {
    expect(checkPurgeHosts('shop.other.com', 'example.com')).toEqual({
      ok: false,
      problem: 'shop.other.com is not under example.com.',
    });
    expect(checkPurgeHosts('example.com\nshop.example.com', 'example.com')).toMatchObject({
      ok: true,
    });
  });
});
