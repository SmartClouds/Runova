namespace Runova.Website.Core.Monitoring;

/// <summary>A node as distribution sees it.</summary>
/// <param name="Capacity">How much it can take next to the others; 100 is a normal node.</param>
/// <param name="Eligible">Online, not draining and not revoked.</param>
public sealed record NodeSlot(long Id, string Region, int Capacity, bool Eligible);

/// <summary>A monitor and the node it is on now, if any.</summary>
public sealed record MonitorSlot(long Id, int IntervalSec, long? NodeId);

/// <summary>
/// Spreads online monitors over the nodes (E54). A monitor weighs 1 / interval, so one checked
/// every 30 seconds counts ten times one checked every 5 minutes. Monitors stay where they are
/// unless their node is gone, or it carries more than <see cref="Tolerance"/> over its share; then
/// the lightest move first, so as few checks as possible change node.
/// </summary>
public static class MonitorDistribution
{
    /// <summary>How far over its share a node may go before monitors move off it.</summary>
    public const double Tolerance = 0.20;

    public static double Weight(int intervalSec) => 1.0 / Math.Max(1, intervalSec);

    /// <summary>
    /// Where every monitor should be. A monitor maps to null only when no node is eligible. The
    /// answer is the same for the same input, so two runs never disagree.
    /// </summary>
    public static IReadOnlyDictionary<long, long?> Plan(IReadOnlyList<NodeSlot> nodes, IReadOnlyList<MonitorSlot> monitors)
    {
        var plan = new Dictionary<long, long?>(monitors.Count);
        var eligible = nodes.Where(n => n.Eligible && n.Capacity > 0).OrderBy(n => n.Id).ToList();
        if (eligible.Count == 0)
        {
            foreach (var monitor in monitors)
            {
                plan[monitor.Id] = null;
            }

            return plan;
        }

        var load = eligible.ToDictionary(n => n.Id, _ => 0.0);
        var onNode = eligible.ToDictionary(n => n.Id, _ => new List<MonitorSlot>());
        var waiting = new List<MonitorSlot>();
        foreach (var monitor in monitors.OrderBy(m => m.Id))
        {
            if (monitor.NodeId is { } nodeId && load.ContainsKey(nodeId))
            {
                load[nodeId] += Weight(monitor.IntervalSec);
                onNode[nodeId].Add(monitor);
            }
            else
            {
                waiting.Add(monitor);
            }
        }

        var total = monitors.Sum(m => Weight(m.IntervalSec));
        var capacity = eligible.Sum(n => (double)n.Capacity);
        double Share(NodeSlot node) => total * node.Capacity / capacity;

        // Off the nodes that carry too much, lightest first, until each is back within its share.
        foreach (var node in eligible)
        {
            var limit = Share(node) * (1 + Tolerance);
            if (load[node.Id] <= limit)
            {
                continue;
            }

            foreach (var monitor in onNode[node.Id].OrderBy(m => Weight(m.IntervalSec)).ThenBy(m => m.Id))
            {
                if (load[node.Id] <= Share(node))
                {
                    break;
                }

                load[node.Id] -= Weight(monitor.IntervalSec);
                waiting.Add(monitor);
            }

            onNode[node.Id].RemoveAll(waiting.Contains);
        }

        foreach (var (nodeId, list) in onNode)
        {
            foreach (var monitor in list)
            {
                plan[monitor.Id] = nodeId;
            }
        }

        // The heaviest waiting monitors go first, each to the node with the most room per capacity.
        foreach (var monitor in waiting.OrderByDescending(m => Weight(m.IntervalSec)).ThenBy(m => m.Id))
        {
            var target = eligible.OrderBy(n => load[n.Id] / n.Capacity).ThenBy(n => n.Id).First();
            load[target.Id] += Weight(monitor.IntervalSec);
            plan[monitor.Id] = target.Id;
        }

        return plan;
    }

    /// <summary>
    /// The node that should confirm a problem another node saw: an eligible one in another region
    /// when there is one, else any other eligible node, else null (the server then trusts the first).
    /// The least loaded wins, so confirms spread out.
    /// </summary>
    public static long? PickConfirmer(IReadOnlyList<NodeSlot> nodes, long sawItNodeId, IReadOnlyDictionary<long, double>? load = null)
    {
        var region = nodes.FirstOrDefault(n => n.Id == sawItNodeId)?.Region;
        var others = nodes.Where(n => n.Eligible && n.Id != sawItNodeId).ToList();
        if (others.Count == 0)
        {
            return null;
        }

        var elsewhere = others.Where(n => !string.Equals(n.Region, region, StringComparison.Ordinal)).ToList();
        var pool = elsewhere.Count > 0 ? elsewhere : others;
        return pool
            .OrderBy(n => (load?.GetValueOrDefault(n.Id) ?? 0) / Math.Max(1, n.Capacity))
            .ThenBy(n => n.Id)
            .First().Id;
    }
}
