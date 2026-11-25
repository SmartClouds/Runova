# Writing style

When writing any text in this project (comments, docs, commit messages, UI copy, PR descriptions), write it the way a person would, not in the telltale style of AI-generated text. Never use the em dash (—) character. Use a comma, a period, parentheses, or just rephrase the sentence instead.

# Object mapping in .NET code

Every .NET project in this repo (apps/server-core, apps/website/api and anything added later) maps objects with Riok.Mapperly and nothing else.

- Mapping means turning an object of one type into another type by copying or converting its members: an entity or record into a DTO, `*Info` or response, a request into an entity, a contract message into a domain model, an EF query projected into DTOs, and so on.
- Write it as a `[Mapper]` static partial class (one per resource or area) with `RequiredMappingStrategy = RequiredMappingStrategy.Target`, so a target member with no source fails the build.
- No hand-written `ToDto`, `ToInfo`, `ToModel` or `ToRow` methods that copy members one by one, and no inline `new FooDto(row.A, row.B, ...)` copies in endpoints or services. No AutoMapper, Mapster, TinyMapper or any other mapping library.
- Values the source does not hold (the current time, a URL, a count from another query, a flag computed by the caller) are extra parameters of the mapper method. Conversions go in small private methods inside the mapper (`[MapProperty(..., Use = ...)]`, `[MapPropertyFromSource]` or a user-implemented type conversion). EF projections use a Mapperly `IQueryable<T>` projection method so the query still runs in SQL.
- Building a DTO from loose values that do not come from one source object (a token and its expiry, counts, parsed command output, test fakes) is not mapping and stays a plain constructor call.
- Mapping to DTOs never copies secrets (password hashes, security stamps, tokens, secret hashes, signing keys). Every mapper has a unit test.

# Raw SQL and SQL injection

This applies to every language in the repo (C#, TypeScript, Rust, PHP, Kotlin, Swift and anything added later). Raw SQL means any SQL text we write ourselves instead of letting an ORM or query builder generate it: EF Core `FromSql`, `SqlQuery`, `ExecuteSql*`, `DbCommand.CommandText`, `NpgsqlCommand`, SQLite `prepare`/`exec`/`run`, rusqlite `execute`/`query_row`, `$wpdb->query`/`get_results`, and so on.

- Values never get concatenated or interpolated into SQL text. Pass them as parameters: `?`/`$1`/`@name` placeholders, `$wpdb->prepare`, or EF's `FormattableString` overloads (`FromSql($"...")`, `ExecuteSqlAsync($"...")`, `SqlQuery<T>($"...")`), which turn each hole into a parameter. `FromSqlRaw`, `ExecuteSqlRaw` and `SqlQueryRaw` only take constant strings, never a string built at runtime from a value.
- Identifiers (table, column, schema, index names) and keywords (`ASC`/`DESC`) cannot be parameters. When one has to vary, pick it from a fixed allowlist in code, or quote it with the driver's identifier escaping (doubling the quote character) and reject anything that fails validation. Never pass a user-supplied name through unchecked.
- `LIKE` patterns escape `%`, `_` and the escape character before they go into the parameter, and the query names the `ESCAPE` character.
- Every raw SQL site that takes any value from outside the code (user input, a request, a file, the network, another process, even an id read from our own database) has a test that sends hostile input through it, for example `'; DROP TABLE x; --`, `' OR '1'='1`, a quote-doubling name for identifiers, and `%`/`_` for `LIKE`. The test asserts the input was treated as data: it is stored and read back verbatim, it matches only the rows it literally names, and the other rows and tables are untouched.
- SQL that is a constant with no outside value at all (`SELECT 1`, `PRAGMA journal_mode=WAL`) has no injection surface and needs no injection test, but stays constant. The moment a value goes in, it needs the parameter and the test.
- The database client feature in the desktop app runs SQL the user typed on purpose. That is by design, but the SQL the app builds around it (browsing a table, paging, sorting, filtering, editing a row, schema lookups) follows every rule above.
