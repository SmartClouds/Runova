namespace Runova.Website.Core.Dependencies;

/// <summary>The package registries a project inventory can name.</summary>
public static class Ecosystems
{
    public const string Npm = "npm";
    public const string NuGet = "nuget";
    public const string Pub = "pub";

    public static readonly IReadOnlyList<string> All = [Npm, NuGet, Pub];

    /// <summary>The name OSV gives the ecosystem.</summary>
    public static string OsvName(string ecosystem) => ecosystem switch
    {
        Npm => "npm",
        NuGet => "NuGet",
        Pub => "Pub",
        _ => throw new ArgumentOutOfRangeException(nameof(ecosystem), ecosystem, "Not a known ecosystem."),
    };
}

/// <summary>What a check can find about one package, in the order alerts list them.</summary>
public static class FindingKinds
{
    public const string Security = "security";
    public const string Deprecated = "deprecated";
    public const string Major = "major";
    public const string Minor = "minor";
    public const string Patch = "patch";

    public static readonly IReadOnlyList<string> All = [Security, Deprecated, Major, Minor, Patch];

    public static int Order(string kind) => kind switch
    {
        Security => 0,
        Deprecated => 1,
        Major => 2,
        Minor => 3,
        Patch => 4,
        _ => 5,
    };
}

/// <summary>Advisory severities, as GitHub's advisory database names them, and <c>off</c> for a threshold.</summary>
public static class Severities
{
    public const string Critical = "critical";
    public const string High = "high";
    public const string Moderate = "moderate";
    public const string Low = "low";
    public const string Off = "off";

    public static readonly IReadOnlyList<string> All = [Critical, High, Moderate, Low];

    /// <summary>The thresholds a person can pick, worst first.</summary>
    public static readonly IReadOnlyList<string> Thresholds = [Critical, High, Moderate, Low, Off];

    /// <summary>4 for critical down to 1 for low; 0 for anything else.</summary>
    public static int Rank(string? severity) => severity switch
    {
        Critical => 4,
        High => 3,
        Moderate => 2,
        Low => 1,
        _ => 0,
    };

    /// <summary>A severity as an advisory writes it (<c>HIGH</c>, <c>Medium</c>), or moderate when it names none.</summary>
    public static string Normalize(string? text) => text?.Trim().ToLowerInvariant() switch
    {
        "critical" => Critical,
        "high" => High,
        "moderate" or "medium" => Moderate,
        "low" => Low,
        _ => Moderate,
    };
}

/// <summary>One package in a project, as the desktop app read it.</summary>
public sealed record InventoryItem(string Ecosystem, string Name, string Version, bool Dev);

/// <summary>What a registry says about a package now.</summary>
public sealed record PackageFactsView(string? LatestVersion, string? Deprecated);

/// <summary>An advisory that affects the inventory's version of a package.</summary>
public sealed record AdvisoryView(string Id, string Severity, string Summary, string? FixedVersion);

/// <summary>Something a person may want to hear about one package of a project.</summary>
public sealed record Finding(
    string Ecosystem,
    string Name,
    string Kind,
    string CurrentVersion,
    string? TargetVersion,
    string? AdvisoryId,
    string? Severity,
    string? Summary);

/// <summary>What a person wants to hear about. A threshold of <c>off</c> ignores advisories.</summary>
public sealed record AlertPreferences(bool Enabled, string SecurityMinSeverity, bool Deprecated, bool Major, bool Minor, bool Patch)
{
    public static readonly AlertPreferences Defaults = new(true, Severities.High, Deprecated: true, Major: true, Minor: false, Patch: false);
}
