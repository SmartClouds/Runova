using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Api.Accounts;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Dependencies;
using Runova.Website.Core.Problems;
using Runova.Website.Data;
using Runova.Website.Data.Accounts;
using Runova.Website.Data.Dependencies;

namespace Runova.Website.Api.Dependencies;

public sealed record DependencyAlertSettingsDto(
    bool Enabled,
    string SecurityMinSeverity,
    bool Deprecated,
    bool Major,
    bool Minor,
    bool Patch,
    bool InApp,
    bool Telegram);

public sealed record FindingDto(
    string Ecosystem,
    string Name,
    string Kind,
    string CurrentVersion,
    string? TargetVersion,
    string? AdvisoryId,
    string? Severity,
    string? Summary,
    DateTimeOffset FirstSeenAt);

public sealed record FindingCountsDto(int Security, int Deprecated, int Major, int Minor, int Patch);

public sealed record ProjectFindingsDto(
    long InventoryId,
    long ScopeId,
    string ItemId,
    string ProjectName,
    bool Muted,
    DateTimeOffset? LastCheckedAt,
    int Total,
    string? WorstSeverity,
    FindingCountsDto Counts,
    IReadOnlyList<FindingDto> Findings);

public sealed record DependencyFindingsDto(bool Enabled, int Total, IReadOnlyList<ProjectFindingsDto> Items);

/// <summary>
/// An account's alert settings, the projects it muted, and what the last checks found in every
/// project it can see, already narrowed to what it asked to hear about (E51).
/// </summary>
internal static class AlertSettingsEndpoints
{
    private static readonly string[] _flags = ["enabled", "deprecated", "major", "minor", "patch", "inApp", "telegram"];

    public static RouteGroupBuilder MapDependencyAlerts(this RouteGroupBuilder api)
    {
        var me = api.MapGroup("/accounts/me").RequireAuthorization(Policies.Account);
        me.MapGet("/dependency-alert-settings", GetAsync);
        me.MapPatch("/dependency-alert-settings", PatchAsync).Accepts<DependencyAlertSettingsDto>("application/merge-patch+json");
        me.MapPut("/muted-projects/{inventoryId:long}", MuteAsync);
        me.MapDelete("/muted-projects/{inventoryId:long}", UnmuteAsync);

        api.MapGet("/dependency-findings", FindingsAsync).RequireAuthorization(Policies.Account);
        return api;
    }

    private static async Task<Ok<DependencyAlertSettingsDto>> GetAsync(HttpContext http, AlertSettingsStore store)
    {
        var settings = await store.GetAsync(CurrentAccount.Id(http));
        Versions.SetETag(http.Response, settings.Version);
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(DependencyMapper.ToDto(settings));
    }

    private static async Task<Results<Ok<DependencyAlertSettingsDto>, ValidationProblem, ProblemHttpResult>> PatchAsync(
        HttpContext http, AlertSettingsStore store, AppDbContext db, AlertNotifier notifier)
    {
        var userId = CurrentAccount.Id(http);
        var settings = await store.GetAsync(userId);
        if (Versions.CheckIfMatch(http.Request, settings.Version) is { } precondition)
        {
            return precondition;
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

        if (body is null)
        {
            return ApiProblems.Invalid("body", "Send a JSON merge patch object.");
        }

        var wasEnabled = settings.Enabled;
        foreach (var (field, value) in body)
        {
            if (field == "securityMinSeverity")
            {
                if (value is not JsonValue text || !text.TryGetValue<string>(out var severity) || !Severities.Thresholds.Contains(severity))
                {
                    return ApiProblems.Invalid(field, "Pick critical, high, moderate, low or off.");
                }

                settings.SecurityMinSeverity = severity;
                continue;
            }

            if (!_flags.Contains(field))
            {
                return ApiProblems.Invalid(field, "This field is not part of the resource.");
            }

            if (value is not JsonValue flag || !flag.TryGetValue<bool>(out var on))
            {
                return ApiProblems.Invalid(field, "This is true or false.");
            }

            switch (field)
            {
                case "enabled": settings.Enabled = on; break;
                case "deprecated": settings.Deprecated = on; break;
                case "major": settings.Major = on; break;
                case "minor": settings.Minor = on; break;
                case "patch": settings.Patch = on; break;
                case "inApp": settings.InApp = on; break;
                default: settings.Telegram = on; break;
            }
        }

        await using var transaction = await db.Database.BeginTransactionAsync();
        await db.SaveChangesAsync();
        if (wasEnabled && !settings.Enabled)
        {
            // Turned off: the packages of the account's own projects go. A team's stay for its other members.
            var personal = db.SyncScopes.Where(s => s.Kind == SyncScopeKinds.Personal && s.UserId == userId).Select(s => s.Id);
            await db.PackageInventories.Where(i => personal.Contains(i.ScopeId)).ExecuteDeleteAsync();
        }

        await transaction.CommitAsync();
        await notifier.SummaryChangedAsync([userId]);
        Versions.SetETag(http.Response, settings.Version);
        return TypedResults.Ok(DependencyMapper.ToDto(settings));
    }

    private static async Task<Results<NoContent, ProblemHttpResult>> MuteAsync(
        long inventoryId, HttpContext http, SyncAccess access, AppDbContext db, TimeProvider time, AlertNotifier notifier)
    {
        var userId = CurrentAccount.Id(http);
        if (await VisibleAsync(userId, inventoryId, access, db) is null)
        {
            return NotFound();
        }

        if (!await db.MutedProjects.AnyAsync(m => m.UserId == userId && m.InventoryId == inventoryId))
        {
            db.MutedProjects.Add(new MutedProject { UserId = userId, InventoryId = inventoryId, MutedAt = time.GetUtcNow() });
            await Writes.TrySaveAsync(db);
        }

        await notifier.SummaryChangedAsync([userId]);
        return TypedResults.NoContent();
    }

    private static async Task<Results<NoContent, ProblemHttpResult>> UnmuteAsync(
        long inventoryId, HttpContext http, SyncAccess access, AppDbContext db, AlertNotifier notifier)
    {
        var userId = CurrentAccount.Id(http);
        if (await VisibleAsync(userId, inventoryId, access, db) is null)
        {
            return NotFound();
        }

        await db.MutedProjects.Where(m => m.UserId == userId && m.InventoryId == inventoryId).ExecuteDeleteAsync();
        await notifier.SummaryChangedAsync([userId]);
        return TypedResults.NoContent();
    }

    private static ProblemHttpResult NotFound() => ApiProblems.Of(ProblemTypes.NotFound, "There is no such project for this account.");

    private static async Task<PackageInventory?> VisibleAsync(long userId, long inventoryId, SyncAccess access, AppDbContext db)
    {
        var scopes = (await access.ListAsync(userId)).Select(a => a.Scope.Id).ToList();
        return await db.PackageInventories.AsNoTracking().SingleOrDefaultAsync(i => i.Id == inventoryId && scopes.Contains(i.ScopeId));
    }

    private static async Task<Ok<DependencyFindingsDto>> FindingsAsync(HttpContext http, FindingsReader reader)
    {
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(await reader.ForAsync(CurrentAccount.Id(http)));
    }
}

/// <summary>What the last checks found in every project an account can see, narrowed to its settings.</summary>
internal sealed class FindingsReader(AppDbContext db, SyncAccess access)
{
    public async Task<DependencyFindingsDto> ForAsync(long userId)
    {
        var settings = await db.DependencyAlertSettings.AsNoTracking().SingleOrDefaultAsync(s => s.UserId == userId);
        var preferences = AlertSettingsStore.ToPreferences(settings);
        if (!preferences.Enabled)
        {
            return new DependencyFindingsDto(false, 0, []);
        }

        var scopes = (await access.ListAsync(userId)).Select(a => a.Scope.Id).ToList();
        var inventories = await db.PackageInventories.AsNoTracking()
            .Where(i => scopes.Contains(i.ScopeId))
            .OrderBy(i => i.ProjectName).ThenBy(i => i.Id)
            .ToListAsync();
        var ids = inventories.Select(i => i.Id).ToList();
        var findings = (await db.DependencyFindings.AsNoTracking().Where(f => ids.Contains(f.InventoryId)).ToListAsync())
            .ToLookup(f => f.InventoryId);
        var muted = (await db.MutedProjects.AsNoTracking().Where(m => m.UserId == userId && ids.Contains(m.InventoryId)).Select(m => m.InventoryId).ToListAsync())
            .ToHashSet();

        var items = new List<ProjectFindingsDto>();
        foreach (var inventory in inventories)
        {
            var wanted = findings[inventory.Id]
                .Select(f => (Row: f, Finding: DependencyMapper.ToFinding(f)))
                .Where(f => AlertPolicy.Wants(preferences, f.Finding))
                .OrderBy(f => FindingKinds.Order(f.Row.Kind)).ThenByDescending(f => Severities.Rank(f.Row.Severity)).ThenBy(f => f.Row.Name, StringComparer.OrdinalIgnoreCase)
                .ToList();
            var isMuted = muted.Contains(inventory.Id);
            int Count(string kind) => wanted.Count(f => f.Row.Kind == kind);
            items.Add(DependencyMapper.ToDto(
                inventory,
                isMuted,
                isMuted ? 0 : wanted.Count,
                isMuted ? null : AlertPolicy.WorstSeverity(wanted.Select(f => f.Finding)),
                new FindingCountsDto(Count(FindingKinds.Security), Count(FindingKinds.Deprecated), Count(FindingKinds.Major), Count(FindingKinds.Minor), Count(FindingKinds.Patch)),
                [.. wanted.Select(f => DependencyMapper.ToDto(f.Row))]));
        }

        return new DependencyFindingsDto(true, items.Sum(i => i.Total), items);
    }
}
