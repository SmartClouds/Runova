import { describe, expect, it } from 'vitest';
import {
  maintenanceActions,
  maintenanceAdvice,
  maintenanceStatements,
  PRECISE_STATS_STATEMENT,
} from './maintenance.js';

const orders = { database: 'shop', schema: 'sales', name: 'orders' };

describe('maintenanceAdvice', () => {
  describe('SQL Server, by Microsoft guidance', () => {
    const big = { pageCount: 5_000, sizeBytes: 40_000_000 };

    it('leaves an index under 5% alone', () => {
      expect(maintenanceAdvice('mssql', { ...big, fragmentationPercent: 4.9 })).toMatchObject({
        action: 'none',
        severity: 'ok',
      });
    });

    it('reorganizes from 5% up to 30%', () => {
      for (const value of [5, 17, 30]) {
        expect(maintenanceAdvice('mssql', { ...big, fragmentationPercent: value })).toMatchObject({
          action: 'reorganize',
          severity: 'warn',
        });
      }
    });

    it('rebuilds over 30%', () => {
      expect(maintenanceAdvice('mssql', { ...big, fragmentationPercent: 30.1 })).toMatchObject({
        action: 'rebuild',
        severity: 'bad',
      });
    });

    it('ignores fragmentation in an index under 1,000 pages', () => {
      const advice = maintenanceAdvice('mssql', {
        fragmentationPercent: 90,
        pageCount: 999,
        sizeBytes: 8_000_000,
      });
      expect(advice).toMatchObject({ action: 'none', severity: 'small' });
      expect(advice.reason).toMatch(/1,000 pages/);
    });

    it('says when nothing was measured', () => {
      expect(
        maintenanceAdvice('mssql', {
          fragmentationPercent: null,
          pageCount: null,
          sizeBytes: null,
        }),
      ).toMatchObject({ action: 'none', severity: 'unknown' });
    });
  });

  describe('PostgreSQL bloat', () => {
    it('rebuilds a large index with 30% or more bloat', () => {
      expect(
        maintenanceAdvice('postgres', {
          fragmentationPercent: 30,
          pageCount: 2_000,
          sizeBytes: 16_000_000,
        }),
      ).toMatchObject({ action: 'rebuild', severity: 'bad' });
    });

    it('watches from 20%, without asking for anything', () => {
      expect(
        maintenanceAdvice('postgres', {
          fragmentationPercent: 22,
          pageCount: 2_000,
          sizeBytes: 16_000_000,
        }),
      ).toMatchObject({ action: 'none', severity: 'warn' });
    });

    it('ignores an index under 8 MB', () => {
      expect(
        maintenanceAdvice('postgres', {
          fragmentationPercent: 80,
          pageCount: 100,
          sizeBytes: 800_000,
        }),
      ).toMatchObject({ action: 'none', severity: 'small' });
    });
  });

  describe('MySQL and MariaDB free space', () => {
    it('optimizes a table over 10 MB with 10% or more free space', () => {
      for (const engine of ['mysql', 'mariadb'] as const) {
        expect(
          maintenanceAdvice(engine, {
            fragmentationPercent: 12,
            pageCount: null,
            sizeBytes: 50_000_000,
          }),
        ).toMatchObject({ action: 'rebuild', severity: 'warn' });
        expect(
          maintenanceAdvice(engine, {
            fragmentationPercent: 45,
            pageCount: null,
            sizeBytes: 50_000_000,
          }),
        ).toMatchObject({ action: 'rebuild', severity: 'bad' });
      }
    });

    it('leaves small or tidy tables alone', () => {
      expect(
        maintenanceAdvice('mysql', {
          fragmentationPercent: 50,
          pageCount: null,
          sizeBytes: 5_000_000,
        }),
      ).toMatchObject({ action: 'none', severity: 'small' });
      expect(
        maintenanceAdvice('mysql', {
          fragmentationPercent: 3,
          pageCount: null,
          sizeBytes: 50_000_000,
        }),
      ).toMatchObject({ action: 'none', severity: 'ok' });
    });
  });

  describe('SQLite free pages', () => {
    it('vacuums a file over 1 MB with 10% or more free pages', () => {
      expect(
        maintenanceAdvice('sqlite', {
          fragmentationPercent: 25,
          pageCount: 1_000,
          sizeBytes: 4_096_000,
        }),
      ).toMatchObject({ action: 'rebuild', severity: 'warn' });
    });

    it('ignores a tiny file', () => {
      expect(
        maintenanceAdvice('sqlite', {
          fragmentationPercent: 60,
          pageCount: 10,
          sizeBytes: 40_960,
        }),
      ).toMatchObject({ action: 'none', severity: 'small' });
    });
  });

  it('calls an unmeasured index too small when its size says so', () => {
    expect(
      maintenanceAdvice('postgres', {
        fragmentationPercent: null,
        pageCount: 2,
        sizeBytes: 16_384,
      }),
    ).toMatchObject({ action: 'none', severity: 'small' });
    expect(
      maintenanceAdvice('mssql', { fragmentationPercent: null, pageCount: 12, sizeBytes: null }),
    ).toMatchObject({ action: 'none', severity: 'small' });
    expect(
      maintenanceAdvice('postgres', {
        fragmentationPercent: null,
        pageCount: 5_000,
        sizeBytes: 40_000_000,
      }),
    ).toMatchObject({ severity: 'unknown' });
  });

  it('has nothing to say for engines without maintenance', () => {
    expect(
      maintenanceAdvice('redis', { fragmentationPercent: 90, pageCount: 1e6, sizeBytes: 1e9 }),
    ).toMatchObject({ action: 'none', severity: 'unknown' });
  });
});

describe('maintenanceStatements on SQL Server', () => {
  const index = { scope: 'index', table: orders, index: 'IX_orders_customer' } as const;

  it('rebuilds one index with its options', () => {
    expect(
      maintenanceStatements('mssql', 'rebuild', index, {
        online: true,
        fillFactor: 90,
        sortInTempdb: true,
      }),
    ).toEqual([
      'ALTER INDEX [IX_orders_customer] ON [shop].[sales].[orders] REBUILD WITH (ONLINE = ON, FILLFACTOR = 90, SORT_IN_TEMPDB = ON);',
    ]);
  });

  it('rebuilds with no WITH clause when no option is set', () => {
    expect(maintenanceStatements('mssql', 'rebuild', index)).toEqual([
      'ALTER INDEX [IX_orders_customer] ON [shop].[sales].[orders] REBUILD;',
    ]);
  });

  it('reorganizes an index, and every index of a table', () => {
    expect(maintenanceStatements('mssql', 'reorganize', index)).toEqual([
      'ALTER INDEX [IX_orders_customer] ON [shop].[sales].[orders] REORGANIZE;',
    ]);
    expect(maintenanceStatements('mssql', 'reorganize', { scope: 'table', table: orders })).toEqual(
      ['ALTER INDEX ALL ON [shop].[sales].[orders] REORGANIZE;'],
    );
  });

  it('rebuilds every index of a table, and a heap through ALTER TABLE', () => {
    expect(
      maintenanceStatements(
        'mssql',
        'rebuild',
        { scope: 'table', table: orders },
        { online: true },
      ),
    ).toEqual(['ALTER INDEX ALL ON [shop].[sales].[orders] REBUILD WITH (ONLINE = ON);']);
    expect(maintenanceStatements('mssql', 'rebuild', { scope: 'heap', table: orders })).toEqual([
      'ALTER TABLE [shop].[sales].[orders] REBUILD;',
    ]);
  });

  it('rebuilds a heap online, but takes no fill factor or tempdb sort for it', () => {
    expect(
      maintenanceStatements('mssql', 'rebuild', { scope: 'heap', table: orders }, { online: true }),
    ).toEqual(['ALTER TABLE [shop].[sales].[orders] REBUILD WITH (ONLINE = ON);']);
    expect(() =>
      maintenanceStatements(
        'mssql',
        'rebuild',
        { scope: 'heap', table: orders },
        { fillFactor: 90 },
      ),
    ).toThrow(/heap/);
    expect(() =>
      maintenanceStatements(
        'mssql',
        'rebuild',
        { scope: 'heap', table: orders },
        { sortInTempdb: true },
      ),
    ).toThrow(/heap/);
  });

  it('updates statistics for an index, a table or the database', () => {
    expect(maintenanceStatements('mssql', 'statistics', index)).toEqual([
      'UPDATE STATISTICS [sales].[orders] [IX_orders_customer];',
    ]);
    expect(maintenanceStatements('mssql', 'statistics', { scope: 'table', table: orders })).toEqual(
      ['UPDATE STATISTICS [sales].[orders];'],
    );
    expect(maintenanceStatements('mssql', 'statistics', { scope: 'database' })).toEqual([
      'EXEC sp_updatestats;',
    ]);
  });

  it('quotes names that carry brackets', () => {
    expect(
      maintenanceStatements('mssql', 'reorganize', {
        scope: 'index',
        table: { database: 'a]b', schema: 'dbo', name: 't' },
        index: 'ix]1',
      }),
    ).toEqual(['ALTER INDEX [ix]]1] ON [a]]b].[dbo].[t] REORGANIZE;']);
  });

  it('refuses options a reorganize does not take', () => {
    expect(() => maintenanceStatements('mssql', 'reorganize', index, { fillFactor: 80 })).toThrow(
      /reorganize/i,
    );
    expect(() => maintenanceStatements('mssql', 'reorganize', index, { online: true })).toThrow(
      /reorganize/i,
    );
  });

  it('refuses a fill factor outside 1 to 100', () => {
    for (const fillFactor of [0, 101, 50.5]) {
      expect(() => maintenanceStatements('mssql', 'rebuild', index, { fillFactor })).toThrow(
        /1 to 100/,
      );
    }
  });

  it('refuses actions the engine does not have', () => {
    expect(() => maintenanceStatements('mssql', 'vacuum', { scope: 'database' })).toThrow();
    expect(() => maintenanceStatements('mssql', 'rebuild', { scope: 'database' })).toThrow();
    expect(() => maintenanceStatements('mssql', 'rebuild', index, { concurrently: true })).toThrow(
      /PostgreSQL/,
    );
  });
});

describe('maintenanceStatements on PostgreSQL', () => {
  const index = { scope: 'index', table: orders, index: 'orders_customer_idx' } as const;

  it('reindexes one index, concurrently when asked', () => {
    expect(maintenanceStatements('postgres', 'rebuild', index)).toEqual([
      'REINDEX INDEX "sales"."orders_customer_idx";',
    ]);
    expect(maintenanceStatements('postgres', 'rebuild', index, { concurrently: true })).toEqual([
      'REINDEX INDEX CONCURRENTLY "sales"."orders_customer_idx";',
    ]);
  });

  it('sets the fill factor before the reindex', () => {
    expect(maintenanceStatements('postgres', 'rebuild', index, { fillFactor: 80 })).toEqual([
      'ALTER INDEX "sales"."orders_customer_idx" SET (fillfactor = 80);',
      'REINDEX INDEX "sales"."orders_customer_idx";',
    ]);
  });

  it('reindexes, vacuums and analyzes a table', () => {
    const table = { scope: 'table', table: orders } as const;
    expect(maintenanceStatements('postgres', 'rebuild', table, { concurrently: true })).toEqual([
      'REINDEX TABLE CONCURRENTLY "sales"."orders";',
    ]);
    expect(maintenanceStatements('postgres', 'vacuum', table)).toEqual([
      'VACUUM (ANALYZE) "sales"."orders";',
    ]);
    expect(maintenanceStatements('postgres', 'statistics', table)).toEqual([
      'ANALYZE "sales"."orders";',
    ]);
  });

  it('vacuums and analyzes the whole database', () => {
    expect(maintenanceStatements('postgres', 'vacuum', { scope: 'database' })).toEqual([
      'VACUUM (ANALYZE);',
    ]);
    expect(maintenanceStatements('postgres', 'statistics', { scope: 'database' })).toEqual([
      'ANALYZE;',
    ]);
  });

  it('has no reorganize and no online switch', () => {
    expect(() => maintenanceStatements('postgres', 'reorganize', index)).toThrow();
    expect(() => maintenanceStatements('postgres', 'rebuild', index, { online: true })).toThrow(
      /SQL Server/,
    );
  });

  it('turns on exact numbers with pgstattuple', () => {
    expect(PRECISE_STATS_STATEMENT).toBe('CREATE EXTENSION IF NOT EXISTS pgstattuple;');
  });
});

describe('maintenanceStatements on MySQL and MariaDB', () => {
  it('optimizes and analyzes a table', () => {
    for (const engine of ['mysql', 'mariadb'] as const) {
      expect(maintenanceStatements(engine, 'rebuild', { scope: 'table', table: orders })).toEqual([
        'OPTIMIZE TABLE `shop`.`orders`;',
      ]);
      expect(
        maintenanceStatements(engine, 'statistics', { scope: 'table', table: orders }),
      ).toEqual(['ANALYZE TABLE `shop`.`orders`;']);
    }
  });

  it('cannot rebuild one index on its own', () => {
    expect(() =>
      maintenanceStatements('mysql', 'rebuild', { scope: 'index', table: orders, index: 'ix' }),
    ).toThrow(/table/);
  });
});

describe('maintenanceStatements on SQLite', () => {
  const table = { name: 'orders' };

  it('reindexes an index or a table', () => {
    expect(
      maintenanceStatements('sqlite', 'rebuild', { scope: 'index', table, index: 'orders_ix' }),
    ).toEqual(['REINDEX "orders_ix";']);
    expect(maintenanceStatements('sqlite', 'rebuild', { scope: 'table', table })).toEqual([
      'REINDEX "orders";',
    ]);
  });

  it('vacuums and analyzes the file', () => {
    expect(maintenanceStatements('sqlite', 'vacuum', { scope: 'database' })).toEqual(['VACUUM;']);
    expect(maintenanceStatements('sqlite', 'statistics', { scope: 'database' })).toEqual([
      'ANALYZE;',
    ]);
    expect(maintenanceStatements('sqlite', 'statistics', { scope: 'table', table })).toEqual([
      'ANALYZE "orders";',
    ]);
  });

  it('takes no options', () => {
    expect(() =>
      maintenanceStatements('sqlite', 'rebuild', { scope: 'table', table }, { fillFactor: 90 }),
    ).toThrow();
  });
});

describe('maintenanceActions', () => {
  it('lists what each engine can do to an index', () => {
    expect(maintenanceActions('mssql', 'index').map((one) => one.action)).toEqual([
      'reorganize',
      'rebuild',
      'statistics',
    ]);
    expect(maintenanceActions('postgres', 'index').map((one) => one.action)).toEqual(['rebuild']);
    expect(maintenanceActions('mysql', 'index')).toEqual([]);
    expect(maintenanceActions('sqlite', 'index').map((one) => one.action)).toEqual(['rebuild']);
  });

  it('lists what each engine can do to a table and to the database', () => {
    expect(maintenanceActions('mssql', 'table').map((one) => one.action)).toEqual([
      'reorganize',
      'rebuild',
      'statistics',
    ]);
    expect(maintenanceActions('mssql', 'heap').map((one) => one.action)).toEqual(['rebuild']);
    expect(maintenanceActions('postgres', 'table').map((one) => one.action)).toEqual([
      'vacuum',
      'rebuild',
      'statistics',
    ]);
    expect(maintenanceActions('mariadb', 'table').map((one) => one.action)).toEqual([
      'rebuild',
      'statistics',
    ]);
    expect(maintenanceActions('sqlite', 'database').map((one) => one.action)).toEqual([
      'vacuum',
      'statistics',
    ]);
    expect(maintenanceActions('redis', 'table')).toEqual([]);
  });

  it('names actions in the words of the engine', () => {
    const label = (engine: Parameters<typeof maintenanceActions>[0], scope: 'index' | 'table') =>
      maintenanceActions(engine, scope).find((one) => one.action === 'rebuild')?.label;
    expect(label('mssql', 'index')).toBe('Rebuild');
    expect(label('postgres', 'index')).toBe('Reindex');
    expect(label('mysql', 'table')).toBe('Optimize');
  });

  it('every listed action builds statements', () => {
    const engines = ['mssql', 'postgres', 'mysql', 'mariadb', 'sqlite'] as const;
    const scopes = ['index', 'table', 'heap', 'database'] as const;
    for (const engine of engines) {
      for (const scope of scopes) {
        for (const one of maintenanceActions(engine, scope)) {
          const target =
            scope === 'database'
              ? ({ scope } as const)
              : scope === 'index'
                ? ({ scope, table: orders, index: 'ix' } as const)
                : ({ scope, table: orders } as const);
          expect(maintenanceStatements(engine, one.action, target).length).toBeGreaterThan(0);
        }
      }
    }
  });
});
