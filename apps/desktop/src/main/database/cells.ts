import type { DbCell } from '../../shared/databaseTypes';

/** Binary longer than this is cut, since the grid only shows the start of it anyway. */
const BINARY_PREVIEW_BYTES = 64;

function hex(bytes: Uint8Array): string {
  const shown = bytes.subarray(0, BINARY_PREVIEW_BYTES);
  const text = `\\x${Buffer.from(shown).toString('hex')}`;
  return bytes.length > BINARY_PREVIEW_BYTES ? `${text}... (${bytes.length} bytes)` : text;
}

function convert(value: unknown, seen: Set<object>): DbCell {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'bigint':
      return value.toString();
    case 'function':
    case 'symbol':
      return String(value);
  }
  const object = value as object;
  if (object instanceof Date) {
    return Number.isNaN(object.getTime()) ? 'Invalid Date' : object.toISOString();
  }
  if (object instanceof Uint8Array) return hex(object);
  if (seen.has(object)) return '[circular]';
  seen.add(object);
  try {
    const bson = (object as { _bsontype?: unknown })._bsontype;
    if (typeof bson === 'string') {
      const withHex = object as { toHexString?: () => string };
      if (typeof withHex.toHexString === 'function') return withHex.toHexString();
      if (bson !== 'Binary') return String(object);
    }
    const withJson = object as { toJSON?: () => unknown };
    if (typeof withJson.toJSON === 'function') return convert(withJson.toJSON(), seen);
    if (Array.isArray(object)) return object.map((item) => convert(item, seen));
    if (object instanceof Set) return [...object].map((item) => convert(item, seen));
    const entries = object instanceof Map ? [...object.entries()] : Object.entries(object);
    const out: Record<string, DbCell> = {};
    for (const [key, item] of entries) out[String(key)] = convert(item, seen);
    return out;
  } finally {
    seen.delete(object);
  }
}

/** A value from any driver as plain JSON for the grid. Never throws. */
export function toCell(value: unknown): DbCell {
  return convert(value, new Set());
}
