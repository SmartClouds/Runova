using System.Globalization;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Runova.Website.Api.Billing;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Accounts;
using Runova.Website.Core.Problems;
using Runova.Website.Data;
using Runova.Website.Data.Accounts;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Accounts;

public sealed record SyncPolicyDto(bool Servers, bool Environments, bool Everything);

public sealed record SyncScopeDto(
    long Id,
    string Kind,
    long? TeamId,
    string Name,
    bool CanWrite,
    bool CanManage,
    long LatestRevision,
    int Epoch,
    int? KeyVersion,
    SyncPolicyDto Policy);

public sealed record SyncScopeListDto(IReadOnlyList<SyncScopeDto> Items);

public sealed record SyncRecordDto(
    string Collection,
    string ItemId,
    long Revision,
    bool Deleted,
    string Encryption,
    int? KeyVersion,
    string? Payload,
    DateTimeOffset UpdatedAt);

public sealed record SyncChangesDto(IReadOnlyList<SyncRecordDto> Records, long Next, bool More);

public sealed record SyncPushRecord(string? Collection, string? ItemId, long BaseRevision, bool Deleted, string? Encryption, int? KeyVersion, string? Payload);

public sealed record SyncPushRequest(IReadOnlyList<SyncPushRecord>? Records);

public sealed record SyncAcceptedDto(string Collection, string ItemId, long Revision);

public sealed record SyncPushResultDto(IReadOnlyList<SyncAcceptedDto> Accepted, IReadOnlyList<SyncRecordDto> Conflicts);

public sealed record SyncUsageDto(int Records, long Bytes, long QuotaBytes, IReadOnlyDictionary<string, int> Collections);

public sealed record KeyEnvelopeRequest(int Version, JsonElement Envelope);

public sealed record KeyEnvelopeDto(int Version, JsonElement Envelope, DateTimeOffset? SetAt);

/// <summary>Sync limits, from <c>Sync:*</c>.</summary>
internal sealed class SyncOptions
{
    /// <summary>What one scope may hold, in bytes of payload. 200 MB unless set.</summary>
    public long QuotaBytes { get; set; } = 200L * 1024 * 1024;

    /// <summary>Pushes a minute per account.</summary>
    public int PushesPerMinute { get; set; } = 120;
}

/// <summary>What a signed-in account may do with a scope.</summary>
internal sealed record ScopeAccess(SyncScope Scope, string Name, bool CanWrite, bool CanManage);

/// <summary>
/// The scopes an account can see: its own (made on first use), and each team it is in (E48.7).
/// A scope it can not see is "not found", never "forbidden", so ids tell a stranger nothing.
/// </summary>
internal sealed class SyncAccess(AppDbContext db, TimeProvider time)
{
    public const string PersonalName = "Personal";

    public async Task<SyncScope> PersonalAsync(long userId)
    {
        if (await db.SyncScopes.SingleOrDefaultAsync(s => s.Kind == SyncScopeKinds.Personal && s.UserId == userId) is { } existing)
        {
            return existing;
        }

        var scope = new SyncScope { Kind = SyncScopeKinds.Personal, UserId = userId, CreatedAt = time.GetUtcNow() };
        db.SyncScopes.Add(scope);
        try
        {
            await db.SaveChangesAsync();
            return scope;
        }
        catch (DbUpdateException e) when (e.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            // Two first requests at once: the other one made it.
            db.Entry(scope).State = EntityState.Detached;
            return await db.SyncScopes.SingleAsync(s => s.Kind == SyncScopeKinds.Personal && s.UserId == userId);
        }
    }

    public async Task<IReadOnlyList<ScopeAccess>> ListAsync(long userId)
    {
        var personal = await PersonalAsync(userId);
        var teams = await db.TeamMembers.Where(m => m.UserId == userId)
            .Join(db.Teams, m => m.TeamId, t => t.Id, (m, t) => new { m.Role, t.Name, t.Id })
            .Join(db.SyncScopes, x => x.Id, s => s.TeamId, (x, s) => new { x.Role, x.Name, Scope = s })
            .OrderBy(x => x.Name)
            .ToListAsync();
        return
        [
            new ScopeAccess(personal, PersonalName, CanWrite: true, CanManage: true),
            .. teams.Select(t => new ScopeAccess(t.Scope, t.Name, TeamRoles.CanWrite(t.Role), TeamRoles.CanManage(t.Role))),
        ];
    }

    public async Task<ScopeAccess?> FindAsync(long userId, long scopeId) =>
        (await ListAsync(userId)).FirstOrDefault(a => a.Scope.Id == scopeId);
}

/// <summary>
/// The sync store (E48.6). A scope holds the newest record of each item; every push takes fresh
/// revisions from the scope's counter under its row lock, and a record whose base revision is not
/// the stored one comes back as a conflict with the stored copy. Payloads are kept exactly as
/// pushed and are never read, logged or sent anywhere else. End-to-end keys are kept wrapped.
/// </summary>
internal static partial class SyncEndpoints
{
    public const int MaxBatch = 100;
    public const int MaxPayloadBytes = 1024 * 1024;
    public const int MaxEnvelopeBytes = 16 * 1024;
    public const int DefaultLimit = 500;
    public const int MaxLimit = 1000;
    public const string RateLimitPolicy = "sync-push";

    [GeneratedRegex("^[a-z][a-z0-9-]{1,39}$", RegexOptions.CultureInvariant)]
    private static partial Regex CollectionName();

    [GeneratedRegex("^[A-Za-z0-9_.:-]{1,64}$", RegexOptions.CultureInvariant)]
    private static partial Regex ItemId();

    public static IServiceCollection AddWebsiteSync(this IServiceCollection services)
    {
        services.AddOptions<SyncOptions>().BindConfiguration("Sync");
        services.AddScoped<SyncAccess>();
        services.AddScoped<EncryptionPreferences>();
        services.AddOptions<RateLimiterOptions>().Configure<Microsoft.Extensions.Options.IOptions<SyncOptions>>((options, sync) =>
            options.AddPolicy(RateLimitPolicy, http =>
                http.User.FindFirstValue(ClaimTypes.NameIdentifier) is { } user
                    ? RateLimitPartition.GetTokenBucketLimiter(user, _ => new TokenBucketRateLimiterOptions
                    {
                        TokenLimit = sync.Value.PushesPerMinute,
                        TokensPerPeriod = sync.Value.PushesPerMinute,
                        ReplenishmentPeriod = TimeSpan.FromMinutes(1),
                        QueueLimit = 0,
                        AutoReplenishment = true,
                    })
                    : RateLimitPartition.GetNoLimiter("anonymous")));
        return services;
    }

    public static RouteGroupBuilder MapSync(this RouteGroupBuilder api)
    {
        var scopes = api.MapGroup("/sync-scopes").RequireAuthorization(Policies.Account);
        scopes.MapGet("", ListAsync);
        scopes.MapPatch("/{id:long}", PatchAsync).Accepts<SyncPolicyDto>("application/merge-patch+json");
        scopes.MapGet("/{id:long}/changes", ChangesAsync);
        scopes.MapPost("/{id:long}/records", PushAsync)
            .RequireRateLimiting(RateLimitPolicy)
            .WithMetadata(new RequestSizeLimitAttribute(16 * 1024 * 1024));
        scopes.MapDelete("/{id:long}/records", WipeAsync);
        scopes.MapGet("/{id:long}/usage", UsageAsync);
        scopes.MapGet("/{id:long}/keys/current", GetKeyAsync);
        scopes.MapPut("/{id:long}/keys/current", PutKeyAsync);
        scopes.MapDelete("/{id:long}/keys/current", ResetKeyAsync);
        return api;
    }

    private static ProblemHttpResult NotFound() => ApiProblems.Of(ProblemTypes.NotFound, "There is no such sync scope for this account.");

    private static ProblemHttpResult NotManager() =>
        ApiProblems.Of(ProblemTypes.Forbidden, "Only the team's Owners and Admins can change this.");

    private static long UserId(HttpContext http) =>
        long.Parse(http.User.FindFirstValue(ClaimTypes.NameIdentifier)!, CultureInfo.InvariantCulture);

    private static async Task<Ok<SyncScopeListDto>> ListAsync(HttpContext http, SyncAccess access)
    {
        var scopes = await access.ListAsync(UserId(http));
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(new SyncScopeListDto([.. scopes.Select(SyncMapper.ToDto)]));
    }

    private static async Task<Results<Ok<SyncScopeDto>, ValidationProblem, ProblemHttpResult>> PatchAsync(
        long id, HttpContext http, SyncAccess access, AppDbContext db, ActivityLog activity, Entitlements entitlements, EncryptionPreferences preferences)
    {
        if (await access.FindAsync(UserId(http), id) is not { } found)
        {
            return NotFound();
        }

        if (!found.CanManage)
        {
            return NotManager();
        }

        JsonObject? body;
        try
        {
            body = await JsonNode.ParseAsync(http.Request.Body, cancellationToken: http.RequestAborted) as JsonObject;
        }
        catch (JsonException)
        {
            body = null;
        }

        if (body is null || body.Any(p => p.Key != "policy") || body["policy"] is not JsonObject policy)
        {
            return ApiProblems.Invalid("policy", "Send { \"policy\": { \"servers\", \"environments\", \"everything\" } }.");
        }

        var wasSealing = found.Scope.EncryptEverything;
        foreach (var (name, value) in policy)
        {
            if (value is not JsonValue flag || !flag.TryGetValue<bool>(out var on))
            {
                return ApiProblems.Invalid($"policy.{name}", "Each policy field is true or false.");
            }

            switch (name)
            {
                case "servers": found.Scope.EncryptServers = on; break;
                case "environments": found.Scope.EncryptEnvironments = on; break;
                case "everything": found.Scope.EncryptEverything = on; break;
                default: return ApiProblems.Invalid($"policy.{name}", "The policy has servers, environments and everything.");
            }
        }

        // Only sealing everything is a plan feature, and only the step from off to on is refused.
        if (!wasSealing && found.Scope.EncryptEverything && await entitlements.ForScopeAsync(id, http.RequestAborted) is { EncryptedItems: false } entitlement)
        {
            return EncryptionProblems.PlanRequired(entitlement);
        }

        await using var transaction = await db.Database.BeginTransactionAsync();

        // A real change only: a client sending its whole policy while lapsed must not clear the choice.
        if (wasSealing != found.Scope.EncryptEverything && found.Scope is { Kind: SyncScopeKinds.Personal, UserId: { } owner })
        {
            await preferences.SetAsync(owner, EncryptionItems.Sync, found.Scope.EncryptEverything, http.RequestAborted);
        }

        activity.Add(UserId(http), ActivityActions.SyncPolicyChanged, new { scopeId = id, policy = new { found.Scope.EncryptServers, found.Scope.EncryptEnvironments, found.Scope.EncryptEverything } }, found.Scope.TeamId);
        await db.SaveChangesAsync();
        await transaction.CommitAsync();
        return TypedResults.Ok(SyncMapper.ToDto(found));
    }

    private static async Task<Results<Ok<SyncChangesDto>, ValidationProblem, ProblemHttpResult>> ChangesAsync(
        long id, long? since, int? limit, HttpContext http, SyncAccess access, AppDbContext db)
    {
        if (await access.FindAsync(UserId(http), id) is null)
        {
            return NotFound();
        }

        if (since is < 0 || limit is < 1 or > MaxLimit)
        {
            return ApiProblems.Invalid("limit", $"since is 0 or more and limit is 1 to {MaxLimit}.");
        }

        var take = limit ?? DefaultLimit;
        var from = since ?? 0;
        var rows = await db.SyncRecords.AsNoTracking()
            .Where(r => r.ScopeId == id && r.Revision > from)
            .OrderBy(r => r.Revision)
            .Take(take + 1)
            .ToListAsync();
        var page = rows.Take(take).ToList();
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(new SyncChangesDto([.. page.Select(SyncMapper.ToDto)], page.Count > 0 ? page[^1].Revision : from, rows.Count > take));
    }

    private static async Task<Results<Ok<SyncPushResultDto>, ValidationProblem, ProblemHttpResult>> PushAsync(
        long id,
        SyncPushRequest request,
        HttpContext http,
        SyncAccess access,
        AppDbContext db,
        TimeProvider time,
        Microsoft.Extensions.Options.IOptions<SyncOptions> options)
    {
        var userId = UserId(http);
        if (await access.FindAsync(userId, id) is not { } found)
        {
            return NotFound();
        }

        if (!found.CanWrite)
        {
            return ApiProblems.Of(ProblemTypes.Forbidden, "A Viewer can read the team's items but not change them.");
        }

        var records = request.Records ?? [];
        if (records.Count is 0 or > MaxBatch)
        {
            return ApiProblems.Invalid("records", $"Send 1 to {MaxBatch} records.");
        }

        var errors = new Dictionary<string, string[]>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < records.Count; i++)
        {
            var r = records[i];
            if (r.Collection is null || !CollectionName().IsMatch(r.Collection))
            {
                errors[$"records[{i}].collection"] = ["A collection is 2 to 40 lowercase letters, digits and dashes."];
            }

            if (r.ItemId is null || !ItemId().IsMatch(r.ItemId))
            {
                errors[$"records[{i}].itemId"] = ["An item id is 1 to 64 letters, digits, dots, colons, dashes or underscores."];
            }

            if (!seen.Add($"{r.Collection}/{r.ItemId}"))
            {
                errors[$"records[{i}].itemId"] = ["Each item appears once in a push."];
            }

            if (r.BaseRevision < 0)
            {
                errors[$"records[{i}].baseRevision"] = ["baseRevision is 0 for a new item, or the revision it was based on."];
            }

            if (r.Encryption is not ("none" or "e2ee"))
            {
                errors[$"records[{i}].encryption"] = ["encryption is none or e2ee."];
            }

            if (r.Deleted != (r.Payload is null))
            {
                errors[$"records[{i}].payload"] = ["A delete has no payload, and anything else has one."];
            }
        }

        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        if (records.Any(r => r.Payload is not null && Encoding.UTF8.GetByteCount(r.Payload) > MaxPayloadBytes))
        {
            return ApiProblems.Of(ProblemTypes.PayloadTooLarge, "A synced item is over 1 MB. Large files do not sync.");
        }

        if (records.Any(r => r.Encryption == "e2ee" && !r.Deleted && r.KeyVersion != found.Scope.KeyVersion))
        {
            return ApiProblems.Of(ProblemTypes.Conflict, "The scope's key changed. Unlock it again and sync.");
        }

        await using var transaction = await db.Database.BeginTransactionAsync();

        // Locks the scope, so pushes to it run one after another and revisions never repeat.
        var latest = (await db.Database
            .SqlQuery<long>($"SELECT \"LatestRevision\" AS \"Value\" FROM \"SyncScopes\" WHERE \"Id\" = {id} FOR UPDATE")
            .ToListAsync())[0];

        var keys = records.Select(r => r.Collection + "/" + r.ItemId).ToList();
        var stored = await db.SyncRecords
            .Where(r => r.ScopeId == id && keys.Contains(r.Collection + "/" + r.ItemId))
            .ToDictionaryAsync(r => r.Collection + "/" + r.ItemId);

        var used = await db.SyncRecords.Where(r => r.ScopeId == id).SumAsync(r => (long?)r.Size) ?? 0;
        var accepted = new List<SyncAcceptedDto>();
        var conflicts = new List<SyncRecordDto>();
        var now = time.GetUtcNow();
        foreach (var r in records)
        {
            var key = r.Collection + "/" + r.ItemId;
            var current = stored.GetValueOrDefault(key);
            if (r.BaseRevision != (current?.Revision ?? 0))
            {
                if (current is not null)
                {
                    conflicts.Add(SyncMapper.ToDto(current));
                }

                continue;
            }

            var size = r.Payload is null ? 0 : Encoding.UTF8.GetByteCount(r.Payload);
            used += size - (current?.Size ?? 0);
            if (used > options.Value.QuotaBytes)
            {
                return ApiProblems.Of(ProblemTypes.PayloadTooLarge, "This scope is full. Delete items or wipe the cloud copy to make room.");
            }

            latest++;
            var record = current ?? new SyncRecord { ScopeId = id, Collection = r.Collection!, ItemId = r.ItemId! };
            record.Revision = latest;
            record.Deleted = r.Deleted;
            record.Encryption = r.Deleted ? "none" : r.Encryption!;
            record.KeyVersion = r.Deleted || r.Encryption == "none" ? null : r.KeyVersion;
            record.Payload = r.Payload;
            record.Size = size;
            record.UpdatedAt = now;
            record.UpdatedBy = userId;
            if (current is null)
            {
                db.SyncRecords.Add(record);
            }

            accepted.Add(SyncMapper.ToAcceptedDto(record));
        }

        await db.SaveChangesAsync();
        await db.SyncScopes.Where(s => s.Id == id).ExecuteUpdateAsync(s => s.SetProperty(x => x.LatestRevision, latest));
        await transaction.CommitAsync();
        return TypedResults.Ok(new SyncPushResultDto(accepted, conflicts));
    }

    private static async Task<Results<NoContent, ValidationProblem, ProblemHttpResult>> WipeAsync(
        long id,
        [FromBody] StepUpRequest request,
        HttpContext http,
        SyncAccess access,
        AppDbContext db,
        UserManager<AppUser> users,
        AccountSessions sessions,
        ActivityLog activity,
        TimeProvider time)
    {
        var userId = UserId(http);
        if (await access.FindAsync(userId, id) is not { } found)
        {
            return NotFound();
        }

        if (!found.CanManage)
        {
            return NotManager();
        }

        if (await StepUp.ProblemsAsync(users, (await users.GetUserAsync(http.User))!, request, sessions, http, time) is { } problems)
        {
            return ApiProblems.Invalid(problems);
        }

        await using var transaction = await db.Database.BeginTransactionAsync();
        var removed = await db.SyncRecords.Where(r => r.ScopeId == id).ExecuteDeleteAsync();
        await db.SyncScopes.Where(s => s.Id == id).ExecuteUpdateAsync(s => s.SetProperty(x => x.Epoch, x => x.Epoch + 1));
        activity.Add(userId, ActivityActions.SyncReset, new { scopeId = id, records = removed }, found.Scope.TeamId);
        await db.SaveChangesAsync();
        await transaction.CommitAsync();
        return TypedResults.NoContent();
    }

    private static async Task<Results<Ok<SyncUsageDto>, ProblemHttpResult>> UsageAsync(
        long id, HttpContext http, SyncAccess access, AppDbContext db, Microsoft.Extensions.Options.IOptions<SyncOptions> options)
    {
        if (await access.FindAsync(UserId(http), id) is null)
        {
            return NotFound();
        }

        var live = db.SyncRecords.AsNoTracking().Where(r => r.ScopeId == id && !r.Deleted);
        var collections = await live.GroupBy(r => r.Collection).Select(g => new { g.Key, Count = g.Count() }).ToListAsync();
        var bytes = await db.SyncRecords.Where(r => r.ScopeId == id).SumAsync(r => (long?)r.Size) ?? 0;
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(new SyncUsageDto(
            collections.Sum(c => c.Count),
            bytes,
            options.Value.QuotaBytes,
            collections.OrderBy(c => c.Key, StringComparer.Ordinal).ToDictionary(c => c.Key, c => c.Count)));
    }

    private static async Task<Results<Ok<KeyEnvelopeDto>, ProblemHttpResult>> GetKeyAsync(long id, HttpContext http, SyncAccess access)
    {
        if (await access.FindAsync(UserId(http), id) is not { } found)
        {
            return NotFound();
        }

        if (found.Scope.KeyVersion is not { } version || found.Scope.KeyEnvelope is not { } envelope)
        {
            return ApiProblems.Of(ProblemTypes.NotFound, "This scope has no key yet.");
        }

        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(new KeyEnvelopeDto(version, JsonDocument.Parse(envelope).RootElement.Clone(), found.Scope.KeySetAt));
    }

    /// <summary>
    /// Sets the first key (version 1), wraps the same key again under a new passphrase (the same
    /// version), or rotates to a new key (the next version). Anything else is a conflict.
    /// </summary>
    private static async Task<Results<Ok<KeyEnvelopeDto>, ValidationProblem, ProblemHttpResult>> PutKeyAsync(
        long id, KeyEnvelopeRequest request, HttpContext http, SyncAccess access, AppDbContext db, ActivityLog activity, TimeProvider time)
    {
        var userId = UserId(http);
        if (await access.FindAsync(userId, id) is not { } found)
        {
            return NotFound();
        }

        if (!found.CanManage)
        {
            return NotManager();
        }

        if (request.Envelope.ValueKind != JsonValueKind.Object)
        {
            return ApiProblems.Invalid("envelope", "The envelope is the JSON object the app made.");
        }

        var text = request.Envelope.GetRawText();
        if (Encoding.UTF8.GetByteCount(text) > MaxEnvelopeBytes)
        {
            return ApiProblems.Invalid("envelope", "The envelope is too large.");
        }

        var current = found.Scope.KeyVersion;
        var expected = current is null ? request.Version == 1 : request.Version == current || request.Version == current + 1;
        if (!expected)
        {
            return ApiProblems.Of(ProblemTypes.Conflict, current is null
                ? "A first key is version 1."
                : $"The key is at version {current}. Send it again, or version {current + 1} to rotate it.");
        }

        var action = current is null ? ActivityActions.KeySet : ActivityActions.KeyChanged;
        found.Scope.KeyEnvelope = text;
        found.Scope.KeyVersion = request.Version;
        found.Scope.KeySetAt = time.GetUtcNow();
        found.Scope.KeySetBy = userId;
        activity.Add(userId, action, new { scopeId = id, version = request.Version, rotated = current is not null && request.Version > current }, found.Scope.TeamId);
        await db.SaveChangesAsync();
        return TypedResults.Ok(new KeyEnvelopeDto(request.Version, request.Envelope, found.Scope.KeySetAt));
    }

    /// <summary>
    /// For a lost passphrase and recovery key: the key goes, every sealed record with it (nobody can
    /// open them now), and a new epoch tells each computer to send what it still has again.
    /// </summary>
    private static async Task<Results<NoContent, ValidationProblem, ProblemHttpResult>> ResetKeyAsync(
        long id,
        [FromBody] StepUpRequest request,
        HttpContext http,
        SyncAccess access,
        AppDbContext db,
        UserManager<AppUser> users,
        AccountSessions sessions,
        ActivityLog activity,
        TimeProvider time)
    {
        var userId = UserId(http);
        if (await access.FindAsync(userId, id) is not { } found)
        {
            return NotFound();
        }

        if (!found.CanManage)
        {
            return NotManager();
        }

        if (await StepUp.ProblemsAsync(users, (await users.GetUserAsync(http.User))!, request, sessions, http, time) is { } problems)
        {
            return ApiProblems.Invalid(problems);
        }

        await using var transaction = await db.Database.BeginTransactionAsync();
        var removed = await db.SyncRecords.Where(r => r.ScopeId == id && r.Encryption == "e2ee").ExecuteDeleteAsync();
        await db.SyncScopes.Where(s => s.Id == id).ExecuteUpdateAsync(s => s
            .SetProperty(x => x.KeyVersion, (int?)null)
            .SetProperty(x => x.KeyEnvelope, (string?)null)
            .SetProperty(x => x.KeySetAt, (DateTimeOffset?)null)
            .SetProperty(x => x.KeySetBy, (long?)null)
            .SetProperty(x => x.Epoch, x => x.Epoch + 1));
        activity.Add(userId, ActivityActions.KeyReset, new { scopeId = id, records = removed }, found.Scope.TeamId);
        await db.SaveChangesAsync();
        await transaction.CommitAsync();
        return TypedResults.NoContent();
    }
}
