// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  creationOptions,
  credentialJson,
  fromBase64Url,
  passkeysSupported,
  requestOptions,
  runPasskey,
  toBase64Url,
} from '../src/lib/account/passkeys';
import { fakeFetch, json, problem } from './helpers/fakeAdminFetch';

const bytes = (...values: number[]) => new Uint8Array(values);
const buffer = (...values: number[]) => bytes(...values).buffer;

/** A credential as the browser hands it over, without toJSON (older Safari and Firefox). */
function assertion() {
  return {
    id: '-_8B',
    rawId: buffer(0xfb, 0xff, 0x01),
    type: 'public-key',
    authenticatorAttachment: 'platform',
    getClientExtensionResults: () => ({}),
    response: {
      clientDataJSON: buffer(1, 2),
      authenticatorData: buffer(3),
      signature: buffer(4, 5),
      userHandle: buffer(0x34, 0x32),
    },
  };
}

function attestation() {
  return {
    id: 'AQI',
    rawId: buffer(1, 2),
    type: 'public-key',
    authenticatorAttachment: 'cross-platform',
    getClientExtensionResults: () => ({ credProps: { rk: true } }),
    response: {
      clientDataJSON: buffer(9),
      attestationObject: buffer(8, 7),
      getTransports: () => ['usb', 'nfc'],
    },
  };
}

function stubBrowser(credentials: Partial<CredentialsContainer>, publicKeyCredential: object = {}) {
  vi.stubGlobal('PublicKeyCredential', Object.assign(class {}, publicKeyCredential));
  Object.defineProperty(navigator, 'credentials', { value: credentials, configurable: true });
}

beforeEach(() => {
  document.cookie = 'XSRF-TOKEN=xsrf; path=/';
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'credentials', { value: undefined, configurable: true });
});

describe('base64url', () => {
  it('goes both ways without padding', () => {
    expect(toBase64Url(bytes(0xfb, 0xff, 0x01))).toBe('-_8B');
    expect(Array.from(fromBase64Url('-_8B'))).toEqual([0xfb, 0xff, 0x01]);
    expect(Array.from(fromBase64Url(toBase64Url(bytes(1, 2, 3, 4))))).toEqual([1, 2, 3, 4]);
  });
});

describe('options from the server', () => {
  it('turns the request challenge and allowed ids into bytes', () => {
    const options = requestOptions({
      challenge: 'AQID',
      rpId: 'runovahq.com',
      userVerification: 'required',
      allowCredentials: [{ type: 'public-key', id: '-_8B', transports: ['internal'] }],
    });

    expect(Array.from(new Uint8Array(options.challenge as ArrayBuffer))).toEqual([1, 2, 3]);
    expect(options.rpId).toBe('runovahq.com');
    expect(Array.from(new Uint8Array(options.allowCredentials?.[0]?.id as ArrayBuffer))).toEqual([
      0xfb, 0xff, 0x01,
    ]);
  });

  it('turns the creation challenge, user id and excluded ids into bytes', () => {
    const options = creationOptions({
      challenge: 'AQID',
      rp: { id: 'runovahq.com', name: 'Runova' },
      user: { id: 'NDI', name: 'sam@example.com', displayName: 'Sam' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      excludeCredentials: [{ type: 'public-key', id: 'AQI' }],
    });

    expect(Array.from(new Uint8Array(options.user.id as ArrayBuffer))).toEqual([0x34, 0x32]);
    expect(options.user.name).toBe('sam@example.com');
    expect(Array.from(new Uint8Array(options.excludeCredentials?.[0]?.id as ArrayBuffer))).toEqual([
      1, 2,
    ]);
  });
});

describe('the answer to send back', () => {
  it('writes an assertion as PublicKeyCredential.toJSON would', () => {
    expect(credentialJson(assertion() as unknown as PublicKeyCredential)).toEqual({
      id: '-_8B',
      rawId: '-_8B',
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: 'AQI',
        authenticatorData: 'Aw',
        signature: 'BAU',
        userHandle: 'NDI',
      },
    });
  });

  it('writes an attestation with its transports', () => {
    expect(credentialJson(attestation() as unknown as PublicKeyCredential)).toEqual({
      id: 'AQI',
      rawId: 'AQI',
      type: 'public-key',
      authenticatorAttachment: 'cross-platform',
      clientExtensionResults: { credProps: { rk: true } },
      response: { clientDataJSON: 'CQ', attestationObject: 'CAc', transports: ['usb', 'nfc'] },
    });
  });

  it('uses the browser toJSON when there is one', () => {
    const credential = { ...assertion(), toJSON: () => ({ id: 'from-browser' }) };

    expect(credentialJson(credential as unknown as PublicKeyCredential)).toEqual({
      id: 'from-browser',
    });
  });
});

describe('passkeysSupported', () => {
  it('is false in a browser with no WebAuthn', () => {
    expect(passkeysSupported()).toBe(false);
  });

  it('is true with PublicKeyCredential and navigator.credentials', () => {
    stubBrowser({ get: vi.fn() });

    expect(passkeysSupported()).toBe(true);
  });
});

describe('runPasskey', () => {
  it('asks for a challenge, lets the browser answer and hands back both', async () => {
    const api = fakeFetch({
      'POST /api/v1/passkey-challenges': json(
        {
          id: 'challenge-1',
          options: { challenge: 'AQID', rpId: 'runovahq.com' },
          expiresAt: '2026-11-19T10:05:00Z',
        },
        { status: 201 },
      ),
    });
    const get = vi.fn().mockResolvedValue(assertion());
    stubBrowser({ get });

    const result = await runPasskey('sign-in');

    expect(result).toEqual({
      ok: true,
      challengeId: 'challenge-1',
      credential: expect.objectContaining({ id: '-_8B' }),
    });
    expect(api.calls('POST /api/v1/passkey-challenges')[0]?.json()).toEqual({ purpose: 'sign-in' });
    expect(get.mock.calls[0]?.[0].publicKey.rpId).toBe('runovahq.com');
  });

  it('creates a passkey for register', async () => {
    fakeFetch({
      'POST /api/v1/passkey-challenges': json(
        {
          id: 'challenge-2',
          options: {
            challenge: 'AQID',
            rp: { id: 'runovahq.com', name: 'Runova' },
            user: { id: 'NDI', name: 'sam', displayName: 'Sam' },
            pubKeyCredParams: [],
          },
          expiresAt: '2026-11-19T10:05:00Z',
        },
        { status: 201 },
      ),
    });
    const create = vi.fn().mockResolvedValue(attestation());
    stubBrowser({ create });

    const result = await runPasskey('register');

    expect(result.ok).toBe(true);
    expect(create).toHaveBeenCalledOnce();
  });

  it('uses the browser parser for the options when there is one', async () => {
    fakeFetch({
      'POST /api/v1/passkey-challenges': json(
        { id: 'c', options: { challenge: 'AQID' }, expiresAt: '' },
        { status: 201 },
      ),
    });
    const parsed = { challenge: buffer(9) };
    const parseRequestOptionsFromJSON = vi.fn().mockReturnValue(parsed);
    const get = vi.fn().mockResolvedValue(assertion());
    stubBrowser({ get }, { parseRequestOptionsFromJSON });

    await runPasskey('step-up');

    expect(parseRequestOptionsFromJSON).toHaveBeenCalledWith({ challenge: 'AQID' });
    expect(get.mock.calls[0]?.[0].publicKey).toBe(parsed);
  });

  it('reads a closed prompt as cancelled, not as an error', async () => {
    fakeFetch({
      'POST /api/v1/passkey-challenges': json(
        { id: 'c', options: { challenge: 'AQID' }, expiresAt: '' },
        { status: 201 },
      ),
    });
    stubBrowser({ get: vi.fn().mockRejectedValue(new DOMException('closed', 'NotAllowedError')) });

    expect(await runPasskey('sign-in')).toEqual({ ok: false, cancelled: true });
  });

  it('says so when the browser fails for another reason', async () => {
    fakeFetch({
      'POST /api/v1/passkey-challenges': json(
        { id: 'c', options: { challenge: 'AQID' }, expiresAt: '' },
        { status: 201 },
      ),
    });
    stubBrowser({ get: vi.fn().mockRejectedValue(new DOMException('bad rp', 'SecurityError')) });

    const result = await runPasskey('sign-in');

    expect(result).toEqual({
      ok: false,
      cancelled: false,
      message: expect.stringMatching(/passkey/i),
    });
  });

  it('passes on the problem when the server gives no challenge', async () => {
    fakeFetch({
      'POST /api/v1/passkey-challenges': problem(429, 'rate-limited', {
        detail: 'Too many tries.',
      }),
    });
    stubBrowser({ get: vi.fn() });

    expect(await runPasskey('sign-in')).toEqual({
      ok: false,
      cancelled: false,
      message: 'Too many tries.',
    });
  });
});
