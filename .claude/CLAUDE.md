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
