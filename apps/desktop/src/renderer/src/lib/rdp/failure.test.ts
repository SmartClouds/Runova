import type { RdpProxyErrorCode } from '@shared/apiTypes';
import { describe, expect, it } from 'vitest';
import { describeFailure, describeProxyFailure } from './failure';

const CODES: RdpProxyErrorCode[] = [
  'host-not-found',
  'refused',
  'timeout',
  'unreachable',
  'closed',
  'not-rdp',
  'tls-failed',
  'tls-key-usage',
  'certificate-changed',
  'certificate-new',
  'proxy-failed',
  'other',
];

// Written as a code point so this file has no em dash of its own.
const EM_DASH = String.fromCodePoint(0x2014);

const LIBRARY_TEXT =
  /error:|OPENSSL|[Bb]oring[Ss][Ss][Ll]|ssl_cert|third_party|\.cc:\d|\.rs:\d|\bE(?:CONN|NOTFOUND)[A-Z]*\b/;

describe('describeProxyFailure', () => {
  it.each(CODES)('gives %s a heading and something to try, in plain words', (code) => {
    const failure = describeProxyFailure({ code, message: 'A sentence.' });

    expect(failure.code).toBe(code);
    expect(failure.title.length).toBeGreaterThan(3);
    expect(failure.hints.length).toBeGreaterThan(0);
    for (const text of [failure.title, ...failure.hints]) {
      expect(text).not.toMatch(LIBRARY_TEXT);
      // The project's writing style: no em dashes.
      expect(text).not.toContain(EM_DASH);
    }
  });

  it('keeps the proxy sentence and the technical reason as they came', () => {
    expect(
      describeProxyFailure({
        code: 'tls-key-usage',
        message:
          "The certificate h:3389 presented can't be used to set up an encrypted connection.",
        detail: 'KEY_USAGE_BIT_INCORRECT (SSL routines)',
      }),
    ).toMatchObject({
      title: "The server's certificate can't be used",
      message: "The certificate h:3389 presented can't be used to set up an encrypted connection.",
      detail: 'KEY_USAGE_BIT_INCORRECT (SSL routines)',
    });
  });

  it('explains a certificate Windows made for Remote Desktop and what to change on the server', () => {
    const { hints } = describeProxyFailure({ code: 'tls-key-usage', message: 'x' });
    expect(hints.join(' ')).toMatch(/Windows made this certificate/);
    expect(hints.join(' ')).toMatch(/RSA cipher suites|digital signatures/);
  });

  it('treats a changed certificate as expected after a reinstall, but not otherwise', () => {
    const { hints } = describeProxyFailure({ code: 'certificate-changed', message: 'x' });
    expect(hints[0]).toMatch(/reinstalled/);
    expect(hints[1]).toMatch(/don't trust/i);
  });

  it('falls back to the general advice for a code it does not know', () => {
    const failure = describeProxyFailure({
      code: 'from-the-future' as RdpProxyErrorCode,
      message: 'x',
    });
    expect(failure.title).toBe("Couldn't connect");
    expect(failure.hints.length).toBeGreaterThan(0);
  });
});

describe('describeFailure', () => {
  it('puts the table heading and hints around a given sentence', () => {
    expect(
      describeFailure('sign-in', 'The server did not accept the username or password.'),
    ).toMatchObject({
      code: 'sign-in',
      title: 'Sign-in failed',
      message: 'The server did not accept the username or password.',
    });
  });

  it('lets a caller replace the hints and add details', () => {
    expect(describeFailure('engine', 'Oops.', { hints: ['Try this.'], detail: 'why' })).toEqual({
      code: 'engine',
      title: "Couldn't connect",
      message: 'Oops.',
      hints: ['Try this.'],
      detail: 'why',
    });
  });
});
