import { describe, expect, it } from 'vitest';
import { ALWAYS_TRUE, dropTable } from '../../test/main/hostileSqlInput';
import { opencodePromptSql, opencodeSessionTable } from './opencodeStore';

/**
 * The OpenCode table name goes into SQL text, since a table cannot be a parameter. It is picked
 * from the two names this file knows, so nothing the database says about itself ends up there.
 */

describe('opencodeSessionTable', () => {
  it('picks session_v2 only when both 2.x tables are listed', async () => {
    expect(
      await opencodeSessionTable(async () => [{ name: 'session_v2' }, { name: 'session_message' }]),
    ).toBe('session_v2');
    expect(await opencodeSessionTable(async () => [{ name: 'session_v2' }])).toBe('session');
    expect(await opencodeSessionTable(async () => [])).toBe('session');
  });

  it('never returns a name the database made up', async () => {
    const names = [
      `session_v2; ${dropTable('session')}`,
      ALWAYS_TRUE,
      'session_v2 --',
      '"session_v2"',
    ];
    const table = await opencodeSessionTable(async () => [
      ...names.map((name) => ({ name })),
      { name: 'session_message' },
    ]);
    expect(table).toBe('session');
  });
});

describe('opencodePromptSql', () => {
  it('binds the session id as a parameter in both layouts and both directions', () => {
    for (const table of ['session_v2', 'session'] as const) {
      for (const which of ['first', 'last'] as const) {
        const sql = opencodePromptSql(table, which);
        expect(sql.match(/\?/g)).toHaveLength(1);
        expect(sql).toMatch(which === 'first' ? / ASC LIMIT 1$/ : / DESC LIMIT 1$/);
      }
    }
  });
});
