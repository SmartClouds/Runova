import { describe, expect, it } from 'vitest';
import { checkNewDomain } from './newDomain';

describe('checkNewDomain', () => {
  it('takes a plain domain as typed, in lowercase', () => {
    expect(checkNewDomain('Example.COM')).toEqual({
      ok: true,
      name: 'example.com',
      suggestion: null,
    });
    expect(checkNewDomain('  my-site.co.uk.  ')).toMatchObject({ ok: true, name: 'my-site.co.uk' });
  });

  it('takes a pasted web address and keeps only its host', () => {
    expect(checkNewDomain('https://example.com/')).toMatchObject({ ok: true, name: 'example.com' });
    expect(checkNewDomain('http://Example.com:8080/blog?x=1#top')).toMatchObject({
      ok: true,
      name: 'example.com',
    });
    expect(checkNewDomain('example.com/pricing')).toMatchObject({ ok: true, name: 'example.com' });
  });

  it('writes an international domain in Punycode, the way Cloudflare stores it', () => {
    expect(checkNewDomain('bücher.de')).toMatchObject({ ok: true, name: 'xn--bcher-kva.de' });
  });

  it('suggests the main domain when the name starts with www', () => {
    expect(checkNewDomain('www.example.com')).toEqual({
      ok: true,
      name: 'www.example.com',
      suggestion: 'example.com',
    });
    // "www.com" is a domain of its own, so there is nothing to suggest.
    expect(checkNewDomain('www.com')).toMatchObject({ ok: true, suggestion: null });
  });

  it('asks for a domain when the box is empty', () => {
    expect(checkNewDomain('   ')).toEqual({
      ok: false,
      problem: 'Type the domain you want to add, like example.com.',
    });
    expect(checkNewDomain('https://')).toMatchObject({ ok: false });
  });

  it('asks for the ending when there is only one label', () => {
    expect(checkNewDomain('example')).toEqual({
      ok: false,
      problem: 'Add the ending too, like example.com.',
    });
  });

  it('turns away an IP address', () => {
    for (const text of ['203.0.113.10', '2001:db8::1', 'http://203.0.113.10/']) {
      expect(checkNewDomain(text)).toEqual({
        ok: false,
        problem: 'That is an IP address. Type a domain name instead, like example.com.',
      });
    }
  });

  it('turns away a wildcard', () => {
    expect(checkNewDomain('*.example.com')).toEqual({
      ok: false,
      problem: 'Type the domain itself, without the *.',
    });
  });

  it('turns away names a domain cannot have', () => {
    for (const text of ['exa mple.com', '-example.com', 'example..com', 'my_site.com', 'a@b.com']) {
      expect(checkNewDomain(text)).toEqual({
        ok: false,
        problem: 'That is not a domain name. Check it for typos.',
      });
    }
  });

  it('turns away a name longer than DNS allows', () => {
    expect(checkNewDomain(`${'a'.repeat(250)}.com`)).toMatchObject({ ok: false });
  });
});
