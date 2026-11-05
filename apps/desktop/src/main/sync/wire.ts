import { createHash } from 'node:crypto';
import { canonicalJson, type Sealing } from '@runova/core';
import { openRecord, type RecordPlace, sealRecord } from '../account/keyring';

/**
 * A synced record's payload, as JSON text: the shared fields in the clear (or null when the whole
 * record is sealed), and a sealed part (end-to-end encrypted with the scope's key) holding the
 * secrets, or everything. The server stores it as it is and can not read the sealed part.
 */
export interface Payload {
  v: 1;
  shared: Record<string, unknown> | null;
  sealed: string | null;
}

export interface Encoded {
  encryption: 'none' | 'e2ee';
  keyVersion: number | null;
  payload: string;
}

export interface Decoded {
  shared: Record<string, unknown>;
  /** Null when the record carries no secrets this computer can read (none sent, or no key here). */
  secret: Record<string, unknown> | null;
  /** The record has sealed secrets this computer has no key for yet. */
  locked?: boolean;
}

export interface ScopeKey {
  version: number;
  key: Buffer;
}

/** The hash a sync compares: shared fields, plus secrets when they travel. */
export function contentHash(
  shared: Record<string, unknown>,
  secret: Record<string, unknown> | null,
): string {
  return createHash('sha256')
    .update(canonicalJson({ shared, secret: secret && Object.keys(secret).length ? secret : null }))
    .digest('hex');
}

/** What the secrets look like once this computer's sealing has decided whether they travel. */
export function travellingSecret(
  sealing: Sealing,
  secret: Record<string, unknown>,
): Record<string, unknown> | null {
  return sealing.mode === 'shared-only' || !Object.keys(secret).length ? null : secret;
}

export function encodeRecord(input: {
  place: Omit<RecordPlace, 'keyVersion'>;
  sealing: Sealing;
  key: ScopeKey | null;
  shared: Record<string, unknown>;
  secret: Record<string, unknown>;
}): Encoded {
  const { sealing, key, shared, secret } = input;
  if (sealing.mode === 'needs-key') throw new Error('This collection waits for a key.');
  if (
    sealing.mode === 'shared-only' ||
    (sealing.mode === 'seal-secrets' && !Object.keys(secret).length)
  ) {
    const payload: Payload = { v: 1, shared, sealed: null };
    return { encryption: 'none', keyVersion: null, payload: JSON.stringify(payload) };
  }
  if (!key) throw new Error('Sealing needs the scope key.');
  const place = { ...input.place, keyVersion: key.version };
  const payload: Payload =
    sealing.mode === 'seal-all'
      ? { v: 1, shared: null, sealed: sealRecord(key.key, place, { shared, secret }) }
      : { v: 1, shared, sealed: sealRecord(key.key, place, { secret }) };
  return { encryption: 'e2ee', keyVersion: key.version, payload: JSON.stringify(payload) };
}

/**
 * The record's content, or `needs-key` when it is sealed whole and this computer has no key for
 * it (or not that version). Throws when a sealed part does not open: changed or misplaced.
 */
export function decodeRecord(input: {
  place: Omit<RecordPlace, 'keyVersion'>;
  encryption: 'none' | 'e2ee';
  keyVersion: number | null;
  payload: string;
  keyFor: (version: number) => ScopeKey | null;
}): Decoded | 'needs-key' {
  const payload = JSON.parse(input.payload) as Payload;
  if (payload.v !== 1) throw new Error('A record from a newer Runova. Update to read it.');
  if (input.encryption === 'none' || !payload.sealed) {
    if (!payload.shared) throw new Error('A record with nothing in it.');
    return { shared: payload.shared, secret: null };
  }
  const key = input.keyVersion === null ? null : input.keyFor(input.keyVersion);
  if (!key) {
    return payload.shared ? { shared: payload.shared, secret: null, locked: true } : 'needs-key';
  }
  const opened = openRecord(
    key.key,
    { ...input.place, keyVersion: key.version },
    payload.sealed,
  ) as {
    shared?: Record<string, unknown>;
    secret?: Record<string, unknown>;
  };
  const shared = payload.shared ?? opened.shared;
  if (!shared) throw new Error('A sealed record with nothing in it.');
  return { shared, secret: opened.secret ?? null };
}
