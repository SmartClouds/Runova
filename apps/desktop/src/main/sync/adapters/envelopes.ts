/**
 * Every store seals its secrets on this computer (`SecretEnvelope`: the OS keychain, or the
 * Servers passkey). Another computer can not open those, so before a sync an adapter opens each
 * envelope in an item into `{ $secret: plaintext }`, and after one it seals each marker again with
 * this computer's own sealing. The plaintext lives only in memory in between, and leaves this
 * computer only inside a record sealed with the scope's key (wire.ts) or not at all.
 */

export interface SecretMarker {
  $secret: string;
}

type Envelope =
  | { mode: 'safeStorage'; ciphertext: string }
  | { mode: 'passphrase'; iv: string; authTag: string; ciphertext: string };

function isEnvelope(value: unknown): value is Envelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.ciphertext !== 'string') return false;
  if (v.mode === 'safeStorage') return Object.keys(v).length === 2;
  return v.mode === 'passphrase' && typeof v.iv === 'string' && typeof v.authTag === 'string';
}

function isMarker(value: unknown): value is SecretMarker {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as SecretMarker).$secret === 'string' &&
    Object.keys(value).length === 1
  );
}

async function walk(
  value: unknown,
  visit: (node: unknown) => Promise<unknown | undefined>,
): Promise<unknown> {
  const replaced = await visit(value);
  if (replaced !== undefined) return replaced;
  if (Array.isArray(value)) return Promise.all(value.map((item) => walk(item, visit)));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) out[key] = await walk(field, visit);
    return out;
  }
  return value;
}

export async function openEnvelopes<T>(
  value: T,
  open: (envelope: Envelope) => Promise<string>,
): Promise<T> {
  return (await walk(value, async (node) =>
    isEnvelope(node) ? { $secret: await open(node) } : undefined,
  )) as T;
}

export async function sealSecrets<T>(
  value: T,
  seal: (plain: string) => Promise<unknown>,
): Promise<T> {
  return (await walk(value, async (node) =>
    isMarker(node) ? seal(node.$secret) : undefined,
  )) as T;
}
