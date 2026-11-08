using Runova.Website.Api.Remote;
using Runova.Website.Data.Identity;
using Runova.Website.Data.Remote;

namespace Runova.Website.Tests.Mapping;

public class RemoteMapperTests
{
    private static readonly DateTimeOffset _at = new(2026, 11, 8, 9, 0, 0, TimeSpan.Zero);

    private static readonly AppUser _sam = new()
    {
        Id = 3,
        Email = "sam@example.com",
        DisplayName = "Sam",
        PasswordHash = "hash",
        SecurityStamp = "stamp",
    };

    private static RemoteDevice Device() => new()
    {
        Id = 7,
        UserId = 3,
        RemoteId = "482193775",
        DeviceId = Guid.Parse("8a9f6c2e-5b1d-4a7e-9c3f-2d1e0b4a6c58"),
        Kind = RemoteDeviceKinds.App,
        Name = "Sam's laptop",
        Platform = "windows",
        IdentityKey = "1pqHXcPHQKOHQ3xd0D6aiuWhPVE2t3n5mpg0wzBHTSI",
        AllowOwnDevices = true,
        UnattendedEnabled = true,
        AgentIdentityKey = "agentKey",
        AgentSecretHash = [1, 2, 3],
        CreatedAt = _at,
        LastSeenAt = _at.AddHours(1),
    };

    [Fact]
    public void An_own_device_takes_its_teams_and_presence_from_the_caller()
    {
        Assert.Equal(
            new RemoteDeviceDto(7, "482193775", "Sam's laptop", "windows", "app", "1pqHXcPHQKOHQ3xd0D6aiuWhPVE2t3n5mpg0wzBHTSI", true, true, [2, 5], true, "agentKey", _at, _at.AddHours(1)),
            RemoteMapper.ToDto(Device(), [2, 5], online: true),
            new RemoteDeviceDtoComparer());
    }

    [Fact]
    public void A_directory_entry_carries_its_owner_and_teams()
    {
        var owner = RemoteMapper.ToOwner(_sam);
        var entry = RemoteMapper.ToEntry(Device(), owner, [new RemoteTeamDto(2, "Ops")], online: false);

        Assert.Equal(new RemoteOwnerDto(3, "Sam", "sam@example.com"), owner);
        Assert.Equal(7, entry.Id);
        Assert.Equal("482193775", entry.RemoteId);
        Assert.Equal("Sam's laptop", entry.Name);
        Assert.Equal("windows", entry.Platform);
        Assert.Equal("app", entry.Kind);
        Assert.Equal("1pqHXcPHQKOHQ3xd0D6aiuWhPVE2t3n5mpg0wzBHTSI", entry.IdentityKey);
        Assert.True(entry.UnattendedEnabled);
        Assert.False(entry.Online);
        Assert.Equal(_at.AddHours(1), entry.LastSeenAt);
        Assert.Equal(owner, entry.Owner);
        Assert.Equal([new RemoteTeamDto(2, "Ops")], entry.Teams);
    }

    [Fact]
    public void An_owner_with_no_email_gets_an_empty_one()
    {
        Assert.Equal(new RemoteOwnerDto(4, "Kim", ""), RemoteMapper.ToOwner(new AppUser { Id = 4, DisplayName = "Kim" }));
    }

    [Fact]
    public void A_host_shows_only_what_a_controller_needs()
    {
        Assert.Equal(
            new RemoteHostDto("482193775", "Sam's laptop", "windows", "app", "1pqHXcPHQKOHQ3xd0D6aiuWhPVE2t3n5mpg0wzBHTSI"),
            RemoteMapper.ToHost(Device()));
    }

    [Fact]
    public void A_peer_is_the_account_and_the_computer_it_connects_from()
    {
        var withDevice = RemoteMapper.ToPeer(new RemotePeerRow { User = _sam, Device = Device() });
        var withoutDevice = RemoteMapper.ToPeer(new RemotePeerRow { User = _sam, Device = null });

        Assert.Equal(new RemotePeerDto(3, "Sam", "sam@example.com", "Sam's laptop", "windows", "482193775", "1pqHXcPHQKOHQ3xd0D6aiuWhPVE2t3n5mpg0wzBHTSI"), withDevice);
        Assert.Equal(new RemotePeerDto(3, "Sam", "sam@example.com", null, null, null, null), withoutDevice);
    }

    [Fact]
    public void A_session_record_projects_with_both_sides()
    {
        var row = new RemoteSessionRow
        {
            Record = new RemoteSessionRecord
            {
                Id = 11,
                HostDeviceId = 7,
                HostUserId = 3,
                ControllerUserId = 4,
                ControllerDeviceId = 9,
                Mode = RemoteAccessModes.Password,
                Transport = RemoteTransports.Relay,
                StartedAt = _at,
                EndedAt = _at.AddMinutes(12),
            },
            Role = "host",
            HostDevice = Device(),
            HostUser = _sam,
            ControllerUser = new AppUser { Id = 4, DisplayName = "Kim", Email = "kim@example.com" },
        };
        var expected = new RemoteSessionDto(11, "host", "password", "relay", "482193775", "Sam's laptop", "Sam", "Kim", "kim@example.com", _at, _at.AddMinutes(12));

        Assert.Equal(expected, RemoteMapper.ToDto(row));
        Assert.Equal(expected, Assert.Single(new[] { row }.AsQueryable().ProjectToDto()));
    }

    [Fact]
    public void The_dtos_carry_no_secret()
    {
        Assert.Empty(SecretProperties.In(typeof(RemoteDeviceDto)));
        Assert.Empty(SecretProperties.In(typeof(RemoteDirectoryEntryDto)));
        Assert.Empty(SecretProperties.In(typeof(RemoteHostDto)));
        Assert.Empty(SecretProperties.In(typeof(RemotePeerDto)));
        Assert.Empty(SecretProperties.In(typeof(RemoteSessionDto)));
        Assert.Empty(SecretProperties.In(typeof(IncomingRequestDto)));
    }

    /// <summary>Records compare lists by reference, so the team ids are compared by value here.</summary>
    private sealed class RemoteDeviceDtoComparer : IEqualityComparer<RemoteDeviceDto>
    {
        public bool Equals(RemoteDeviceDto? x, RemoteDeviceDto? y) =>
            x is not null && y is not null && x with { TeamIds = Array.Empty<long>() } == y with { TeamIds = Array.Empty<long>() } && x.TeamIds.SequenceEqual(y.TeamIds);

        public int GetHashCode(RemoteDeviceDto obj) => obj.Id.GetHashCode();
    }
}
