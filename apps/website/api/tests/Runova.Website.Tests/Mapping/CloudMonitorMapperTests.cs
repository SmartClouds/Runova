using Runova.Website.Api.CloudMonitoring;
using Runova.Website.Core.Monitoring;
using Runova.Website.Data.Monitoring;

namespace Runova.Website.Tests.Mapping;

public class CloudMonitorMapperTests
{
    private static readonly DateTimeOffset _at = new(2026, 10, 1, 8, 0, 0, TimeSpan.Zero);

    private static readonly CloudMonitorStatusDto _status = new("up", "ok", _at, 120, 200, null, "eu", false, null, 0.9987);

    private static readonly MonitoringNode _node = new() { Id = 4, Name = "eu-1", Region = "eu", Capacity = 50, EnrollmentTokenHash = [1] };

    private static CloudMonitor Monitor() => new()
    {
        Id = 9,
        ScopeId = 5,
        ItemId = "srv-1",
        Name = "API",
        ProjectName = "Shop",
        EnvironmentName = "prod",
        Url = "https://shop.example.com/health",
        IntervalSec = 60,
        TimeoutSec = 10,
        AuthMode = CloudAuthModes.Bearer,
        SealedSecret = "sealed",
        SecretChangedAt = _at,
        AllowInsecure = true,
        Paused = false,
        SuspendedReason = null,
        NotifyInApp = true,
        NotifyTelegram = false,
        DefinitionVersion = 3,
        CreatedAt = _at,
        UpdatedAt = _at.AddHours(1),
        Version = 21,
    };

    [Fact]
    public void A_monitor_shows_whether_it_has_a_key_and_takes_the_rest_from_the_caller()
    {
        var dto = CloudMonitorMapper.ToDto(Monitor(), _status, muted: true, canWrite: false);

        Assert.Equal(
            new CloudMonitorDto(
                9, 5, "srv-1", "API", "Shop", "prod", "https://shop.example.com/health", 60, 10, "bearer", true, _at, true, false, null, true, false,
                true, false, _status, _at, _at.AddHours(1), "21"),
            dto);
        Assert.Equal(new CloudMonitorLiveDto(9, 5, "srv-1", false, _status), CloudMonitorMapper.ToLiveDto(dto));
    }

    [Fact]
    public void A_sample_and_an_incident_project_with_the_regions_of_their_nodes_when_known()
    {
        var sample = new CloudMonitorSample { Id = Guid.NewGuid(), MonitorId = 9, CheckedAt = _at, State = "fail", LatencyMs = 300, HttpStatus = 503, NodeId = 4, Problem = "HTTP 503" };
        var incident = new CloudMonitorIncident { Id = 2, MonitorId = 9, OpenedAt = _at, ResolvedAt = null, State = "fail", Problem = "HTTP 503", NodeId = 4 };

        var samples = new[] { new CloudMonitorSampleRow { Sample = sample, Node = _node }, new CloudMonitorSampleRow { Sample = sample } }.AsQueryable().ProjectToDto().ToList();
        var incidents = new[] { new CloudMonitorIncidentRow { Incident = incident, SeenBy = _node } }.AsQueryable().ProjectToDto().ToList();

        Assert.Equal([new CloudMonitorSampleDto(_at, "fail", 300, 503, "eu", "HTTP 503"), new CloudMonitorSampleDto(_at, "fail", 300, 503, null, "HTTP 503")], samples);
        Assert.Equal(new CloudMonitorIncidentDto(2, 9, _at, null, "fail", "HTTP 503", "eu", null), Assert.Single(incidents));
    }

    [Fact]
    public void An_hour_works_out_its_latencies_only_when_it_has_some()
    {
        var hour = new CloudMonitorHour { MonitorId = 9, Hour = _at, Checks = 60, Failures = 2, Warnings = 1, LatencySumMs = 1001, LatencyCount = 2, LatencyMaxMs = 700 };
        var quiet = new CloudMonitorHour { MonitorId = 9, Hour = _at, Checks = 60, LatencyMaxMs = 0 };

        Assert.Equal(new CloudMonitorHourDto(_at, 60, 2, 1, 500, 700), CloudMonitorMapper.ToDto(hour));
        Assert.Equal(new CloudMonitorHourDto(_at, 60, 0, 0, null, null), CloudMonitorMapper.ToDto(quiet));
    }

    [Fact]
    public void A_definition_carries_the_opened_key_and_no_mode_for_none()
    {
        var definition = CloudMonitorMapper.ToDefinition(Monitor(), "token");
        var open = Monitor();
        open.AuthMode = CloudAuthModes.None;

        Assert.Equal(
            (9L, 3L, "https://shop.example.com/health", 60, 10, "bearer", "token", true),
            (definition.Id, definition.Version, definition.Url, definition.IntervalSec, definition.TimeoutSec, definition.AuthMode, definition.Secret, definition.AllowInsecure));
        Assert.Equal("", CloudMonitorMapper.ToDefinition(open, "").AuthMode);
    }

    [Fact]
    public void A_monitor_and_a_node_map_to_what_messages_plans_and_assignment_need()
    {
        Assert.Equal(new MonitorLabel("API", "Shop", "prod"), CloudMonitorMapper.ToLabel(Monitor()));
        Assert.Equal(new EnforcedMonitor(9, _at, 60, false), CloudMonitorMapper.ToEnforced(Monitor()));
        Assert.Equal(new NodeSlot(4, "eu", 50, true), CloudMonitorMapper.ToSlot(_node, eligible: true));
    }

    [Fact]
    public void The_dtos_carry_no_secret()
    {
        // Whether there is a key and when it changed, never the key.
        Assert.Equal(["HasSecret", "SecretChangedAt"], SecretProperties.In(typeof(CloudMonitorDto)));
        Assert.Empty(SecretProperties.In(typeof(CloudMonitorLiveDto)));
        Assert.Empty(SecretProperties.In(typeof(CloudMonitorSampleDto)));
        Assert.Empty(SecretProperties.In(typeof(CloudMonitorHourDto)));
    }
}
