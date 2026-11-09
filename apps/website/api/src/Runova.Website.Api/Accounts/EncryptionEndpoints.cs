using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Api.Billing;
using Runova.Website.Api.Dependencies;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Accounts;
using Runova.Website.Core.Billing;
using Runova.Website.Core.Problems;
using Runova.Website.Data;
using Runova.Website.Data.Accounts;

namespace Runova.Website.Api.Accounts;

public sealed record EncryptionItemDto(string Item, string Label, bool Enabled, bool Active, bool Lapsed, bool NeedsKey);

public sealed record EncryptionDto(bool Entitled, string PlanName, IReadOnlyList<EncryptionItemDto> Items);

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record EncryptionWrite(bool? Enabled);

/// <summary>One kind of item a person can choose to end-to-end encrypt.</summary>
internal sealed record EncryptionItem(string Id, string Label);

internal static class EncryptionItems
{
    public const string Notifications = "notifications";
    public const string Sync = "sync";

    public static readonly IReadOnlyList<EncryptionItem> All = [new(Notifications, "Notifications"), new(Sync, "Cloud sync")];
}

/// <summary>What the switches mean, apart from where the facts come from (E92).</summary>
internal static class EncryptionRules
{
    public static EncryptionDto Status(Entitlement entitlement, IReadOnlySet<string> enabled, bool syncSealing, bool syncHasKey)
    {
        var entitled = entitlement.EncryptedItems;
        var items = EncryptionItems.All.Select(item =>
        {
            var on = enabled.Contains(item.Id);
            var sync = item.Id == EncryptionItems.Sync;
            return EncryptionMapper.ToDto(item, on, active: on && entitled && (!sync || (syncSealing && syncHasKey)), lapsed: on && !entitled, needsKey: sync && !syncHasKey);
        });
        return EncryptionMapper.ToDto(entitlement, [.. items]);
    }

    /// <summary>
    /// What a scope's sealing should become after a plan changed, or null to leave it alone. Going
    /// back on needs a choice still on record and a key to seal with.
    /// </summary>
    public static bool? Enforce(bool sealing, bool entitled, bool wanted, bool hasKey)
    {
        if (sealing)
        {
            return entitled ? null : false;
        }

        return entitled && wanted && hasKey ? true : null;
    }
}

internal static class EncryptionProblems
{
    public static ProblemHttpResult PlanRequired(Entitlement entitlement) =>
        ApiProblems.Of(
            ProblemTypes.Forbidden,
            $"{entitlement.Name} does not include encrypted notifications and sync. Choose a plan that does.",
            new Dictionary<string, object?> { ["code"] = "plan-required", ["accountType"] = entitlement.Key });

    public static ProblemHttpResult NeedsKey() =>
        ApiProblems.Of(
            ProblemTypes.Conflict,
            "Cloud sync has no encryption key yet. Set one up in the app first.",
            new Dictionary<string, object?> { ["code"] = "needs-key" });
}

/// <summary>Each account's choices, and what they come to given its plan and its sync scope.</summary>
internal sealed class EncryptionPreferences(AppDbContext db, Entitlements entitlements, SyncAccess access, TimeProvider time)
{
    public async Task<EncryptionDto> StatusAsync(long userId, CancellationToken cancellationToken = default)
    {
        var entitlement = await entitlements.ForUserAsync(userId, cancellationToken);
        var scope = await access.PersonalAsync(userId);
        return EncryptionRules.Status(entitlement, await EnabledAsync(userId, cancellationToken), scope.EncryptEverything, scope.KeyVersion is not null);
    }

    /// <summary>Whether this account's computers should seal what they forward.</summary>
    public async Task<bool> SealingNotificationsAsync(long userId, CancellationToken cancellationToken = default) =>
        (await EnabledAsync(userId, cancellationToken)).Contains(EncryptionItems.Notifications)
        && (await entitlements.ForUserAsync(userId, cancellationToken)).EncryptedItems;

    /// <summary>Saves one choice; two taps racing each other end with the last one.</summary>
    public Task SetAsync(long userId, string item, bool enabled, CancellationToken cancellationToken = default)
    {
        var now = time.GetUtcNow();
        return db.Database.ExecuteSqlInterpolatedAsync(
            $"""
            INSERT INTO "UserEncryptionPreferences" ("UserId", "Item", "Enabled", "UpdatedAt") VALUES ({userId}, {item}, {enabled}, {now})
            ON CONFLICT ("UserId", "Item") DO UPDATE SET "Enabled" = {enabled}, "UpdatedAt" = {now}
            """,
            cancellationToken);
    }

    private async Task<HashSet<string>> EnabledAsync(long userId, CancellationToken cancellationToken) =>
        (await db.UserEncryptionPreferences.AsNoTracking()
            .Where(p => p.UserId == userId && p.Enabled)
            .Select(p => p.Item)
            .ToListAsync(cancellationToken))
        .ToHashSet(StringComparer.Ordinal);
}

/// <summary>
/// Keeps sealing in step with who pays (E92). A scope that lost the plan stops sealing whole records
/// (what is already sealed stays sealed and readable); a personal scope whose owner's choice is still
/// on goes back on once the plan returns. Team scopes have no such choice on record, so a manager
/// turns them back on.
/// </summary>
internal sealed class EncryptionEnforcement(AppDbContext db, Entitlements entitlements)
{
    public async Task AllAsync(CancellationToken cancellationToken = default)
    {
        var wanted = db.UserEncryptionPreferences.Where(p => p.Item == EncryptionItems.Sync && p.Enabled).Select(p => p.UserId);
        var scopes = await db.SyncScopes.AsNoTracking()
            .Where(s => s.EncryptEverything || (s.Kind == SyncScopeKinds.Personal && s.KeyVersion != null && s.UserId != null && wanted.Contains(s.UserId.Value)))
            .Select(s => s.Id)
            .ToListAsync(cancellationToken);
        await ScopesAsync(scopes, cancellationToken);
    }

    public async Task ScopesAsync(IReadOnlyCollection<long> scopeIds, CancellationToken cancellationToken = default)
    {
        var scopes = await db.SyncScopes.AsNoTracking()
            .Where(s => scopeIds.Contains(s.Id))
            .Select(s => new { s.Id, s.Kind, s.UserId, s.EncryptEverything, HasKey = s.KeyVersion != null })
            .ToListAsync(cancellationToken);
        var owners = scopes.Where(s => s.Kind == SyncScopeKinds.Personal && s.UserId != null).Select(s => s.UserId!.Value).ToList();
        var wanted = (await db.UserEncryptionPreferences.AsNoTracking()
            .Where(p => owners.Contains(p.UserId) && p.Item == EncryptionItems.Sync && p.Enabled)
            .Select(p => p.UserId)
            .ToListAsync(cancellationToken))
            .ToHashSet();

        var turnOn = new List<long>();
        var turnOff = new List<long>();
        foreach (var scope in scopes)
        {
            var entitled = (await entitlements.ForScopeAsync(scope.Id, cancellationToken)).EncryptedItems;
            var wants = scope.Kind == SyncScopeKinds.Personal && scope.UserId is { } owner && wanted.Contains(owner);
            switch (EncryptionRules.Enforce(scope.EncryptEverything, entitled, wants, scope.HasKey))
            {
                case true: turnOn.Add(scope.Id); break;
                case false: turnOff.Add(scope.Id); break;
            }
        }

        // Straight to the rows: a sync push holds these under lock and moves their version.
        if (turnOn.Count > 0)
        {
            await db.SyncScopes.Where(s => turnOn.Contains(s.Id)).ExecuteUpdateAsync(s => s.SetProperty(x => x.EncryptEverything, true), cancellationToken);
        }

        if (turnOff.Count > 0)
        {
            await db.SyncScopes.Where(s => turnOff.Contains(s.Id)).ExecuteUpdateAsync(s => s.SetProperty(x => x.EncryptEverything, false), cancellationToken);
        }
    }
}

/// <summary>The two switches a person has for end-to-end encryption, per item (E92).</summary>
internal static class EncryptionEndpoints
{
    public static RouteGroupBuilder MapEncryption(this RouteGroupBuilder api)
    {
        var me = api.MapGroup("/accounts/me/encryption-preferences").RequireAuthorization(Policies.Account);
        me.MapGet("", GetAsync);
        me.MapPut("/{item}", SetAsync);
        return api;
    }

    private static async Task<Ok<EncryptionDto>> GetAsync(HttpContext http, EncryptionPreferences preferences)
    {
        var status = await preferences.StatusAsync(CurrentAccount.Id(http), http.RequestAborted);
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(status);
    }

    private static async Task<Results<Ok<EncryptionDto>, ValidationProblem, ProblemHttpResult>> SetAsync(
        string item, EncryptionWrite request, HttpContext http, AppDbContext db, EncryptionPreferences preferences, Entitlements entitlements, SyncAccess access, ActivityLog activity)
    {
        if (EncryptionItems.All.All(known => known.Id != item))
        {
            return ApiProblems.Of(ProblemTypes.NotFound, "There is no such item to encrypt.");
        }

        if (request.Enabled is not { } enabled)
        {
            return ApiProblems.Invalid("enabled", "Send { \"enabled\": true } or { \"enabled\": false }.");
        }

        var userId = CurrentAccount.Id(http);
        var cancel = http.RequestAborted;
        if (enabled && await entitlements.ForUserAsync(userId, cancel) is { EncryptedItems: false } entitlement)
        {
            return EncryptionProblems.PlanRequired(entitlement);
        }

        if (item != EncryptionItems.Sync)
        {
            await preferences.SetAsync(userId, item, enabled, cancel);
        }
        else
        {
            var scope = await access.PersonalAsync(userId);
            if (enabled && scope.KeyVersion is null)
            {
                return EncryptionProblems.NeedsKey();
            }

            await using var transaction = await db.Database.BeginTransactionAsync(cancel);
            await preferences.SetAsync(userId, item, enabled, cancel);
            if (scope.EncryptEverything != enabled)
            {
                // Straight to the row: a sync push moves this row's version at any moment.
                await db.SyncScopes.Where(s => s.Id == scope.Id).ExecuteUpdateAsync(s => s.SetProperty(x => x.EncryptEverything, enabled), cancel);
                await db.Entry(scope).ReloadAsync(cancel);
                activity.Add(userId, ActivityActions.SyncPolicyChanged, new { scopeId = scope.Id, policy = new { scope.EncryptServers, scope.EncryptEnvironments, scope.EncryptEverything } }, scope.TeamId);
                await db.SaveChangesAsync(cancel);
            }

            await transaction.CommitAsync(cancel);
        }

        return TypedResults.Ok(await preferences.StatusAsync(userId, cancel));
    }
}
