using Microsoft.EntityFrameworkCore;
using Runova.Website.Core.Billing;
using Runova.Website.Data;
using Runova.Website.Data.Accounts;
using Runova.Website.Data.Billing;

namespace Runova.Website.Api.Billing;

/// <summary>
/// What an account, or a scope, may do (E53). An account gets the type of its subscription while
/// that is active or past due and its period has not ended, and the Free type otherwise. A team's
/// scope gets its owner's type; with several owners, the most generous of theirs.
/// </summary>
internal sealed class Entitlements(AppDbContext db, TimeProvider time)
{
    public async Task<Entitlement> ForUserAsync(long userId, CancellationToken cancellationToken = default) =>
        (await ForUsersAsync([userId], cancellationToken))[userId];

    public async Task<IReadOnlyDictionary<long, Entitlement>> ForUsersAsync(IReadOnlyCollection<long> userIds, CancellationToken cancellationToken = default)
    {
        var now = time.GetUtcNow();
        var paid = await (
            from s in db.Subscriptions.AsNoTracking()
            where userIds.Contains(s.UserId)
                  && (s.Status == SubscriptionStatuses.Active || s.Status == SubscriptionStatuses.PastDue)
                  && (s.CurrentPeriodEnd == null || s.CurrentPeriodEnd > now)
            join t in db.AccountTypes.AsNoTracking() on s.AccountTypeId equals t.Id
            select new { s.UserId, Type = t }).ToListAsync(cancellationToken);
        var free = await FreeAsync(cancellationToken);
        return userIds.Distinct().ToDictionary(
            id => id,
            id => paid.Where(p => p.UserId == id).Select(p => ToEntitlement(p.Type)).FirstOrDefault() ?? free);
    }

    /// <summary>The scope's type: its account's, or the best of its team's owners'. A scope nobody owns gets Free.</summary>
    public async Task<Entitlement> ForScopeAsync(long scopeId, CancellationToken cancellationToken = default)
    {
        var payers = await PayersAsync(scopeId, cancellationToken);
        return payers.Count == 0 ? await FreeAsync(cancellationToken) : Entitlement.Best((await ForUsersAsync(payers, cancellationToken)).Values);
    }

    /// <summary>The accounts whose type a scope uses: the account of a personal scope, or the team's owners.</summary>
    public async Task<IReadOnlyList<long>> PayersAsync(long scopeId, CancellationToken cancellationToken = default)
    {
        var scope = await db.SyncScopes.AsNoTracking().SingleOrDefaultAsync(s => s.Id == scopeId, cancellationToken);
        return scope switch
        {
            { Kind: SyncScopeKinds.Personal, UserId: { } userId } => [userId],
            { Kind: SyncScopeKinds.Team, TeamId: { } teamId } => await db.TeamMembers.AsNoTracking()
                .Where(m => m.TeamId == teamId && m.Role == TeamRoles.Owner).Select(m => m.UserId).ToListAsync(cancellationToken),
            _ => [],
        };
    }

    public async Task<Entitlement> FreeAsync(CancellationToken cancellationToken = default)
    {
        var free = await db.AccountTypes.AsNoTracking().SingleOrDefaultAsync(t => t.IsFree, cancellationToken);
        return free is null ? new Entitlement(0, "free", "Free", 1, 300, 7, true) : ToEntitlement(free);
    }

    public static Entitlement ToEntitlement(AccountType type) =>
        new(type.Id, type.Key, type.Name, type.MaxCloudMonitors, type.MinIntervalSec, type.HistoryDays, type.IsFree);
}

/// <summary>
/// Brings an account's online monitors, and its teams', within its type after the type changed
/// (it ended, an Admin changed it, a payment moved it). Online monitors (E55) fill this in.
/// </summary>
internal interface IPlanEnforcement
{
    Task AccountChangedAsync(long userId, CancellationToken cancellationToken = default);
}

internal sealed class NoPlanEnforcement : IPlanEnforcement
{
    public Task AccountChangedAsync(long userId, CancellationToken cancellationToken = default) => Task.CompletedTask;
}
