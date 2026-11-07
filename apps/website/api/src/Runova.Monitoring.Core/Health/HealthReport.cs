using System.Text.Json;

namespace Runova.Monitoring.Core.Health;

/// <summary>The constants of the Runova Health Protocol (E22).</summary>
public static class HealthProtocol
{
    /// <summary>The protocol id a compliant endpoint puts in <c>runova.protocol</c>.</summary>
    public const string Id = "runova-health/1";

    /// <summary>The media type a compliant endpoint answers with (from the IETF health check draft).</summary>
    public const string MediaType = "application/health+json";

    /// <summary>The key a check carries its error details under.</summary>
    public const string CheckKey = "runova";

    /// <summary>
    /// The key endpoints built before the app was renamed put the details under.
    /// Still read, so those endpoints keep working.
    /// </summary>
    public const string LegacyCheckKey = "agentmate"; // legacy-name
}

/// <summary>A failing service's error, as the endpoint described it (already redacted).</summary>
public sealed record HealthServiceError
{
    public required string Message { get; init; }
    public string? Code { get; init; }
    public string? Detail { get; init; }
    public string? Stack { get; init; }
    public string? Hint { get; init; }

    /// <summary>When the endpoint says the problem started (ISO time), if it said.</summary>
    public string? Since { get; init; }
}

/// <summary>One entry under <c>checks</c>, such as <c>postgres:connection</c>.</summary>
public sealed record HealthServiceResult
{
    /// <summary>The full check key, unique within a report.</summary>
    public required string Key { get; init; }

    /// <summary>The component part of the key ("postgres").</summary>
    public required string Name { get; init; }

    /// <summary>The measurement part of the key ("connection"), when there is one.</summary>
    public string? Measurement { get; init; }

    public string? ComponentId { get; init; }
    public string? ComponentType { get; init; }
    public required HealthCheckStatus Status { get; init; }

    /// <summary>
    /// The endpoint's <c>observedValue</c>: a JSON string (already redacted and trimmed), number
    /// or boolean, or null when it sent none. Numbers keep the endpoint's own JSON text, so
    /// nothing is lost to a conversion; read them with <see cref="JsonElement.GetDouble"/>.
    /// </summary>
    public JsonElement? ObservedValue { get; init; }

    public string? ObservedUnit { get; init; }
    public string? Time { get; init; }
    public HealthServiceError? Error { get; init; }
}

/// <summary>One probe's result, normalized and redacted. Safe to store and to show.</summary>
public sealed record HealthReport
{
    public required HealthProbeState State { get; init; }
    public int? HttpStatus { get; init; }
    public int? LatencyMs { get; init; }
    public required DateTimeOffset CheckedAt { get; init; }
    public string? ServiceId { get; init; }
    public string? Description { get; init; }
    public string? ReleaseId { get; init; }
    public string? Version { get; init; }

    /// <summary>The endpoint's own top-level <c>output</c>, when it failed as a whole.</summary>
    public string? Output { get; init; }

    public IReadOnlyList<HealthServiceResult> Services { get; init; } = [];

    /// <summary>What went wrong from Runova's side, in a sentence, when the probe got no good report.</summary>
    public string? Problem { get; init; }

    /// <summary>The response body, pretty printed when it was JSON, redacted and trimmed.</summary>
    public string? Raw { get; init; }
}
