using System.Text.Json;
using System.Text.Json.Serialization;

namespace Runova.Website.Api.Health;

/// <summary>The three statuses of runova-health/1, worst last.</summary>
internal static class HealthStatuses
{
    public const string Pass = "pass";
    public const string Warn = "warn";
    public const string Fail = "fail";

    public static int Rank(string status) => status switch
    {
        Pass => 0,
        Warn => 1,
        _ => 2,
    };

    public static string Worst(IEnumerable<string> statuses) =>
        statuses.Aggregate(Pass, (worst, status) => Rank(status) > Rank(worst) ? status : worst);
}

/// <summary>The body <c>/_runova/health</c> answers with, in the order the protocol lists the fields.</summary>
internal sealed record RunovaHealthReport(
    string Status,
    string? Version,
    string? ReleaseId,
    string ServiceId,
    string Description,
    string Time,
    string? Output,
    IReadOnlyDictionary<string, IReadOnlyList<HealthCheckEntry>> Checks,
    RunovaHealthReport.Target Runova)
{
    public const string Protocol = "runova-health/1";
    public const string ContentType = "application/health+json";

    /// <summary>camelCase fields, nothing written for a null. Check keys stay exactly as they are.</summary>
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public sealed record Target(string Protocol, string Environment, string Server);
}

/// <summary>One instance of one check, such as the PostgreSQL connection or one recurring job.</summary>
internal sealed record HealthCheckEntry
{
    public string? ComponentId { get; init; }

    public string? ComponentType { get; init; }

    public required string Status { get; init; }

    public string? Time { get; init; }

    public double? ObservedValue { get; init; }

    public string? ObservedUnit { get; init; }

    public string? Output { get; init; }

    public HealthCheckDetails? Runova { get; init; }
}

/// <summary>What the person or AI fixing a check that does not pass needs to know.</summary>
internal sealed record HealthCheckDetails
{
    public string? ErrorCode { get; init; }

    public string? Detail { get; init; }

    public string? Stack { get; init; }

    public string? Hint { get; init; }

    public string? Since { get; init; }
}
