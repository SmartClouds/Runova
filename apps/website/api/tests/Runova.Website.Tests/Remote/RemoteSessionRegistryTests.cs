using Runova.Website.Api.Remote;
using Runova.Website.Data.Remote;

namespace Runova.Website.Tests.Remote;

public class RemoteSessionRegistryTests
{
    private readonly ManualTime _time = new(new DateTimeOffset(2026, 11, 8, 9, 0, 0, TimeSpan.Zero));

    private static RemoteSession Open(RemoteSessionRegistry registry, string controller = "ctl", string host = "host") =>
        registry.Open(new RemoteSessionParties(
            HostDeviceId: 7,
            HostUserId: 3,
            HostConnectionId: host,
            ControllerUserId: 4,
            ControllerDeviceId: 9,
            ControllerConnectionId: controller,
            Mode: RemoteAccessModes.Ask));

    [Fact]
    public void A_session_has_an_unguessable_id_and_starts_ringing()
    {
        var registry = new RemoteSessionRegistry(_time);

        var first = Open(registry);
        var second = Open(registry);

        Assert.Matches("^[A-Za-z0-9_-]{22}$", first.Id);
        Assert.NotEqual(first.Id, second.Id);
        Assert.Equal(RemoteSessionState.Ringing, first.State);
        Assert.Same(first, registry.Get(first.Id));
    }

    [Fact]
    public void Only_the_host_can_accept_and_only_once()
    {
        var registry = new RemoteSessionRegistry(_time);
        var session = Open(registry);

        Assert.Null(registry.Accept(session.Id, "ctl"));
        Assert.Same(session, registry.Accept(session.Id, "host"));
        Assert.Equal(RemoteSessionState.Accepted, session.State);
        Assert.Null(registry.Accept(session.Id, "host"));
    }

    [Fact]
    public void The_other_side_is_found_only_for_a_party()
    {
        var registry = new RemoteSessionRegistry(_time);
        var session = Open(registry);

        Assert.Equal("host", registry.OtherSide(session.Id, "ctl"));
        Assert.Equal("ctl", registry.OtherSide(session.Id, "host"));
        Assert.Null(registry.OtherSide(session.Id, "someone-else"));
        Assert.Null(registry.OtherSide("no-such-session", "ctl"));
    }

    [Fact]
    public void Signals_flow_only_once_the_host_accepted()
    {
        var registry = new RemoteSessionRegistry(_time);
        var session = Open(registry);

        Assert.Null(registry.SignalTarget(session.Id, "ctl"));
        registry.Accept(session.Id, "host");

        Assert.Equal("host", registry.SignalTarget(session.Id, "ctl"));
        Assert.Equal("ctl", registry.SignalTarget(session.Id, "host"));
        Assert.Null(registry.SignalTarget(session.Id, "someone-else"));
    }

    [Fact]
    public void A_party_leaving_ends_every_session_it_was_in()
    {
        var registry = new RemoteSessionRegistry(_time);
        var one = Open(registry, controller: "ctl-1");
        var two = Open(registry, controller: "ctl-2");
        var other = Open(registry, controller: "ctl-3", host: "other-host");

        var ended = registry.RemoveFor("host");

        Assert.Equal(new[] { one.Id, two.Id }.Order(StringComparer.Ordinal), ended.Select(s => s.Id).Order(StringComparer.Ordinal));
        Assert.Null(registry.Get(one.Id));
        Assert.Same(other, registry.Get(other.Id));
    }

    [Fact]
    public void Ringing_stops_after_a_minute_but_a_live_session_stays()
    {
        var registry = new RemoteSessionRegistry(_time);
        var ringing = Open(registry);
        var live = Open(registry, controller: "ctl-2");
        registry.Accept(live.Id, "host");

        _time.Advance(TimeSpan.FromSeconds(59));
        Assert.Empty(registry.ExpireRinging());
        _time.Advance(TimeSpan.FromSeconds(2));
        var expired = registry.ExpireRinging();

        Assert.Equal(ringing.Id, Assert.Single(expired).Id);
        Assert.Null(registry.Get(ringing.Id));
        Assert.Same(live, registry.Get(live.Id));
    }

    [Fact]
    public void A_party_counts_its_open_sessions()
    {
        var registry = new RemoteSessionRegistry(_time);
        Open(registry);
        Open(registry);

        Assert.Equal(2, registry.CountFor("ctl"));
        Assert.Equal(2, registry.CountFor("host"));
        Assert.Equal(0, registry.CountFor("nobody"));
    }
}
