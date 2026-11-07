using Microsoft.EntityFrameworkCore;
using Runova.Website.Api.Accounts;
using Runova.Website.Api.Billing;
using Runova.Website.Core.Monitoring;
using Runova.Website.Data;
using Runova.Website.Data.Accounts;
using Runova.Website.Data.Dependencies;
using Runova.Website.Data.Monitoring;

namespace Runova.Website.Api.CloudMonitoring;

/// <summary>
/// Brings online monitors within their scope's account type after it went down (E55): when a
/// subscription ended, an Admin changed it or a type, or a team changed owners. The newest
/// monitors over the limit are paused (marked as Runova's doing) and intervals under the new floor
/// are lengthened; every member of the scope is told what changed.
/// </summary>
internal sealed class PlanEnforcement(
    AppDbContext db,
    Entitlements entitlements,
    MonitorAssigner assigner,
    CloudMonitorNotifier notifier,
    TimeProvider time) : IPlanEnforcement
{
    /// <summary>The scopes this account pays for: its own, and the teams it owns.</summary>
    public async Task AccountChangedAsync(long userId, CancellationToken cancellationToken = default)
    {
        var owned = db.TeamMembers.Where(m => m.UserId == userId && m.Role == TeamRoles.Owner).Select(m => m.TeamId);
        var scopes = await db.SyncScopes.AsNoTracking()
            .Where(s => (s.Kind == SyncScopeKinds.Personal && s.UserId == userId) || (s.Kind == SyncScopeKinds.Team && s.TeamId != null && owned.Contains(s.TeamId.Value)))
            .Select(s => s.Id).ToListAsync(cancellationToken);
        await ScopesAsync(scopes, cancellationToken);
    }

    public async Task TeamChangedAsync(long teamId, CancellationToken cancellationToken = default)
    {
        var scopes = await db.SyncScopes.AsNoTracking().Where(s => s.Kind == SyncScopeKinds.Team && s.TeamId == teamId).Select(s => s.Id).ToListAsync(cancellationToken);
        await ScopesAsync(scopes, cancellationToken);
    }

    /// <summary>Every scope with online monitors: after an Admin changed a type, and once a night to be sure.</summary>
    public async Task AllAsync(CancellationToken cancellationToken = default)
    {
        var scopes = await db.CloudMonitors.AsNoTracking().Select(m => m.ScopeId).Distinct().ToListAsync(cancellationToken);
        await ScopesAsync(scopes, cancellationToken);
    }

    private async Task ScopesAsync(IReadOnlyList<long> scopeIds, CancellationToken ct)
    {
        var changedIds = new List<long>();
        var notices = new List<UserNotification>();
        var changedScopes = new List<long>();
        foreach (var scopeId in scopeIds)
        {
            var monitors = await db.CloudMonitors.Where(m => m.ScopeId == scopeId).ToListAsync(ct);
            if (monitors.Count == 0)
            {
                continue;
            }

            var entitlement = await entitlements.ForScopeAsync(scopeId, ct);
            var result = CloudMonitorRules.Enforce(entitlement, [.. monitors.Select(m => new EnforcedMonitor(m.Id, m.CreatedAt, m.IntervalSec, m.Paused))]);
            if (!result.Changed)
            {
                continue;
            }

            var now = time.GetUtcNow();
            foreach (var monitor in monitors)
            {
                var touched = false;
                if (result.Pause.Contains(monitor.Id))
                {
                    monitor.Paused = true;
                    monitor.SuspendedReason = SuspendedReasons.OverLimit;
                    touched = true;
                }

                if (result.Intervals.TryGetValue(monitor.Id, out var interval))
                {
                    monitor.IntervalSec = interval;
                    monitor.TimeoutSec = Math.Min(monitor.TimeoutSec, Math.Min(CloudMonitorRules.TimeoutMaxSec, interval - 1));
                    monitor.DefinitionVersion++;
                    touched = true;
                }

                if (touched)
                {
                    monitor.UpdatedAt = now;
                    changedIds.Add(monitor.Id);
                }
            }

            var name = await ScopeNameAsync(scopeId, ct);
            notices.AddRange(await notifier.AddPlanNoticeAsync(scopeId, CloudMonitorMessages.PlanChanged(name, entitlement, result.Pause.Count, result.Intervals.Count), ct));
            changedScopes.Add(scopeId);
        }

        if (changedScopes.Count == 0)
        {
            return;
        }

        await db.SaveChangesAsync(ct);
        await assigner.SyncAsync(changedIds, [], ct);
        await notifier.PushAsync(notices, [], ct);
        foreach (var scopeId in changedScopes)
        {
            await notifier.ScopeChangedAsync(scopeId, ct);
        }
    }

    private async Task<string> ScopeNameAsync(long scopeId, CancellationToken ct) =>
        await (from s in db.SyncScopes
               where s.Id == scopeId
               join t in db.Teams on s.TeamId equals t.Id into teams
               from t in teams.DefaultIfEmpty()
               select t == null ? SyncAccess.PersonalName : t.Name).SingleAsync(ct);
}

/// <summary>
/// Every night: raw samples older than their scope's account type keeps go, in batches. Hours and
/// incidents stay. It also runs plan enforcement over every scope, in case a change was missed.
/// </summary>
internal sealed class SampleRetentionJob(AppDbContext db, Entitlements entitlements, PlanEnforcement enforcement, TimeProvider time)
{
    public const int BatchSize = 10_000;

    public async Task RunAsync(CancellationToken ct)
    {
        var now = time.GetUtcNow();
        foreach (var scopeId in await db.CloudMonitors.AsNoTracking().Select(m => m.ScopeId).Distinct().ToListAsync(ct))
        {
            var days = (await entitlements.ForScopeAsync(scopeId, ct)).HistoryDays;
            var cutoff = now.AddDays(-Math.Max(1, days));
            var monitors = await db.CloudMonitors.AsNoTracking().Where(m => m.ScopeId == scopeId).Select(m => m.Id).ToArrayAsync(ct);
            int deleted;
            do
            {
                deleted = await db.Database.ExecuteSqlAsync(
                    $"""
                    DELETE FROM "CloudMonitorSamples" WHERE "Id" IN (
                        SELECT "Id" FROM "CloudMonitorSamples"
                        WHERE "MonitorId" = ANY({monitors}) AND "CheckedAt" < {cutoff}
                        LIMIT {BatchSize})
                    """,
                    ct);
            }
            while (deleted == BatchSize);
        }

        await enforcement.AllAsync(ct);
    }
}
