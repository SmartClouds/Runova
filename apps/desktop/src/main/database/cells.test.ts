import { describe, expect, it } from 'vitest';
import { toCell } from './cells';

/** Whatever a driver hands back has to cross IPC as plain JSON the grid can show. */

describe('toCell', () => {
  it('keeps plain values as they are', () => {
    expect(toCell(null)).toBeNull();
    expect(toCell(undefined)).toBeNull();
    expect(toCell('a')).toBe('a');
    expect(toCell(3.5)).toBe(3.5);
    expect(toCell(true)).toBe(true);
  });

  it('writes numbers JSON cannot hold as text', () => {
    expect(toCell(12345678901234567890n)).toBe('12345678901234567890');
    expect(toCell(Number.NaN)).toBe('NaN');
    expect(toCell(Number.POSITIVE_INFINITY)).toBe('Infinity');
  });

  it('writes dates as ISO text, and an invalid date as such', () => {
    expect(toCell(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z');
    expect(toCell(new Date('nope'))).toBe('Invalid Date');
  });

  it('writes short binary as hex and cuts long binary short', () => {
    expect(toCell(Buffer.from([0xde, 0xad]))).toBe('\\xdead');
    expect(toCell(new Uint8Array([1, 2]))).toBe('\\x0102');
    const long = toCell(Buffer.alloc(300, 0xff)) as string;
    expect(long.startsWith('\\xffff')).toBe(true);
    expect(long).toMatch(/\(300 bytes\)$/);
  });

  it('turns objects and arrays into JSON values, all the way down', () => {
    expect(toCell({ a: 1, b: [new Date('2026-01-01T00:00:00Z'), 2n] })).toEqual({
      a: 1,
      b: ['2026-01-01T00:00:00.000Z', '2'],
    });
  });

  it('uses a value its own toJSON or toHexString gives, like a Mongo ObjectId or Decimal128', () => {
    const objectId = { _bsontype: 'ObjectId', toHexString: () => '65f0c0ffee' };
    expect(toCell(objectId)).toBe('65f0c0ffee');
    const decimal = { _bsontype: 'Decimal128', toString: () => '1.10' };
    expect(toCell(decimal)).toBe('1.10');
    expect(toCell({ toJSON: () => ({ x: 1 }) })).toEqual({ x: 1 });
  });

  it('stops at a cycle instead of looping', () => {
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = loop;
    expect(toCell(loop)).toEqual({ a: 1, self: '[circular]' });
  });

  it('writes a Map and a Set as JSON', () => {
    expect(toCell(new Map([['k', 1]]))).toEqual({ k: 1 });
    expect(toCell(new Set([1, 2]))).toEqual([1, 2]);
  });
});
