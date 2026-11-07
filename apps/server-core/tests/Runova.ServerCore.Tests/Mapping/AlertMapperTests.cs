using Runova.ServerCore.Alerts;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Tests.Mapping;

public sealed class AlertMapperTests
{
    [Fact]
    public void An_alert_reaches_the_app_with_every_field_and_the_acknowledgers_name()
    {
        var alert = new Alert
        {
            Id = 7,
            Revision = 42,
            Kind = AlertKind.DiskPressure,
            Severity = AlertSeverity.Critical,
            Resource = "/var",
            Message = "The disk is 97% full.",
            FirstSeenAt = 1_000,
            LastSeenAt = 2_000,
            Occurrences = 3,
            AcknowledgedAt = 3_000,
            AcknowledgedBy = Guid.NewGuid(),
            AcknowledgedByName = "alice",
            ResolvedAt = 4_000,
        };

        var info = AlertMapper.ToInfo(alert);

        Assert.Equal(
            new AlertInfo(7, 42, AlertKind.DiskPressure, AlertSeverity.Critical, "/var", "The disk is 97% full.", 1_000, 2_000, 3, 3_000, "alice", 4_000),
            info);
    }

    [Fact]
    public void An_open_alert_has_no_acknowledgment_or_resolution()
    {
        var info = AlertMapper.ToInfo(new Alert { Kind = AlertKind.DiskPressure, Resource = "/", Message = "full", FirstSeenAt = 1, LastSeenAt = 1, Occurrences = 1 });

        Assert.Null(info.AcknowledgedAtUnixMs);
        Assert.Null(info.AcknowledgedBy);
        Assert.Null(info.ResolvedAtUnixMs);
    }
}
