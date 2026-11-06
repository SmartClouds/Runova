using Runova.Website.Core.Monitoring;

namespace Runova.Website.Tests.Monitoring;

public sealed class MonitorDistributionTests
{
    private static NodeSlot Node(long id, string region = "eu", int capacity = 100, bool eligible = true) =>
        new(id, region, capacity, eligible);

    private static List<MonitorSlot> Monitors(int count, int interval = 60, long? nodeId = null, long firstId = 1) =>
        [.. Enumerable.Range(0, count).Select(i => new MonitorSlot(firstId + i, interval, nodeId))];

    private static Dictionary<long, int> CountPerNode(IReadOnlyDictionary<long, long?> plan) =>
        plan.Values.Where(v => v is not null).GroupBy(v => v!.Value).ToDictionary(g => g.Key, g => g.Count());

    [Fact]
    public void New_monitors_spread_evenly_over_equal_nodes()
    {
        var plan = MonitorDistribution.Plan([Node(1), Node(2), Node(3)], Monitors(30));

        Assert.All(CountPerNode(plan).Values, count => Assert.Equal(10, count));
    }

    [Fact]
    public void A_bigger_node_gets_more()
    {
        var plan = MonitorDistribution.Plan([Node(1, capacity: 100), Node(2, capacity: 300)], Monitors(40));

        var counts = CountPerNode(plan);
        Assert.Equal(10, counts[1]);
        Assert.Equal(30, counts[2]);
    }

    [Fact]
    public void A_fast_monitor_weighs_more_than_a_slow_one()
    {
        // One 30 second monitor weighs as much as ten 5 minute ones.
        List<MonitorSlot> monitors = [new(1, 30, null), .. Monitors(10, interval: 300, firstId: 2)];

        var plan = MonitorDistribution.Plan([Node(1), Node(2)], monitors);

        var fastNode = plan[1];
        Assert.All(monitors.Skip(1), m => Assert.NotEqual(fastNode, plan[m.Id]));
    }

    [Fact]
    public void Monitors_stay_put_within_the_tolerance()
    {
        // 11 against 9 is 10 percent over the share: nothing moves.
        var monitors = Monitors(11, nodeId: 1).Concat(Monitors(9, nodeId: 2, firstId: 100)).ToList();

        var plan = MonitorDistribution.Plan([Node(1), Node(2)], monitors);

        Assert.All(monitors, m => Assert.Equal(m.NodeId, plan[m.Id]));
    }

    [Fact]
    public void A_new_node_takes_load_only_past_the_tolerance()
    {
        var monitors = Monitors(30, nodeId: 1);

        var plan = MonitorDistribution.Plan([Node(1), Node(2)], monitors);

        var counts = CountPerNode(plan);
        Assert.Equal(15, counts[1]);
        Assert.Equal(15, counts[2]);
    }

    [Fact]
    public void Monitors_of_a_node_that_went_away_move_to_the_others()
    {
        var monitors = Monitors(6, nodeId: 1).Concat(Monitors(6, nodeId: 2, firstId: 100)).ToList();

        var plan = MonitorDistribution.Plan([Node(1, eligible: false), Node(2), Node(3)], monitors);

        Assert.DoesNotContain(plan.Values, v => v == 1);
        Assert.All(monitors.Where(m => m.NodeId == 2), m => Assert.Equal(2, plan[m.Id]));
        Assert.Equal(6, CountPerNode(plan)[3]);
    }

    [Fact]
    public void With_no_node_nothing_is_assigned()
    {
        var plan = MonitorDistribution.Plan([Node(1, eligible: false)], Monitors(3, nodeId: 1));

        Assert.All(plan.Values, Assert.Null);
    }

    [Fact]
    public void The_plan_is_the_same_each_time()
    {
        NodeSlot[] nodes = [Node(1), Node(2), Node(3, capacity: 50)];
        var monitors = Monitors(17, interval: 45).Concat(Monitors(5, interval: 600, firstId: 50)).ToList();

        Assert.Equal(MonitorDistribution.Plan(nodes, monitors), MonitorDistribution.Plan(nodes, monitors));
    }

    [Fact]
    public void A_confirm_goes_to_another_region_first()
    {
        NodeSlot[] nodes = [Node(1, "eu"), Node(2, "eu"), Node(3, "us")];

        Assert.Equal(3, MonitorDistribution.PickConfirmer(nodes, 1));
    }

    [Fact]
    public void A_confirm_falls_back_to_the_same_region_then_to_none()
    {
        Assert.Equal(2, MonitorDistribution.PickConfirmer([Node(1, "eu"), Node(2, "eu"), Node(3, "us", eligible: false)], 1));
        Assert.Null(MonitorDistribution.PickConfirmer([Node(1, "eu")], 1));
    }

    [Fact]
    public void A_confirm_goes_to_the_least_loaded_node()
    {
        NodeSlot[] nodes = [Node(1, "eu"), Node(2, "us"), Node(3, "asia")];

        Assert.Equal(3, MonitorDistribution.PickConfirmer(nodes, 1, new Dictionary<long, double> { [2] = 5, [3] = 1 }));
    }
}
