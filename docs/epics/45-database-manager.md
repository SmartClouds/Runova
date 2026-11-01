# E45 Database manager

Milestone: standalone (Deploy). Depends on: E05 (servers and the SSH pool), the Deploy containers
section, the App Store catalog (database templates), the local Docker page, and the AI providers in
`main/ipc/ai.ts`.

## Goal

A person manages the databases they run without leaving Runova and without setting anything up. A
server's **Database** section lists every database container on it (and the App Store installs) as
a card with one **Connect** button. Runova reads the engine from the image, the sign-in from the
container's environment, opens the SSH tunnel and connects. The same works for local Docker, and a
pasted URL adds any other database (a cloud one, a SQLite file).

Once connected, the person can:

- browse databases, schemas, tables, collections and keys
- read and edit rows in a grid
- run queries in an editor that knows the engine
- design tables
- change server settings
- manage users and what they can reach
- back up and restore with the engine's own tools
- ask the AI, which writes, explains and fixes queries; anything that changes data waits for the user's approval

Engines: PostgreSQL, MySQL, MariaDB, MongoDB, Redis, SQLite, Cassandra (and Scylla), SQL Server.

## Design

- **Pure rules in core (`packages/core/src/database/`).**
  - `engines.ts`: what each engine can do, so the UI never shows a dead button.
  - `detectContainer.ts`: image, env and ports become an engine, a port and a sign-in.
  - `connectionUrl.ts`: a pasted URL becomes a connection.
  - `classify.ts`: whether a query reads, writes, changes the schema or administers. It errs toward "write".
- **Credentials stay in main.** They come from the container's env (`DeployDocker.revealEnv` on a server, `docker inspect` locally), are sealed with the Servers vault, and never cross to the renderer.
- **Reaching a database.**
  - A database on a server is reached over the SSH pool (`openStream`) through a local listener on 127.0.0.1, so every driver gets a plain host and port.
  - A local container uses its published port, or a short-lived socat helper on its network when nothing is published.
- **One driver interface in main**, one adapter per engine (`pg`, `mysql2`, `mongodb`, `ioredis`, `better-sqlite3`, `cassandra-driver`, `mssql`).
- **The AI sees the schema, not the rows.** Rows go in only when the person turns sample rows on. An answer the classifier reads as a read can run at once, inside a read-only transaction where the engine has one. Anything else is shown for approval.

## Tasks

1. Core rules: engines, container detection, connection URLs, the query classifier.
2. Reaching a database: the SSH port-forward listener, local Docker and the socat helper.
3. Saved connections sealed with the vault; IPC for connections, discovery and connect.
4. Drivers for PostgreSQL and MySQL/MariaDB: browse, read rows, run queries.
5. The Database section: the connect cards, the object tree, the data grid, the query editor.
6. The table designer and row editing.
7. Settings and users.
8. Backup and restore.
9. The AI panel and the approval flow.
10. MongoDB.
11. Redis and SQLite.
12. Cassandra and SQL Server.
13. "Open database" from containers and the local Docker page, the help article, e2e.

## Verified

- Core rules (`packages/core/src/database/`) have unit tests with a 95% line and 90% branch
  threshold: container detection, connection URLs, the query classifier, SQL building, table and
  row-edit SQL, user and setting statements, backup scripts, the AI prompt, the mongosh parser and
  Redis argument splitting.
- Drivers ran against real PostgreSQL 17, MariaDB 11 and Redis 8 containers and a real SQLite
  file: browsing, structure, paging, multi-statement queries, row caps, read-only runs, cancel,
  all-or-nothing row edits, users with read access, and backup and restore round trips with
  pg_dump and mariadb-dump.
- The e2e test (`apps/desktop/e2e/database.e2e.ts`) connects to a real Postgres container in one
  click, creates and fills a table from the editor, browses and filters it, and confirms a
  destructive query.

## Known limits

- MySQL 8, MongoDB, SQL Server and Cassandra integration tests are written but were not run on
  the development machine, which could not pull their images; they run where Docker can pull.
- Cassandra connects with the local data center `datacenter1`, which the official Cassandra and
  Scylla images use. A cluster with another data center name is not reachable yet.
- SQLite queries run in the main process, so a very slow query holds the app until it ends.
- A local container with no published port on Docker Desktop needs the `alpine/socat` image.
- SQLite and Redis restores are done by hand (the Backups tab says how).
