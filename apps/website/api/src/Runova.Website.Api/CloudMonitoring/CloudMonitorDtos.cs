namespace Runova.Website.Api.CloudMonitoring;

/// <summary>
/// An online monitor as its scope's members see it. The access key never comes back: only
/// whether there is one and when it last changed.
/// </summary>
public sealed record CloudMonitorDto(
    long Id,
    long ScopeId,
    string ItemId,
    string Name,
    string ProjectName,
    string? EnvironmentName,
    string Url,
    int IntervalSec,
    int TimeoutSec,
    string AuthMode,
    bool HasSecret,
    DateTimeOffset? SecretChangedAt,
    bool AllowInsecure,
    bool Paused,
    string? SuspendedReason,
    bool NotifyInApp,
    bool NotifyTelegram,
    bool Muted,
    bool CanWrite,
    CloudMonitorStatusDto Status,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    string Version);

/// <summary>
/// Where a monitor stands. <c>verdict</c> is up, down (an incident is open), degraded (its last
/// check warned), paused or unknown (no check yet). <c>confirming</c> is true while a change waits
/// for its second sample or a second opinion.
/// </summary>
public sealed record CloudMonitorStatusDto(
    string Verdict,
    string? State,
    DateTimeOffset? LastCheckedAt,
    int? LatencyMs,
    int? HttpStatus,
    string? Problem,
    string? Region,
    bool Confirming,
    CloudMonitorIncidentDto? OpenIncident,
    double? Uptime24h);

public sealed record CloudMonitorIncidentDto(
    long Id,
    long MonitorId,
    DateTimeOffset OpenedAt,
    DateTimeOffset? ResolvedAt,
    string State,
    string? Problem,
    string? Region,
    string? ConfirmedFrom);

public sealed record CloudMonitorSampleDto(DateTimeOffset At, string State, int? LatencyMs, int? HttpStatus, string? Region, string? Problem);

/// <summary>One hour of checks. Kept for good.</summary>
public sealed record CloudMonitorHourDto(DateTimeOffset Hour, int Checks, int Failures, int Warnings, int? AvgLatencyMs, int? MaxLatencyMs);

public sealed record CloudMonitorListDto(IReadOnlyList<CloudMonitorDto> Items);

public sealed record CloudMonitorSampleListDto(IReadOnlyList<CloudMonitorSampleDto> Items);

public sealed record CloudMonitorHourListDto(IReadOnlyList<CloudMonitorHourDto> Items);

/// <summary>What a scope may have and has. <c>maxMonitors</c> is null for no limit.</summary>
public sealed record ScopeMonitoringUsageDto(
    long ScopeId,
    string Kind,
    string Name,
    bool CanWrite,
    string AccountTypeKey,
    string AccountTypeName,
    int? MaxMonitors,
    int MinIntervalSec,
    int HistoryDays,
    int Active,
    int Paused);

public sealed record MonitoringUsageDto(IReadOnlyList<ScopeMonitoringUsageDto> Scopes);

/// <summary>
/// The fields a monitor is written with. On a patch, a field left out keeps its value;
/// <c>scopeId</c> and <c>itemId</c> are set once, on create.
/// </summary>
public sealed record CloudMonitorWriteRequest(
    long? ScopeId,
    string? ItemId,
    string? Name,
    string? ProjectName,
    string? EnvironmentName,
    string? Url,
    int? IntervalSec,
    int? TimeoutSec,
    string? AuthMode,
    string? Secret,
    bool? AllowInsecure,
    bool? Paused,
    bool? NotifyInApp,
    bool? NotifyTelegram);

/// <summary>A new bearer key, or <c>user:password</c> for basic.</summary>
public sealed record CloudMonitorSecretRequest(string? Secret);

/// <summary>Pushed over the hub after each result: enough to repaint a card without reading it again.</summary>
public sealed record CloudMonitorLiveDto(long Id, long ScopeId, string ItemId, bool Paused, CloudMonitorStatusDto Status);

/// <summary>Pushed when a scope's monitors were added, changed or removed: read the list again.</summary>
public sealed record CloudMonitorsChangedDto(long ScopeId);
