using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Runova.Website.Data;
using Runova.Website.Data.Monitoring;

namespace Runova.Website.Api.Monitoring;

/// <summary>Moves monitors when nodes come and go (the online monitors' assigner, E55).</summary>
public interface INodeRebalancer
{
    Task NodesChangedAsync(CancellationToken ct = default);
}

/// <summary>
/// Every minute: a node whose heartbeats stopped for <see cref="MonitoringOptions.OfflineAfter"/>
/// is offline, and the monitors are planned again, so a node that went quiet or dropped its stream
/// a while ago hands its monitors to the others. The node list shows it offline from the 45th
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
        foreach (var node in silent)
        {
            node.Status = NodeStatuses.Offline;
            node.GatewayId = null;
            logger.NodeSilent(node.Id, node.Name, node.LastSeenAt);
        }

        if (silent.Count > 0)
        {
            await db.SaveChangesAsync(ct);
        }

        await rebalancer.NodesChangedAsync(ct);
    }
}
