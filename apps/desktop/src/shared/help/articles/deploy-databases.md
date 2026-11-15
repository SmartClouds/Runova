---
title: Databases
category: Deploy
order: 64
summary: Connect in one click to the databases in your containers, on a server or on this computer, or to any database by URL. Browse tables, edit rows, run queries, design tables, see them in a diagram, check index health and rebuild indexes, manage users and settings, back up and restore, and ask the AI for queries.
keywords: database, postgres, postgresql, mysql, mariadb, mongodb, mongo, redis, sqlite, cassandra, scylla, sql server, mssql, query, table, sql editor, backup, restore, pg_dump, mysqldump, mongodump, users, grants, access, settings, ai, connect, container, erd, diagram, entity relationship, foreign key, index, fragmentation, rebuild, reorganize, clustered, nonclustered, reindex, vacuum, optimize, bloat
route: /deploy?databases=1
---

The Database section lets you work with your databases without another tool. Runova finds the database containers on a server (and in Docker on this computer), reads how to sign in from each container, and connects in one click. Once connected you can browse, read and edit rows, run queries, design tables, see how tables relate in a diagram, check index health and rebuild indexes, manage users and settings, back up and restore, and ask the AI to write queries for you.

It works with PostgreSQL, MySQL, MariaDB, MongoDB, Redis, SQLite, Cassandra (and Scylla) and SQL Server.

## Where to find it

- **A server's databases:** open **Deploy**, pick the server, and click **Database** in its section strip.
- **This computer's databases:** click **Databases on this computer** under the server rail. It lists the database containers in Docker here and the connections you added by hand. The address is `/deploy?databases=1`.
- **From a container:** on a server's **Containers** section, open a database container's menu and click **Open database**. On the **Docker** page, click the database button on its row. Either way Runova opens the Database section and connects to it.

## Connect in one click

Each database container shows as a card with its engine, its image, its project and whether it is running. Click **Connect**:

1. Runova reads the engine from the image and the sign-in from the container's environment (for example `POSTGRES_PASSWORD` or `MYSQL_ROOT_PASSWORD`).
2. For a container on a server, the connection travels inside the server's SSH connection, so the database port never has to be open to the internet. For a container here, Runova uses its published port, or starts a small helper container when nothing is published.
3. The connection is saved, so the next time it is one click again.

A server asks you to confirm your password before it shows a container's environment, the same as on the Containers section. If you told Runova to remember that password, it is used without asking. Only Admins of a server can do this.

If the container does not say what its password is, Runova asks for that password and nothing else. Passwords are sealed on this computer the same way your server passwords are, and never shown again.

## Add a connection by hand

For a database Runova cannot find (a cloud database, say), click **Add a connection** and paste its connection URL, like `postgres://user:password@host:5432/shop`. The engine, host, port, user, password and database all come from the URL. A `sqlite://` URL opens a SQLite file on this computer.

On a server's Database section, **Reach it through** the server is on by default. Use it for a database only the server can reach, like one installed on the server itself at `127.0.0.1`.

Turn on **Read-only** for a database you only want to look at. Anything that changes data then asks again before it runs, and the AI can only read.

## Browse and edit rows

The left side lists databases, schemas and tables (collections for MongoDB, keys for Redis). A level loads when you open it. Click a table to see its rows. Hover a table for buttons that open its structure or a ready query.

In the grid:

- Click a column heading to sort by it.
- Type a condition in the filter box, like `total > 10 AND status = 'paid'`, and press Enter. For MongoDB, type a filter document like `{ status: "paid" }`.
- Step through pages with the arrows, and save the page as CSV with the download button.
- Double-click a cell to change it. **NULL** sets it to NULL in one click.
- Hover a row number to mark the row for deletion, and use **Add row** to add one.

Nothing is written while you edit. A bar counts your changes; click **Review and apply** to see the exact statements, then **Apply changes**. They run in one transaction, so if one fails, none of them is kept. Tables without a primary key, and read-only connections, cannot be edited in the grid.

## Run queries

Click **New query** for an editor that knows your database's language. Press **Run** or Ctrl+Enter. Each statement gets its own result, the last one shown first, with how long it took. **Stop** cancels a long query. Results are capped so a huge table cannot fill the app's memory; the footer says when there were more rows.

A query that drops, truncates or changes every row waits for **Run anyway** before it runs. Every query Runova reads as a read runs inside a read-only transaction where the engine has one, so a write hidden in it is refused.

For MongoDB, type commands the way mongosh takes them, like `db.orders.find({ total: { $gt: 10 } }).sort({ total: -1 })`. They are read, not run as JavaScript, so functions and variables are not allowed. For Redis, type commands like `GET key` or `HGETALL user:1`, one per line.

## Design tables

Click **New table** (or the plus button on a database or schema) to make a table from rows of columns: name, type, whether it can be empty, the primary key, counting up by itself, and a default. The statement that runs is shown underneath as you type. For MongoDB it makes a collection with a schema validator.

On a table's structure tab, **Edit columns** renames, retypes, adds or removes columns the same way. SQLite and Cassandra cannot change a column's type in place, so the designer says so.

## See how tables relate

Click **Diagram** at the top to draw the database's tables as an entity relationship diagram. To draw one schema, hover it in the tree and click its diagram button. It works with PostgreSQL, MySQL, MariaDB, SQL Server and SQLite.

- Each table is a card with its columns. **PK** marks the primary key and **FK** a column that points at another table.
- Each foreign key is a line. The fork end sits on the table that holds the key (many rows), the bar end on the table it points at (one row). A dashed line with a ring means the key can be empty.
- Hover a line for the key's name and what happens on delete and update.
- A table in another schema that a key points at shows as a faded card.

Hover or click a table to light up the tables it is linked to. Clicking also opens a panel with its keys and columns, and links to the tables on the other end. Double-click a table, or press Enter on it, to open its rows.

To move around:

- Drag the background, scroll, or use the arrow keys.
- Hold Ctrl and scroll (or pinch) to zoom. The percent button fits the whole diagram on screen.
- Drag a table to move it. Runova remembers where you put it until you click **Re-arrange**.
- **Find a table** fades everything else, and Enter jumps to the first match.
- **Keys only** hides the columns that are not keys, for a compact picture of a big schema.

**SVG** and **PNG** save the whole diagram as a picture. A database with more than 400 tables shows the first 400 and says so; open the diagram of one schema to see the rest.

## Index health and maintenance

The gauge button at the top (or the one on a database or schema in the tree) opens **Index health**. It measures how fragmented each index is and how much free space each table holds, and offers each engine's own way to tidy up. It works with PostgreSQL, MySQL, MariaDB, SQL Server and SQLite.

Every index gets a bar and an advice chip:

| Engine | What is measured | Advice |
| --- | --- | --- |
| SQL Server | Fragmentation of clustered and nonclustered indexes and heaps, from `sys.dm_db_index_physical_stats` | Under 5%: healthy. 5% to 30%: reorganize. Over 30%: rebuild. Indexes under 1,000 pages are too small to matter. |
| PostgreSQL | Index bloat, and dead rows per table | Reindex at 30% bloat or more, vacuum a table with many dead rows. Indexes under 8 MB are too small to matter. |
| MySQL and MariaDB | Free space per table (`DATA_FREE`) | Optimize a table over 10 MB that is 10% or more free space. |
| SQLite | Empty space in each index and free pages in the file | Reindex, or vacuum the file when 10% or more of it is free. |

Use **Fast** or **Thorough** on SQL Server and PostgreSQL. A fast scan on SQL Server reads only the upper levels of each index (`LIMITED`). A thorough scan samples the leaves too (`SAMPLED`), which takes longer on a big database. On PostgreSQL, bloat is estimated from the planner's statistics. With the `pgstattuple` extension, a thorough scan reads it exactly. Runova offers to add the extension when it is available.

**Needs attention** lists only what the advice says to fix. **Clustered** and **Nonclustered** show one kind on SQL Server (and on MySQL, where the primary key is the clustered index).

To fix something:

- Click **Reorganize**, **Rebuild**, **Reindex**, **Optimize**, **Vacuum** or **Analyze** on a row.
- Or tick the indexes you want and click **Fix**. Each one gets what its numbers call for.

Before anything runs, Runova shows the statements, with options where the engine has them:

- **Online** (SQL Server): the table stays usable during a rebuild. It needs the Enterprise or Developer edition, or Azure SQL. Without it, the table is locked until the rebuild ends.
- **Concurrently** (PostgreSQL, on by default): writes carry on during a reindex.
- **Fill factor**: how full to pack each page. Lower leaves room for new rows.
- **Sort in tempdb** (SQL Server).

When it is done, the numbers are measured again. On a read-only connection the numbers show, but nothing can be rebuilt. A table's **Structure** tab also links to its database's index health.

## Users and access

The users button opens **Users**: who can sign in, and what each can reach. Access is a level per database:

| Level | What it allows |
| --- | --- |
| None | Cannot see the database |
| Read | Can read every table and change nothing |
| Write | Can read, add, change and delete rows |
| Admin | Can do anything, including changing tables |

**New user** fills in a strong password for you. **Access** changes a user's level in one database, the key button sets a new password, and the trash button removes the user. Every change shows its statements first, with the password starred out.

## Server settings

The settings button opens **Settings**: the server's settings with a search box. Settings that only take effect after a restart are marked. Click the pencil to change one; the statement that keeps it across restarts is shown before it runs. Cassandra and SQLite settings are shown but cannot be changed here.

## Back up and restore

The backup button opens **Backups**. **Back up now** runs the database's own tool where the database lives: `pg_dump`, `mariadb-dump` or `mysqldump`, `mongodump`, `redis-cli`, `sqlcmd` or `cqlsh`, inside the container (over SSH for a server). The backup file is saved on this computer. The password goes to the tool on its input, never on a command line. A backup that fails leaves no file behind.

**Restore** replaces what is in the database with a backup, so it asks you to type the database's name first. **Restore from a file** picks any backup file on this computer.

Some engines have limits:

- Cassandra backups keep the schema only.
- Redis loads a snapshot only when it starts. To restore one, copy the file into its data folder as `dump.rdb` and restart the container.
- A SQLite file is copied as a consistent snapshot. To restore it, disconnect and copy the backup over the database file.
- Backups need the database in a container or on a server. For a connection added by URL, export what you need with a query.

## Ask AI

Click **Ask AI** to open a panel beside the tables. Ask in plain words, like "orders over 100 from last week, newest first", and the AI writes the query with a short explanation. It uses the API provider picked under **Prompt Builder writes with** in **Settings**, **AI**, **Providers** (see [AI providers](ai-providers.md)).

- The AI sees the tables and columns of the database you are in. It sees rows only when you turn on **Let the AI see a few sample rows**.
- **Run** runs a query that only reads right away, and shows the rows in the panel. A query that changes the database waits until you click **Review done, run it**.
- **Open in editor** puts the query in a new query tab.
- When a query fails, **Fix with AI** sends the query and its error to the panel.

## Troubleshooting

- **"Docker on this computer is not running":** start Docker Desktop, then click **Look again**.
- **A server shows no containers:** the server needs Runova's server core for its containers to be listed. You can still add a connection by hand and reach it through the server.
- **A password is turned down:** Runova asks for it again; the new one replaces the saved one.
- **"Reading fragmentation needs the VIEW DATABASE STATE permission":** SQL Server shows index fragmentation only to users with that permission (VIEW DATABASE PERFORMANCE STATE on SQL Server 2022). Connect as an administrator, or ask one to grant it.
- **MySQL index sizes are missing:** they come from `mysql.innodb_index_stats`, which the signed-in user cannot read. Everything else still shows.
- **A local container has no published port:** Runova starts a short-lived `alpine/socat` helper on its network. It needs that image, so the first connect may take a moment while Docker pulls it.
