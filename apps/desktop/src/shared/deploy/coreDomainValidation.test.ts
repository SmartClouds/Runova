import { describe, expect, it } from 'vitest';
import { checkCoreDomainName } from './coreDomainValidation';

describe('checkCoreDomainName', () => {
  it('takes a plain domain, trimmed and in lowercase', () => {
    expect(checkCoreDomainName('  Core.Example.COM ')).toEqual({
      ok: true,
      value: 'core.example.com',
    });
    expect(checkCoreDomainName('xn--bcher-kva.example')).toEqual({
      ok: true,
      value: 'xn--bcher-kva.example',
    });
  });

  it.each([
    ['', /Enter a domain/],
    ['*.example.com', /wildcard/],
    ['https://core.example.com', /without https/],
    ['core.example.com/hub', /without https/],
    ['core.example.com.', /trailing dot/],
    ['203.0.113.7', /IP address/],
    ['[2001:db8::1]', /IP address/],
    ['localhost', /with a dot/],
    ['-bad.example.com', /letters, digits and hyphens/],
    ['under_score.example.com', /letters, digits and hyphens/],
  ])('refuses %j', (input, reason) => {
    const result = checkCoreDomainName(input);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toMatch(reason);
  });
});
