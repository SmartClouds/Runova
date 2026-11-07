using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Firewall;
using static Runova.ServerCore.Tests.FirewallTestData;

namespace Runova.ServerCore.Tests.Mapping;

public sealed class FirewallMapperTests
{
    [Fact]
    public void A_rule_reaches_the_app_with_every_field()
    {
        var rule = Rule(FirewallAction.Deny, 6000, FirewallProtocol.Udp, "198.51.100.0/24", portTo: 6007) with
        {
            Comment = "x11",
            Service = "x11",
            Interface = "eth0",
            Destination = Network("192.0.2.10"),
            Outgoing = true,
        };

        var info = FirewallMapper.ToInfo(rule);

        Assert.Equal(
            new FirewallRuleInfo(
                rule.Id,
                FirewallAction.Deny,
                FirewallProtocol.Udp,
                FirewallFamilies.Ipv4,
                FirewallEvaluation.Describe(rule),
                true,
                6000,
                6007,
                "198.51.100.0/24",
                "x11",
                "x11",
                "eth0",
                "192.0.2.10",
                true,
                null),
            info);
    }

    [Fact]
    public void A_single_port_has_no_end_and_a_negated_source_shows_only_in_the_description()
    {
        var info = FirewallMapper.ToInfo(Rule(FirewallAction.Allow, 22, source: "10.0.0.0/8") with { SourceNegated = true, Unknown = "a source port" });

        Assert.Equal(22, info.Port);
        Assert.Null(info.PortTo);
        Assert.Null(info.Source);
        Assert.Null(info.Destination);
        Assert.Contains("everywhere but 10.0.0.0/8", info.Description, StringComparison.Ordinal);
        Assert.Equal("a source port", info.Note);

        var everything = FirewallMapper.ToInfo(Rule(FirewallAction.Allow, protocol: FirewallProtocol.Any) with { ReadOnlyReason = "made by hand", Unknown = "x" });
        Assert.Null(everything.Port);
        Assert.Equal("made by hand", everything.Note);
        Assert.False(everything.Editable);
    }

    [Fact]
    public void A_backup_keeps_what_it_takes_to_add_a_rule_again()
    {
        var info = new FirewallRuleInfo("id", FirewallAction.Allow, FirewallProtocol.Tcp, FirewallFamilies.Both, "Allow 80/tcp", true, 80, 81, "10.0.0.0/8", "web", Service: "http");

        Assert.Equal(new FirewallRuleSpec(FirewallAction.Allow, FirewallProtocol.Tcp, 80, 81, "10.0.0.0/8", "web"), FirewallMapper.ToSpec(info));
    }

    [Fact]
    public void A_change_set_shows_its_commands_and_who_asked_for_it()
    {
        var id = Guid.NewGuid();
        var row = new FirewallChangeSet
        {
            Id = id,
            Backend = FirewallBackendKind.Ufw,
            State = FirewallChangeState.RolledBack,
            Summary = "Allow 80/tcp",
            Changes = "[]",
            Commands = "[\"ufw allow 80/tcp\"]",
            CreatedAt = 1,
            DeadlineAt = 2,
            FinishedAt = 3,
            RequestedBy = Guid.NewGuid(),
            RequestedByName = "alice",
            AppliedOver = "ssh",
            AppliedFrom = "10.0.0.1",
            GuardOverridden = true,
            RolledBackBy = FirewallRollbackCause.Timer,
            Error = "lost the connection",
        };

        var info = FirewallMapper.ToInfo(row);

        Assert.Equal(id, info.Id);
        Assert.Equal(FirewallChangeState.RolledBack, info.State);
        Assert.Equal(FirewallBackendKind.Ufw, info.Backend);
        Assert.Equal("Allow 80/tcp", info.Summary);
        Assert.Equal(["ufw allow 80/tcp"], info.Commands);
        Assert.Equal(1, info.CreatedAtUnixMs);
        Assert.True(info.GuardOverridden);
        Assert.Equal(2, info.DeadlineUnixMs);
        Assert.Equal(3, info.FinishedAtUnixMs);
        Assert.Equal("alice", info.RequestedBy);
        Assert.Equal("10.0.0.1", info.AppliedFrom);
        Assert.Equal(FirewallRollbackCause.Timer, info.RolledBackBy);
        Assert.Equal("lost the connection", info.Error);

        row.Commands = "null";
        Assert.Empty(FirewallMapper.ToInfo(row).Commands);
    }
}
