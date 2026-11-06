namespace Runova.Website.Core.Dependencies;

/// <summary>Which findings a person hears about, and the key that keeps them from hearing it twice.</summary>
public static class AlertPolicy
{
    public static bool Wants(AlertPreferences preferences, Finding finding)
    {
        if (!preferences.Enabled)
        {
            return false;
        }

        return finding.Kind switch
        {
            FindingKinds.Security => preferences.SecurityMinSeverity != Severities.Off
                && Severities.Rank(finding.Severity) >= Severities.Rank(preferences.SecurityMinSeverity),
            FindingKinds.Deprecated => preferences.Deprecated,
            FindingKinds.Major => preferences.Major,
            FindingKinds.Minor => preferences.Minor,
            FindingKinds.Patch => preferences.Patch,
            _ => false,
        };
    }

    /// <summary>
    /// The same for the same news: a new release, a new advisory or a worse severity make a new
    /// key, and so a new message. NuGet names do not care about case, so neither does the key.
    /// </summary>
    public static string DedupeKey(long inventoryId, Finding finding)
    {
        var package = $"{inventoryId}:{finding.Ecosystem}:{finding.Name.ToLowerInvariant()}:{finding.Kind}";
        return finding.Kind switch
        {
            FindingKinds.Security => $"{package}:{finding.AdvisoryId}:{finding.Severity}",
            FindingKinds.Deprecated => package,
            _ => $"{package}:{finding.TargetVersion}",
        };
    }

    /// <summary>The worst advisory severity among the findings, or null when none is a security finding.</summary>
    public static string? WorstSeverity(IEnumerable<Finding> findings) =>
        findings.Where(f => f.Kind == FindingKinds.Security)
            .OrderByDescending(f => Severities.Rank(f.Severity))
            .Select(f => f.Severity)
            .FirstOrDefault();
}
