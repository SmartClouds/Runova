using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Runova.Website.Data;
using Runova.Website.Data.Monitoring;

namespace Runova.Website.Api.Monitoring;

/// <summary>
/// Moves monitors when nodes come and go. Online monitors (E55) fill it in; until then there is
/// nothing to move.
/// </summary>
public interface INodeRebalancer
{
    Task NodesChangedAsync(CancellationToken ct = default);
}

internal sealed class NoRebalance : INodeRebalancer
{
    public Task NodesChangedAsync(CancellationToken ct = default) => Task.CompletedTask;
}

/// <summary>
/// Every minute: a node whose heartbeats stopped for <see cref="MonitoringOptions.OfflineAfter"/>
/// is offline, and its monitors move to the others. The node list shows it offline from the 45th
/// second on, before this writes it.
/// </summary>
internal sealed class NodeLivenessJob(
    AppDbContext db, INodeRebalancer rebalancer, IOptions<MonitoringOptions> options, TimeProvider time, ILogger<NodeLivenessJob> logger)
{
    public async Task RunAsync(CancellationToken ct)
    {
        var cutoff = time.GetUtcNow() - options.Value.OfflineAfter;
        var silent = await db.MonitoringNodes
            .Where(n => n.Status == NodeStatuses.Online && (n.LastSeenAt == null || n.LastSeenAt < cutoff))
            .ToListAsync(ct);
        if (silent.Count == 0)
        {
            return;
        }

        foreach (var node in silent)
        {
            node.Status = NodeStatuses.Offline;
            node.GatewayId = null;
            logger.NodeSilent(node.Id, node.Name, node.LastSeenAt);
        }

        await db.SaveChangesAsync(ct);
        await rebalancer.NodesChangedAsync(ct);
    }
}
