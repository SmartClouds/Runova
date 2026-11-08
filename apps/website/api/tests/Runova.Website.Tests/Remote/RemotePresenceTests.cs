using Runova.Website.Api.Remote;

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
        Assert.Equal("c2", presence.ConnectionOf(7));
        Assert.Equal(new RemotePresence.Entry(7, 3), presence.DeviceOf("c2"));
    }

    [Fact]
    public void A_replaced_connection_going_away_leaves_the_device_online()
    {
        var presence = new RemotePresence();
        presence.Online(7, 3, "c1");
        presence.Online(7, 3, "c2");

        Assert.Null(presence.Offline("c1"));
        Assert.True(presence.IsOnline(7));
    }

    [Fact]
    public void The_current_connection_going_away_takes_the_device_offline()
    {
        var presence = new RemotePresence();
        presence.Online(7, 3, "c1");

        Assert.Equal(new RemotePresence.Entry(7, 3), presence.Offline("c1"));
        Assert.False(presence.IsOnline(7));
        Assert.Null(presence.ConnectionOf(7));
        Assert.Null(presence.DeviceOf("c1"));
    }

    [Fact]
    public void A_revoked_device_is_dropped()
    {
        var presence = new RemotePresence();
        presence.Online(7, 3, "c1");

        Assert.Equal("c1", presence.Remove(7));
        Assert.False(presence.IsOnline(7));
        Assert.Null(presence.DeviceOf("c1"));
    }
}
