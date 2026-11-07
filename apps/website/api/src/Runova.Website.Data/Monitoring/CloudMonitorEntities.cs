namespace Runova.Website.Data.Monitoring;

/// <summary>How a node signs in to the address it checks.</summary>
public static class CloudAuthModes
{
    public const string None = "none";
    public const string Bearer = "bearer";
    public const string Basic = "basic";

    public static readonly string[] All = [None, Bearer, Basic];
}

/// <summary>Why a monitor was paused by Runova rather than by a person.</summary>
public static class SuspendedReasons
{
    /// <summary>The scope's account type allows fewer monitors than it had.</summary>
    public const string OverLimit = "over-limit";
}

/// <summary>
/// A monitor the nodes check (E55). It belongs to a sync scope (personal or a team's) and names the
/// desktop monitor it mirrors. Synced records are sealed, so the names come in plain text with it.
/// </summary>
public sealed class CloudMonitor
{
    public long Id { get; set; }

    public long ScopeId { get; set; }

    /// <summary>The synced desktop monitor's id, unique in the scope.</summary>
    public required string ItemId { get; set; }

    public required string Name { get; set; }

    public required string ProjectName { get; set; }

    public string? EnvironmentName { get; set; }

    public required string Url { get; set; }

    public int IntervalSec { get; set; }

    public int TimeoutSec { get; set; }

    public string AuthMode { get; set; } = CloudAuthModes.None;

    /// <summary>The bearer key, or <c>user:password</c> for basic, sealed with Data Protection.</summary>
    public string? SealedSecret { get; set; }

    public DateTimeOffset? SecretChangedAt { get; set; }

    public bool AllowInsecure { get; set; }

    public bool Paused { get; set; }

    /// <summary>Set when Runova paused it (see <see cref="SuspendedReasons"/>); a person resuming it clears it.</summary>
    public string? SuspendedReason { get; set; }

    public bool NotifyInApp { get; set; } = true;

    public bool NotifyTelegram { get; set; }

    /// <summary>Goes up when anything a node checks with changes; older results are dropped.</summary>
    public long DefinitionVersion { get; set; } = 1;

    public DateTimeOffset CreatedAt { get; set; }

    public long? CreatedBy { get; set; }

    public DateTimeOffset UpdatedAt { get; set; }

    public uint Version { get; set; }
}

/// <summary>
/// Where a monitor stands now. Kept apart from <see cref="CloudMonitor"/> so a result does not
/// change the monitor's ETag and spoil someone's edit.
/// </summary>
public sealed class CloudMonitorStatus
{
    public long MonitorId { get; set; }

    /// <summary>The node that checks it, or null while paused or with no node to run on.</summary>
    public long? NodeId { get; set; }

    /// <summary>The last probe state (pass, warn, fail, unreachable, unauthorized, invalid).</summary>
    public string? State { get; set; }

    /// <summary>"ok", "problem" or null before the first sample: the two-sample rule's verdict.</summary>
    public string? Confirmed { get; set; }

    public int Streak { get; set; }

    public bool Pending { get; set; }

    public DateTimeOffset? LastCheckedAt { get; set; }

    public int? LatencyMs { get; set; }

    public int? HttpStatus { get; set; }

    public string? Problem { get; set; }

    public long? LastNodeId { get; set; }

    public string? LastRegion { get; set; }

    /// <summary>The second opinion asked for, while it is outstanding.</summary>
    public Guid? ConfirmId { get; set; }

    public long? ConfirmNodeId { get; set; }

    public DateTimeOffset? ConfirmRequestedAt { get; set; }

    /// <summary>When the problem the second opinion is about was first seen.</summary>
    public DateTimeOffset? SuspectSince { get; set; }

    public string? SuspectState { get; set; }

    public string? SuspectProblem { get; set; }

    public long? OpenIncidentId { get; set; }
}

/// <summary>One check's result. Kept for the scope's account type's history days.</summary>
public sealed class CloudMonitorSample
{
    /// <summary>The UUIDv7 the node made, so a batch sent twice is stored once.</summary>
    public Guid Id { get; set; }

    public long MonitorId { get; set; }

    public DateTimeOffset CheckedAt { get; set; }

    public required string State { get; set; }

    public int? LatencyMs { get; set; }

    public int? HttpStatus { get; set; }

    public long? NodeId { get; set; }

    /// <summary>Already redacted by the node.</summary>
    public string? Problem { get; set; }

    /// <summary>True for a second opinion's result.</summary>
    public bool Confirm { get; set; }
}

/// <summary>One hour of a monitor's results, kept for good.</summary>
public sealed class CloudMonitorHour
{
    public long MonitorId { get; set; }

    /// <summary>The start of the hour, UTC.</summary>
    public DateTimeOffset Hour { get; set; }

    public int Checks { get; set; }

    /// <summary>Checks that found it down.</summary>
    public int Failures { get; set; }

    /// <summary>Checks that found it degraded (warn).</summary>
    public int Warnings { get; set; }

    public long LatencySumMs { get; set; }

    public int LatencyCount { get; set; }

    public int LatencyMaxMs { get; set; }
}

/// <summary>A stretch of time a monitor was confirmed down. Kept for good.</summary>
public sealed class CloudMonitorIncident
{
    public long Id { get; set; }

    public long MonitorId { get; set; }

    public DateTimeOffset OpenedAt { get; set; }

    public DateTimeOffset? ResolvedAt { get; set; }

    /// <summary>The state that opened it.</summary>
    public required string State { get; set; }

    public string? Problem { get; set; }

    /// <summary>The node that saw it, and the one that confirmed it (none with a single node).</summary>
    public long? NodeId { get; set; }

    public long? ConfirmedByNodeId { get; set; }
}

/// <summary>A member who does not want to hear about this monitor.</summary>
public sealed class CloudMonitorMute
{
    public long MonitorId { get; set; }

    public long UserId { get; set; }

    public DateTimeOffset At { get; set; }
}
