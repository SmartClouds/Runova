using System.Globalization;
using Riok.Mapperly.Abstractions;
using Runova.Monitoring.Contracts.Grpc;
using Runova.Website.Core.Monitoring;
using Runova.Website.Data.Monitoring;

namespace Runova.Website.Api.CloudMonitoring;

/// <summary>A sample joined with the node that took it, if that node is still known.</summary>
internal sealed record CloudMonitorSampleRow
{
    public required CloudMonitorSample Sample { get; init; }

    public MonitoringNode? Node { get; init; }
}

/// <summary>An incident joined with the nodes that saw and confirmed it, if known.</summary>
internal sealed record CloudMonitorIncidentRow
{
    public required CloudMonitorIncident Incident { get; init; }

    public MonitoringNode? SeenBy { get; init; }

    public MonitoringNode? ConfirmedBy { get; init; }
}

[Mapper]
internal static partial class CloudMonitorMapper
{
    /// <summary>
    /// The status, whether this account muted it and whether it may change it come from other
    /// tables, so the caller passes them. The access key only shows as there or not.
    /// </summary>
    [MapProperty(nameof(CloudMonitor.SealedSecret), nameof(CloudMonitorDto.HasSecret), Use = nameof(IsSaved))]
    public static partial CloudMonitorDto ToDto(CloudMonitor monitor, CloudMonitorStatusDto status, bool muted, bool canWrite);

    public static partial CloudMonitorLiveDto ToLiveDto(CloudMonitorDto monitor);

    public static partial IQueryable<CloudMonitorSampleDto> ProjectToDto(this IQueryable<CloudMonitorSampleRow> rows);

    public static partial IQueryable<CloudMonitorIncidentDto> ProjectToDto(this IQueryable<CloudMonitorIncidentRow> rows);

    [MapPropertyFromSource(nameof(CloudMonitorHourDto.AvgLatencyMs), Use = nameof(AverageLatency))]
    [MapPropertyFromSource(nameof(CloudMonitorHourDto.MaxLatencyMs), Use = nameof(MaxLatency))]
    public static partial CloudMonitorHourDto ToDto(CloudMonitorHour hour);

    /// <summary>What a node checks. The caller opens the access key and passes it, empty for none.</summary>
    [MapProperty(nameof(CloudMonitor.DefinitionVersion), nameof(MonitorDefinition.Version))]
    [MapProperty(nameof(CloudMonitor.AuthMode), nameof(MonitorDefinition.AuthMode), Use = nameof(WireAuthMode))]
    public static partial MonitorDefinition ToDefinition(CloudMonitor monitor, string secret);

    public static partial MonitorLabel ToLabel(CloudMonitor monitor);

    public static partial EnforcedMonitor ToEnforced(CloudMonitor monitor);

    /// <summary>Whether the node takes monitors now is the caller's to say, see <see cref="MonitorAssigner.Eligible"/>.</summary>
    public static partial NodeSlot ToSlot(MonitoringNode node, bool eligible);

    [MapNestedProperties(nameof(CloudMonitorSampleRow.Sample))]
    [MapProperty([nameof(CloudMonitorSampleRow.Sample), nameof(CloudMonitorSample.CheckedAt)], nameof(CloudMonitorSampleDto.At))]
    [MapProperty([nameof(CloudMonitorSampleRow.Node), nameof(MonitoringNode.Region)], nameof(CloudMonitorSampleDto.Region))]
    private static partial CloudMonitorSampleDto ToDto(CloudMonitorSampleRow row);

    [MapNestedProperties(nameof(CloudMonitorIncidentRow.Incident))]
    [MapProperty([nameof(CloudMonitorIncidentRow.SeenBy), nameof(MonitoringNode.Region)], nameof(CloudMonitorIncidentDto.Region))]
    [MapProperty([nameof(CloudMonitorIncidentRow.ConfirmedBy), nameof(MonitoringNode.Region)], nameof(CloudMonitorIncidentDto.ConfirmedFrom))]
    private static partial CloudMonitorIncidentDto ToDto(CloudMonitorIncidentRow row);

    private static string VersionToString(uint version) => version.ToString(CultureInfo.InvariantCulture);

    [UserMapping(Default = false)]
    private static bool IsSaved(string? sealedSecret) => sealedSecret is not null;

    // The node knows no "none": a monitor without a key has no mode at all.
    [UserMapping(Default = false)]
    private static string WireAuthMode(string authMode) => authMode == CloudAuthModes.None ? "" : authMode;

    [UserMapping(Default = false)]
    private static int? AverageLatency(CloudMonitorHour hour) =>
        hour.LatencyCount == 0 ? null : (int)Math.Round((double)hour.LatencySumMs / hour.LatencyCount);

    [UserMapping(Default = false)]
    private static int? MaxLatency(CloudMonitorHour hour) => hour.LatencyCount == 0 ? null : hour.LatencyMaxMs;
}
