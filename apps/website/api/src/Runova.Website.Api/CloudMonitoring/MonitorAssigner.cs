using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Runova.Monitoring.Contracts.Grpc;
using Runova.Website.Api.Monitoring;
using Runova.Website.Core.Monitoring;
using Runova.Website.Data;
using Runova.Website.Data.Monitoring;

namespace Runova.Website.Api.CloudMonitoring;

/// <summary>
/// Puts every active online monitor on a node (E55), by <see cref="MonitorDistribution"/>, and
/// tells each node what changed for it as a delta. It runs after a monitor changes, when a node
/// connects, and every minute with the liveness job, so a node that went quiet hands its monitors
/// on. One run at a time: an advisory lock keeps two from planning over each other.
/// </summary>
internal sealed class MonitorAssigner(
    AppDbContext db,
    INodeBus bus,
    CloudMonitorSecrets secrets,
    IOptions<MonitoringOptions> options,
    TimeProvider time) : INodeRebalancer, IAssignmentSource
{
    private const long LockKey = 0x52_75_6E_6F_76_61_35_35;

    public Task NodesChangedAsync(CancellationToken ct = default) => SyncAsync([], [], ct);

    /// <summary>
    /// Plans again. <paramref name="changed"/> are monitors whose definition changed and go to their
    /// node again even when they stay; <paramref name="removed"/> are deleted monitors and the node they were on.
    /// </summary>
    public async Task SyncAsync(IReadOnlyCollection<long> changed, IReadOnlyCollection<(long MonitorId, long NodeId)> removed, CancellationToken ct = default)
    {
        var deltas = new Dictionary<long, (List<long> Upserts, List<long> Removed)>();
        (List<long> Upserts, List<long> Removed) For(long nodeId)
        {
            if (!deltas.TryGetValue(nodeId, out var delta))
            {
                delta = ([], []);
                deltas[nodeId] = delta;
            }

            return delta;
        }

        Dictionary<long, long> versions;
        await using (var transaction = await db.Database.BeginTransactionAsync(ct))
        {
            await db.Database.ExecuteSqlAsync($"SELECT pg_advisory_xact_lock({LockKey})", ct);
            var nodes = await db.MonitoringNodes
                .Where(n => n.Status != NodeStatuses.Revoked && n.Status != NodeStatuses.Pending)
                .ToListAsync(ct);
            var fresh = time.GetUtcNow() - options.Value.OfflineAfter;
            var slots = nodes.Select(n => CloudMonitorMapper.ToSlot(n, Eligible(n, fresh))).ToList();

            // Locked in id order, as ingestion locks them, so the two never wait on each other in a circle.
            var statuses = await db.CloudMonitorStatuses
                .FromSql($"SELECT * FROM \"CloudMonitorStatuses\" ORDER BY \"MonitorId\" FOR UPDATE")
                .ToDictionaryAsync(s => s.MonitorId, ct);
            var monitors = await db.CloudMonitors.AsNoTracking()
                .Select(m => new { m.Id, m.IntervalSec, m.Paused })
                .ToListAsync(ct);
            var active = monitors.Where(m => !m.Paused && statuses.ContainsKey(m.Id)).ToList();
            var plan = MonitorDistribution.Plan(slots, [.. active.Select(m => new MonitorSlot(m.Id, m.IntervalSec, statuses[m.Id].NodeId))]);

            foreach (var monitor in monitors)
            {
                if (!statuses.TryGetValue(monitor.Id, out var status))
                {
                    continue;
                }

                var target = monitor.Paused ? null : plan.GetValueOrDefault(monitor.Id);
                if (target != status.NodeId)
                {
                    if (status.NodeId is { } from)
                    {
                        For(from).Removed.Add(monitor.Id);
                    }

                    if (target is { } to)
                    {
                        For(to).Upserts.Add(monitor.Id);
                    }

                    status.NodeId = target;
                }
                else if (target is { } same && changed.Contains(monitor.Id))
                {
                    For(same).Upserts.Add(monitor.Id);
                }
            }

            foreach (var (monitorId, nodeId) in removed)
            {
                For(nodeId).Removed.Add(monitorId);
            }

            foreach (var node in nodes.Where(n => deltas.ContainsKey(n.Id)))
            {
                node.AssignmentVersion++;
            }

            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            versions = nodes.ToDictionary(n => n.Id, n => n.AssignmentVersion);
        }

        foreach (var (nodeId, (upserts, gone)) in deltas)
        {
            if (!versions.TryGetValue(nodeId, out var version))
            {
                continue;
            }

            var delta = new AssignmentDelta { AssignmentVersion = version };
            delta.Upserts.AddRange(await DefinitionsAsync(upserts, ct));
            delta.Removed.AddRange(gone);
            await bus.SendAsync(nodeId, new ServerMessage { Delta = delta }, ct);
        }
    }

    public async Task<IReadOnlyList<MonitorDefinition>> ForNodeAsync(long nodeId, CancellationToken ct = default)
    {
        var ids = await (from s in db.CloudMonitorStatuses
                         join m in db.CloudMonitors on s.MonitorId equals m.Id
                         where s.NodeId == nodeId && !m.Paused
                         select m.Id).ToListAsync(ct);
        return await DefinitionsAsync(ids, ct);
    }

    /// <summary>What a node checks with, the access key opened for it.</summary>
    public async Task<IReadOnlyList<MonitorDefinition>> DefinitionsAsync(IReadOnlyCollection<long> ids, CancellationToken ct = default)
    {
        if (ids.Count == 0)
        {
            return [];
        }

        var monitors = await db.CloudMonitors.AsNoTracking().Where(m => ids.Contains(m.Id)).OrderBy(m => m.Id).ToListAsync(ct);
        return [.. monitors.Select(Definition)];
    }

    public MonitorDefinition Definition(CloudMonitor monitor) =>
        CloudMonitorMapper.ToDefinition(monitor, secrets.Open(monitor.SealedSecret) ?? "");

    /// <summary>
    /// A node takes monitors while it is not drained and was heard from lately. One that just
    /// dropped its stream keeps them for <see cref="MonitoringOptions.OfflineAfter"/>, so a gateway
    /// restart does not move everything twice.
    /// </summary>
    public static bool Eligible(MonitoringNode node, DateTimeOffset fresh) =>
        node.Status is NodeStatuses.Online or NodeStatuses.Offline
        && !node.Draining
        && node.LastSeenAt is { } seen && seen >= fresh;
}
