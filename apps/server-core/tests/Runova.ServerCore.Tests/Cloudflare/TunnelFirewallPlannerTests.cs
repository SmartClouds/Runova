using System.Net;
using Runova.ServerCore.Cloudflare;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Firewall;
using static Runova.ServerCore.Tests.FirewallTestData;

namespace Runova.ServerCore.Tests.Cloudflare;

/// <summary>
/// E95 in the planner: with the tunnel on, nothing from outside reaches the web ports or Direct
/// TLS, the origin lock's Cloudflare rules go with them, and SSH ends up open, closed, reachable
/// over loopback only (through the tunnel) or from Cloudflare Mesh only, as chosen. Planning again
/// changes nothing, and turning the tunnel off opens what it closed.
/// </summary>
public sealed class TunnelFirewallPlannerTests
{
    private static readonly int[] _web = [80, 443, 7443];

    private static readonly int[] _ssh = [22];

    private static readonly IPAddress _loopback = IPAddress.Loopback;

    private static readonly IPAddress _meshPeer = IPAddress.Parse("100.96.0.5");

    private static FirewallState Open() =>
        Ufw(rules: [Allow(22), Allow(80), Allow(443), Allow(7443)]);

    private static FirewallState Applied(FirewallState state, TunnelFirewallPlan plan) =>
        plan.Changes.Count == 0 ? state : FirewallChangePlanner.Plan(state, plan.Changes).Result;

    private static bool Reaches(FirewallState state, IPAddress address, int port) =>
        FirewallEvaluation.Evaluate(state, new Probe(address, port, FirewallProtocol.Tcp)).Allowed;

    private static bool Reaches(FirewallState state, string address, int port) => Reaches(state, IPAddress.Parse(address), port);

    [Fact]
    public void Closing_the_web_ports_removes_every_rule_that_lets_anyone_reach_them_and_keeps_ssh()
    {
        var plan = TunnelFirewallPlanner.PlanWeb(Open(), _web);
        var closed = Applied(Open(), plan);

        Assert.Equal(3, plan.Changes.Count);
        Assert.All(plan.Changes, change => Assert.Equal(FirewallChangeKind.RemoveRule, change.Kind));
        foreach (var port in _web)
        {
            Assert.False(Reaches(closed, "198.51.100.7", port));
            Assert.False(Reaches(closed, App, port));
            Assert.False(Reaches(closed, "2001:db8:1::1", port));
            Assert.True(Reaches(closed, _loopback, port));
        }

        Assert.True(Reaches(closed, App, 22));
        Assert.True(TunnelFirewallPlanner.CompareWeb(closed, _web).Matches);
    }

    [Fact]
    public void The_origin_locks_cloudflare_rules_go_too()
    {
        var locked = Ufw(rules:
        [
            Allow(22),
            Rule(FirewallAction.Allow, 80, source: "173.245.48.0/20") with { Comment = OriginLockPlanner.Comment },
            Rule(FirewallAction.Allow, 443, source: "173.245.48.0/20") with { Comment = OriginLockPlanner.Comment },
            Rule(FirewallAction.Allow, 443, source: "2400:cb00::/32") with { Comment = OriginLockPlanner.Comment },
        ]);

        var closed = Applied(locked, TunnelFirewallPlanner.PlanWeb(locked, _web));

        Assert.False(Reaches(closed, "173.245.48.10", 80));
        Assert.False(Reaches(closed, "173.245.48.10", 443));
        Assert.False(Reaches(closed, "2400:cb00::1", 443));
        Assert.True(TunnelFirewallPlanner.CompareWeb(closed, _web).Matches);
    }

    [Fact]
    public void Planning_again_once_closed_changes_nothing()
    {
        var closed = Applied(Open(), TunnelFirewallPlanner.PlanWeb(Open(), _web));

        Assert.Empty(TunnelFirewallPlanner.PlanWeb(closed, _web).Changes);
    }

    [Fact]
    public void A_firewall_that_is_off_or_lets_everything_in_is_refused()
    {
        var off = Assert.Throws<FirewallRefusedException>(() => TunnelFirewallPlanner.PlanWeb(Ufw(active: false), _web));
        var allowAll = Assert.Throws<FirewallRefusedException>(() => TunnelFirewallPlanner.PlanWeb(Ufw(incoming: FirewallPolicy.Allow), _web));

        Assert.Contains("firewall is off", off.Message, StringComparison.Ordinal);
        Assert.Contains("default", allowAll.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void A_rule_over_several_ports_is_named_not_removed()
    {
        var state = Ufw(rules: [Allow(22), Rule(FirewallAction.Allow, 80, portTo: 443)]);

        var plan = TunnelFirewallPlanner.PlanWeb(state, _web);

        Assert.Empty(plan.Changes);
        var note = Assert.Single(plan.Notes);
        Assert.Contains("80-443/tcp", note, StringComparison.Ordinal);
        Assert.False(TunnelFirewallPlanner.CompareWeb(state, _web).Matches);
    }

    [Fact]
    public void A_rule_the_core_cannot_change_is_named_with_why()
    {
        var state = Ufw(rules: [Allow(22), Allow(443) with { ReadOnlyReason = "it has a source port" }]);

        var plan = TunnelFirewallPlanner.PlanWeb(state, _web);

        Assert.Empty(plan.Changes);
        Assert.Contains("it has a source port", Assert.Single(plan.Notes), StringComparison.Ordinal);
    }

    [Fact]
    public void Firewalld_service_rules_for_http_and_https_are_removed()
    {
        var state = Firewalld(rules:
        [
            Allow(22, shape: "service") with { Service = "ssh" },
            Allow(80, shape: "service") with { Service = "http" },
            Allow(443, shape: "service") with { Service = "https" },
        ]);

        var closed = Applied(state, TunnelFirewallPlanner.PlanWeb(state, _web));

        Assert.False(Reaches(closed, "198.51.100.7", 80));
        Assert.False(Reaches(closed, "198.51.100.7", 443));
        Assert.True(Reaches(closed, App, 22));
    }

    [Theory]
    [InlineData(TunnelSshMode.Closed)]
    [InlineData(TunnelSshMode.Cloudflare)]
    public void Closed_and_cloudflare_ssh_leave_only_loopback_and_the_guard_accepts_a_tunnel_connection(TunnelSshMode mode)
    {
        var web = Applied(Open(), TunnelFirewallPlanner.PlanWeb(Open(), _web));

        var plan = TunnelFirewallPlanner.PlanSsh(web, mode, _ssh);
        var after = Applied(web, plan);

        Assert.False(Reaches(after, App, 22));
        Assert.False(Reaches(after, "2001:db8:1::1", 22));
        Assert.True(Reaches(after, _loopback, 22));
        Assert.False(LockoutGuard.Check(after, new SshAccess([_loopback], [22], [22])).Blocked);
        Assert.True(LockoutGuard.Check(after, Access()).Blocked);
        Assert.True(TunnelFirewallPlanner.CompareSsh(after, mode, _ssh).Matches);
    }

    [Fact]
    public void Mesh_ssh_lets_only_the_mesh_range_in()
    {
        var web = Applied(Open(), TunnelFirewallPlanner.PlanWeb(Open(), _web));

        var plan = TunnelFirewallPlanner.PlanSsh(web, TunnelSshMode.Mesh, _ssh);
        var after = Applied(web, plan);

        var added = Assert.Single(plan.Changes, change => change.Kind == FirewallChangeKind.AddRule);
        Assert.Equal(TunnelFirewallPlanner.MeshRange, added.Rule!.Source);
        Assert.Equal(TunnelFirewallPlanner.MeshComment, added.Rule.Comment);
        Assert.True(Reaches(after, _meshPeer, 22));
        Assert.False(Reaches(after, App, 22));
        Assert.False(LockoutGuard.Check(after, new SshAccess([_meshPeer], [22], [22])).Blocked);
        Assert.Empty(TunnelFirewallPlanner.PlanSsh(after, TunnelSshMode.Mesh, _ssh).Changes);
    }

    [Fact]
    public void Going_from_mesh_back_to_open_removes_the_mesh_rule_and_opens_ssh()
    {
        var web = Applied(Open(), TunnelFirewallPlanner.PlanWeb(Open(), _web));
        var mesh = Applied(web, TunnelFirewallPlanner.PlanSsh(web, TunnelSshMode.Mesh, _ssh));

        var open = Applied(mesh, TunnelFirewallPlanner.PlanSsh(mesh, TunnelSshMode.Open, _ssh));

        Assert.True(Reaches(open, App, 22));
        Assert.DoesNotContain(open.Rules, rule => rule.Comment == TunnelFirewallPlanner.MeshComment);
    }

    [Fact]
    public void Open_ssh_changes_nothing_when_ssh_is_already_open()
    {
        var web = Applied(Open(), TunnelFirewallPlanner.PlanWeb(Open(), _web));

        Assert.Empty(TunnelFirewallPlanner.PlanSsh(web, TunnelSshMode.Open, _ssh).Changes);
    }

    [Fact]
    public void Turning_off_opens_the_web_ports_and_ssh_to_everyone_again()
    {
        var web = Applied(Open(), TunnelFirewallPlanner.PlanWeb(Open(), _web));
        var closed = Applied(web, TunnelFirewallPlanner.PlanSsh(web, TunnelSshMode.Mesh, _ssh));

        var off = Applied(closed, TunnelFirewallPlanner.PlanOff(closed, [80, 443], _ssh, reopenWeb: true));

        Assert.True(Reaches(off, "198.51.100.7", 80));
        Assert.True(Reaches(off, "198.51.100.7", 443));
        Assert.False(Reaches(off, "198.51.100.7", 7443));
        Assert.True(Reaches(off, App, 22));
        Assert.DoesNotContain(off.Rules, rule => rule.Comment == TunnelFirewallPlanner.MeshComment);
    }

    [Fact]
    public void Turning_off_for_the_origin_lock_leaves_the_web_ports_to_the_lock()
    {
        var web = Applied(Open(), TunnelFirewallPlanner.PlanWeb(Open(), _web));

        var plan = TunnelFirewallPlanner.PlanOff(web, [80, 443], _ssh, reopenWeb: false);

        Assert.Empty(plan.Changes);
    }
}
