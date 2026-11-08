using Runova.Website.Api.Remote;
using Runova.Website.Data.Remote;

namespace Runova.Website.Tests.Remote;

public class RemotePresenceTests
{
    [Fact]
    public void A_device_is_online_through_its_newest_connection()
    {
        var presence = new RemotePresence();

        presence.Online(deviceId: 7, userId: 3, connectionId: "c1");
        presence.Online(7, 3, "c2");

        Assert.True(presence.IsOnline(7));
        Assert.Equal(new RemotePresence.Endpoint("c2", RemoteDeviceKinds.App), presence.EndpointOf(7));
        Assert.Equal(new RemotePresence.Entry(7, 3, RemoteDeviceKinds.App), presence.DeviceOf("c2"));
    }

    [Fact]
    public void A_replaced_connection_going_away_leaves_the_device_online()
    {
        var presence = new RemotePresence();
        presence.Online(7, 3, "c1");
        presence.Online(7, 3, "c2");

        Assert.Equal(PresenceChange.None, presence.Offline("c1").Change);
        Assert.True(presence.IsOnline(7));
    }

    [Fact]
    public void The_current_connection_going_away_takes_the_device_offline()
    {
        var presence = new RemotePresence();
        presence.Online(7, 3, "c1");

        var gone = presence.Offline("c1");

        Assert.Equal(new RemotePresence.Entry(7, 3, RemoteDeviceKinds.App), gone.Entry);
        Assert.Equal(PresenceChange.WentOffline, gone.Change);
        Assert.False(presence.IsOnline(7));
        Assert.Null(presence.EndpointOf(7));
        Assert.Null(presence.DeviceOf("c1"));
    }

    [Fact]
    public void The_app_answers_before_the_agent_and_the_agent_keeps_the_computer_online_alone()
    {
        var presence = new RemotePresence();
        presence.Online(7, 3, "agent", RemoteDeviceKinds.Agent);
        Assert.Equal(new RemotePresence.Endpoint("agent", RemoteDeviceKinds.Agent), presence.EndpointOf(7));

        presence.Online(7, 3, "app");
        Assert.Equal(new RemotePresence.Endpoint("app", RemoteDeviceKinds.App), presence.EndpointOf(7));

        Assert.Equal(PresenceChange.None, presence.Offline("app").Change);
        Assert.Equal(new RemotePresence.Endpoint("agent", RemoteDeviceKinds.Agent), presence.EndpointOf(7));
        Assert.True(presence.IsOnline(7));
    }

    [Fact]
    public void A_revoked_device_is_dropped_with_every_endpoint()
    {
        var presence = new RemotePresence();
        presence.Online(7, 3, "c1");
        presence.Online(7, 3, "a1", RemoteDeviceKinds.Agent);

        Assert.Equal(["a1", "c1"], presence.Remove(7).Order(StringComparer.Ordinal));
        Assert.False(presence.IsOnline(7));
        Assert.Null(presence.DeviceOf("c1"));
        Assert.Null(presence.DeviceOf("a1"));
    }

    [Fact]
    public void Only_the_agent_can_be_dropped()
    {
        var presence = new RemotePresence();
        presence.Online(7, 3, "c1");
        presence.Online(7, 3, "a1", RemoteDeviceKinds.Agent);

        Assert.Equal("a1", presence.RemoveAgent(7));
        Assert.Equal(new RemotePresence.Endpoint("c1", RemoteDeviceKinds.App), presence.EndpointOf(7));
    }
}
