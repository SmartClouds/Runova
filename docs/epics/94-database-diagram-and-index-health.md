# E94 Database diagram and index health

Milestone: standalone (Deploy). Builds on E45, the database manager.

## Goal

A person connected to a SQL database in the Database section can:

- see how its tables relate, as an entity relationship diagram drawn from the foreign keys
- see how fragmented each index is (or how bloated, or how much free space a table holds)
- rebuild clustered and nonclustered indexes on SQL Server, and do each other SQL engine's own
  clean-up, after seeing the statements

Engines: PostgreSQL, MySQL, MariaDB, SQL Server and SQLite. MongoDB, Redis and Cassandra have
neither, and show no button for them (`diagram` and `maintenance` in `DbCapabilities`).

## Design

- **Pure rules in core (`packages/core/src/database/`).**
  - `maintenance.ts`: what a measured number means per engine (`maintenanceAdvice`), what each
    engine can do to an index, a heap, a table or the database (`maintenanceActions`), and the
    statements for it (`maintenanceStatements`), with the options each engine takes.
  - `erdLayout.ts`: lays the diagram out without a graph library. Related tables go in layers by
    key direction (a table sits right of what it points at), barycenter sweeps cut crossings, and
    groups are packed on shelves. It also routes the line between two column rows.
- **One query per kind of fact.** Each driver reads tables, columns and foreign keys for a whole
  database or schema in a few catalog queries (`schemaGraph`), never one describe per table. The
  service cuts a diagram at 400 tables. Health (`health`) reads:
  - SQL Server: `sys.dm_db_index_physical_stats`, LIMITED for a fast scan and SAMPLED for a
    thorough one, plus `sys.dm_db_partition_stats` and the edition for online rebuilds.
  - PostgreSQL: bloat estimated from planner statistics, or read exactly with `pgstatindex` on a
    thorough scan once `pgstattuple` is installed (the UI offers to add it). Dead rows and the last
    vacuum come from `pg_stat_user_tables`.
  - MySQL and MariaDB: free space per table from `information_schema.TABLES`. Index sizes come
    from `mysql.innodb_index_stats` when the user can read it.
  - SQLite: page and free-page counts, and per-index sizes from `dbstat` where it is compiled in.
- **Nothing runs unseen.** Maintenance goes through `RunStatementsDialog` (now with an options
  slot), so the statements are shown with the chosen options before anything runs. A read-only
  connection shows the numbers and disables every action.
- **The diagram is our own SVG.** Cards and crow's foot lines, pan, zoom, drag, search, keys only,
  a details panel, and SVG or PNG export with the theme's colours written onto the copy. Dragged
  positions are kept on the workbench tab.

## Tasks

1. Core rules: capabilities, advice, actions and statements, the layout. Done.
2. IPC `database:schemaGraph` and `database:health`, the service, and the driver queries for the
   five engines. Done.
3. The Diagram tab, the Health tab with the maintenance dialog, and the buttons in the header, the
   tree and a table's structure. Done.
4. The help article, the integration tests and the e2e. Done.

## Verified

- Core rules have unit tests, inside the database folder's 95% line and 90% branch threshold.
- Driver mapping has unit tests with fake clients for PostgreSQL, MySQL and SQL Server, and the
  SQLite driver ran against a real file (foreign keys, free pages, VACUUM).
- PostgreSQL 17 in Docker (`sql.int.test.ts`): the diagram's foreign keys, both scans, REINDEX
  CONCURRENTLY with a fill factor, VACUUM, ANALYZE, and exact numbers after adding pgstattuple.
- SQL Server 2025 Developer edition: the exact T-SQL the diagram, both health scans and every
  maintenance statement send ran through `sqlcmd` on tables in tempdb. It read clustered,
  nonclustered and heap fragmentation, rebuilt with FILLFACTOR and SORT_IN_TEMPDB, reorganized,
  rebuilt a heap and updated statistics.
- The e2e (`apps/desktop/e2e/database.e2e.ts`) draws two related tables, opens the details panel
  and reindexes the primary key from Index health against a real Postgres container.

## Known limits

- MySQL, MariaDB and SQL Server integration tests are written (`sql.int.test.ts`,
  `mssqlCassandra.int.test.ts`) but did not run here: Docker could not reach the registry for
  their images. They run in CI's unit tests wherever the runner has Docker.
- MySQL and MariaDB do not measure fragmentation per index, so their advice is per table
  (OPTIMIZE TABLE rebuilds the table with all its indexes).
- PostgreSQL bloat without pgstattuple is an estimate, and an index the planner has no statistics
  for yet shows no number until ANALYZE runs.
- A diagram shows at most 400 tables; the diagram of one schema shows the rest.
