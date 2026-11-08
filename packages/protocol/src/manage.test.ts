import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decodeManageStream,
  encodeManageMessage,
  encodeManageStream,
  MANAGE_CAPABILITY,
  MANAGE_METHODS,
  type ManageMessage,
  parseManageMessage,
} from './manage.js';

const vectors = JSON.parse(
  readFileSync(new URL('../test-vectors/manage-v1.json', import.meta.url), 'utf8'),
) as {
  capability: string;
  messages: { text: string; value: ManageMessage }[];
  rejected: string[];
  binary: { subscription: number; payload: string; frame: string };
};

const fromHex = (hex: string) => new Uint8Array(Buffer.from(hex.replace(/\s/g, ''), 'hex'));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('management messages', () => {
  it('names the capability the vectors name', () => {
    expect(MANAGE_CAPABILITY).toBe(vectors.capability);
  });

  it.each(vectors.messages)('reads $text', ({ text, value }) => {
    expect(parseManageMessage(text)).toEqual(value);
  });

  it.each(vectors.messages)('writes $text byte for byte', ({ text, value }) => {
    expect(encodeManageMessage(value)).toBe(text);
  });

  it.each(vectors.rejected)('turns down %s', (text) => {
    expect(parseManageMessage(text)).toBeNull();
  });
});

describe('the binary stream frame', () => {
  it('matches the vector', () => {
    const { subscription, payload, frame } = vectors.binary;

    expect(toHex(encodeManageStream(subscription, fromHex(payload)))).toBe(toHex(fromHex(frame)));
  });

  it('reads back what it wrote', () => {
    const { subscription, payload, frame } = vectors.binary;

    const decoded = decodeManageStream(fromHex(frame));

    expect(decoded?.subscription).toBe(subscription);
    expect(toHex(decoded?.payload ?? new Uint8Array())).toBe(payload);
  });

  it('turns down a frame too short or of another kind', () => {
    expect(decodeManageStream(new Uint8Array([1, 0, 0]))).toBeNull();
    expect(decodeManageStream(new Uint8Array([2, 0, 0, 0, 1, 9]))).toBeNull();
  });
});

describe('the method table', () => {
  it('gives every method a known scope and risk', () => {
    const scopes = new Set([
      'core',
      'terminal',
      'git',
      'vault',
      'deploy',
      'ops',
      'control',
      'files',
    ]);
    const risks = new Set(['read', 'write', 'danger']);

    for (const [name, method] of Object.entries(MANAGE_METHODS)) {
      expect(scopes.has(method.scope), name).toBe(true);
      expect(risks.has(method.risk), name).toBe(true);
    }
  });

  it('starts with reading the project list', () => {
    expect(MANAGE_METHODS['projects.list']).toEqual({ scope: 'core', risk: 'read' });
  });
});
