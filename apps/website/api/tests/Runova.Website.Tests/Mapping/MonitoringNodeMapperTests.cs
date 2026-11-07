using Runova.Website.Api.Monitoring;
using Runova.Website.Data.Monitoring;

namespace Runova.Website.Tests.Mapping;

public class MonitoringNodeMapperTests
{
    private static readonly DateTimeOffset _at = new(2026, 10, 1, 8, 0, 0, TimeSpan.Zero);

    private static MonitoringNode Node() => new()
    {
        Id = 4,
        Name = "eu-1",
        Region = "eu",
        Capacity = 50,
        Status = NodeStatuses.Online,
        Draining = true,
        EnrollmentTokenHash = [1, 2],
        EnrollmentTokenExpiresAt = _at.AddHours(1),
        AllowedAddresses = ["203.0.113.0/24"],
        EnrolledAt = _at,
        SoftwareVersion = "1.2.0",
        RemoteAddress = "203.0.113.7",
        ConnectedAt = _at,
        LastSeenAt = _at.AddMinutes(1),
        Monitors = 12,
        ChecksLastMinute = 30,
        QueuedResults = 1,
        LagMs = 40,
        CreatedAt = _at.AddDays(-1),
        Version = 6,
    };

    [Fact]
    public void A_node_shows_the_status_the_caller_gives_and_its_certificate_expiry()
    {
        var dto = MonitoringNodeMapper.ToDto(Node(), NodeStatuses.Offline, _at.AddDays(30));

        Assert.Equal(
            new MonitoringNodeDto(
                4, "eu-1", "eu", 50, "offline", true, "1.2.0", "203.0.113.7", _at, _at, _at.AddMinutes(1), 12, 30, 1, 40, dto.AllowedAddresses,
                _at.AddHours(1), _at.AddDays(30), _at.AddDays(-1), null, "6"),
            dto);
        Assert.Equal(["203.0.113.0/24"], dto.AllowedAddresses);
    }

    [Fact]
    public void The_enrollment_expiry_only_shows_while_a_token_waits()
    {
        var node = Node();
        node.EnrollmentTokenHash = null;

        Assert.Null(MonitoringNodeMapper.ToDto(node, node.Status, null).EnrollmentTokenExpiresAt);
    }

    [Fact]
    public void The_dto_carries_no_secret()
    {
        // When a waiting token runs out, never the token.
        Assert.Equal(["EnrollmentTokenExpiresAt"], SecretProperties.In(typeof(MonitoringNodeDto)));
    }
}
