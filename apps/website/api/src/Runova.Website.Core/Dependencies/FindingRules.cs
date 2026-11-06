namespace Runova.Website.Core.Dependencies;

/// <summary>
/// Turns one package of an inventory, what its registry says and the advisories on its version
/// into findings: each advisory, a deprecation, and a newer stable release by the kind of bump.
/// </summary>
public static class FindingRules
{
    public static IReadOnlyList<Finding> For(InventoryItem item, PackageFactsView? facts, IReadOnlyList<AdvisoryView> advisories)
    {
        var findings = new List<Finding>();
        foreach (var advisory in advisories)
        {
            findings.Add(new Finding(item.Ecosystem, item.Name, FindingKinds.Security, item.Version, advisory.FixedVersion, advisory.Id, advisory.Severity, advisory.Summary));
        }

        if (facts is null)
        {
            return findings;
        }

        var hasCurrent = PackageVersion.TryParse(item.Version, out var current);
        var hasLatest = PackageVersion.TryParse(facts.LatestVersion, out var latest);
        var newer = hasCurrent && hasLatest && latest > current && (!latest.IsPrerelease || current.IsPrerelease);

        if (!string.IsNullOrWhiteSpace(facts.Deprecated))
        {
            findings.Add(new Finding(item.Ecosystem, item.Name, FindingKinds.Deprecated, item.Version, newer ? facts.LatestVersion : null, null, null, facts.Deprecated.Trim()));
        }

        if (newer && PackageVersion.BumpKind(current, latest) is { } kind)
        {
            findings.Add(new Finding(item.Ecosystem, item.Name, kind, item.Version, facts.LatestVersion, null, null, null));
        }

        return findings;
    }

    /// <summary>The lowest of <paramref name="fixedVersions"/> above <paramref name="current"/>, or null.</summary>
    public static string? FirstFixAfter(string current, IEnumerable<string> fixedVersions)
    {
        if (!PackageVersion.TryParse(current, out var from))
        {
            return null;
        }

        return fixedVersions
            .Select(text => (Text: text, Ok: PackageVersion.TryParse(text, out var version), Version: version))
            .Where(v => v.Ok && v.Version > from)
            .OrderBy(v => v.Version)
            .Select(v => v.Text)
            .FirstOrDefault();
    }
}
