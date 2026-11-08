using Runova.Website.Api.Remote;
using Runova.Website.Data.Remote;

namespace Runova.Website.Tests.Remote;

public class RemoteAccessTests
{
    [Fact]
    public void The_relation_is_own_teammate_or_other()
    {
        Assert.Equal(RemoteRelation.Own, RemoteAccess.RelationOf(callerUserId: 3, ownerUserId: 3, sharesVisibleTeam: false));
        Assert.Equal(RemoteRelation.Own, RemoteAccess.RelationOf(3, 3, sharesVisibleTeam: true));
        Assert.Equal(RemoteRelation.Teammate, RemoteAccess.RelationOf(4, 3, sharesVisibleTeam: true));
        Assert.Equal(RemoteRelation.Other, RemoteAccess.RelationOf(4, 3, sharesVisibleTeam: false));
    }

    [Theory]
    [InlineData(RemoteRelation.Own, RemoteAccessModes.Ask, false, true)]
    [InlineData(RemoteRelation.Teammate, RemoteAccessModes.Ask, false, true)]
    [InlineData(RemoteRelation.Other, RemoteAccessModes.Ask, true, false)]
    [InlineData(RemoteRelation.Other, RemoteAccessModes.Password, true, true)]
    [InlineData(RemoteRelation.Other, RemoteAccessModes.Password, false, false)]
    [InlineData(RemoteRelation.Teammate, RemoteAccessModes.Password, false, false)]
    [InlineData(RemoteRelation.Own, RemoteAccessModes.Password, true, true)]
    [InlineData(RemoteRelation.Own, "sneaky", true, false)]
    public void Who_may_ask_and_who_needs_the_password(RemoteRelation relation, string mode, bool unattendedEnabled, bool allowed)
    {
        Assert.Equal(allowed, RemoteAccess.MayRequest(relation, mode, unattendedEnabled));
    }

    [Theory]
    [InlineData(RemoteRelation.Own, false, true)]
    [InlineData(RemoteRelation.Teammate, false, true)]
    [InlineData(RemoteRelation.Other, true, true)]
    [InlineData(RemoteRelation.Other, false, false)]
    public void A_stranger_learns_nothing_about_a_computer_without_a_password(RemoteRelation relation, bool unattendedEnabled, bool reveals)
    {
        Assert.Equal(reveals, RemoteAccess.MayLearnOnline(relation, unattendedEnabled));
    }

    [Fact]
    public void The_relation_has_a_wire_name()
    {
        Assert.Equal(["own", "teammate", "other"], new[] { RemoteRelation.Own, RemoteRelation.Teammate, RemoteRelation.Other }.Select(RemoteAccess.WireName));
    }
}
