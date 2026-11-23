import { splitFields, syncCollection } from '@runova/core';
import { describe, expect, it } from 'vitest';
import { encodeRecord, type ScopeKey, sealedWhole } from './wire';

const KEY: ScopeKey = { version: 1, key: Buffer.alloc(32, 9) };
const place = { scopeId: 1, collection: 'ssh-servers', itemId: 's1' };

/** An SSH server as the adapter lists it: every envelope opened. */
function tunnelServer() {
  return {
    id: 's1',
    host: 'h.example',
    cloudflareTunnel: {
      hostname: 'ssh.example.test',
      clientId: 'id.access',
      clientSecret: { $secret: 'CF-ACCESS-SECRET' },
    },
    secretEnvelope: { $secret: 'ssh-password' },
  };
}

describe('wire', () => {
  it('keeps the Cloudflare Access secret of an SSH server out of the readable fields', () => {
    const split = splitFields(tunnelServer(), syncCollection('ssh-servers').fields);

    expect(JSON.stringify(split.shared)).not.toContain('CF-ACCESS-SECRET');
    expect(split.shared.cloudflareTunnel).toEqual({
      hostname: 'ssh.example.test',
      clientId: 'id.access',
    });
    for (const [sealing, key] of [
      [{ mode: 'shared-only' }, null],
      [{ mode: 'seal-secrets' }, KEY],
    ] as const) {
      const encoded = encodeRecord({ place, sealing, key, ...split });
      expect(encoded.payload).not.toContain('CF-ACCESS-SECRET');
    }
  });

  it('refuses to send an opened secret in the readable fields, unless the record is sealed whole', () => {
    const shared = { id: 's1', nested: [{ token: { $secret: 'leak' } }] };

    for (const [sealing, key] of [
      [{ mode: 'shared-only' }, null],
      [{ mode: 'seal-secrets' }, KEY],
    ] as const) {
      expect(() => encodeRecord({ place, sealing, key, shared, secret: {} })).toThrow(/not sealed/);
    }
    const whole = encodeRecord({
      place,
      sealing: { mode: 'seal-all' },
      key: KEY,
      shared,
      secret: {},
    });
    expect(whole.payload).not.toContain('leak');
    expect(sealedWhole({ encryption: whole.encryption, payload: whole.payload })).toBe(true);
  });

  it('tells a record sealed whole from one with readable fields', () => {
    const shared = { id: 's1', host: 'h' };
    const secrets = encodeRecord({
      place,
      sealing: { mode: 'seal-secrets' },
      key: KEY,
      shared,
      secret: { secretEnvelope: { $secret: 'pw' } },
    });
    const clear = encodeRecord({
      place,
      sealing: { mode: 'shared-only' },
      key: null,
      shared,
      secret: {},
    });

    expect(sealedWhole({ encryption: secrets.encryption, payload: secrets.payload })).toBe(false);
    expect(sealedWhole({ encryption: clear.encryption, payload: clear.payload })).toBe(false);
    expect(
      sealedWhole({
        encryption: 'e2ee',
        payload: JSON.stringify({ v: 1, shared: null, sealed: null }),
      }),
    ).toBe(false);
    expect(sealedWhole({ encryption: 'e2ee', payload: 'not json' })).toBe(false);
  });
});
