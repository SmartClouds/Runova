import { describe, expect, it } from 'vitest';
import { parseRedisAcl, parseRedisLine } from './redisArgs.js';

/** Redis commands typed the way redis-cli takes them, and ACL rules read as access levels. */

describe('parseRedisLine', () => {
  it('splits on spaces', () => {
    expect(parseRedisLine('SET key value')).toEqual(['SET', 'key', 'value']);
    expect(parseRedisLine('  GET   key  ')).toEqual(['GET', 'key']);
  });

  it('keeps quoted arguments whole, with escapes in double quotes', () => {
    expect(parseRedisLine('SET greeting "hello world"')).toEqual([
      'SET',
      'greeting',
      'hello world',
    ]);
    expect(parseRedisLine("SET a 'it is'")).toEqual(['SET', 'a', 'it is']);
    expect(parseRedisLine('SET a "line\\nbreak \\"q\\" \\x41"')).toEqual([
      'SET',
      'a',
      'line\nbreak "q" A',
    ]);
    expect(parseRedisLine('SET a ""')).toEqual(['SET', 'a', '']);
  });

  it('turns down an unclosed quote', () => {
    expect(() => parseRedisLine('SET a "open')).toThrow(/quote/i);
  });
});

describe('parseRedisAcl', () => {
  it('reads a user with every command as a superuser', () => {
    expect(parseRedisAcl('user default on nopass sanitize-payload ~* &* +@all')).toEqual({
      name: 'default',
      enabled: true,
      level: 'admin',
      superuser: true,
    });
  });

  it('reads read and read-write users', () => {
    expect(parseRedisAcl('user reporter on #abc ~* resetchannels -@all +@read')).toMatchObject({
      name: 'reporter',
      level: 'read',
      superuser: false,
    });
    expect(parseRedisAcl('user app on #abc ~* -@all +@read +@write')).toMatchObject({
      level: 'write',
    });
    expect(parseRedisAcl('user off-user off #abc -@all')).toMatchObject({
      enabled: false,
      level: 'none',
    });
  });
});
