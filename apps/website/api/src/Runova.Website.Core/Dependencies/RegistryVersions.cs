using System.Text.RegularExpressions;

namespace Runova.Website.Core.Dependencies;

/// <summary>
/// Picks a release out of the version lists PyPI, crates.io, Maven, git tags and CocoaPods publish.
/// Those are not all semver: a suffix can mean a pre-release (<c>2.0.0rc1</c>, <c>3.0.0-M1</c>) or
/// a flavor of a finished release (<c>33.0.0-jre</c>, <c>4.1.100.Final</c>).
/// </summary>
public static partial class RegistryVersions
{
    [GeneratedRegex(@"^v?(\d+(?:\.\d+)*)([^+]*)", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex Shape();

    [GeneratedRegex(@"^[-._]?(?:alpha|beta|rc|cr|dev|snapshot|preview|pre|eap|ea|milestone|nightly|canary|a|b|c|m)[-._]?\d*(?:[-._].*)?$", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex PrereleaseSuffix();

    public static bool IsPrerelease(string version)
    {
        var match = Shape().Match(version.Trim());
        return match.Success && PrereleaseSuffix().IsMatch(match.Groups[2].Value);
    }

    /// <summary>
    /// The newest finished release, as its numbers alone, or null when there is none. A package
    /// has one row of facts for all its users, so a flavor would be wrong for some of them.
    /// </summary>
    public static string? NewestRelease(IEnumerable<string> versions)
    {
        string? best = null;
        var bestVersion = default(PackageVersion);
        foreach (var text in versions)
        {
            var match = Shape().Match(text.Trim());
            if (!match.Success || PrereleaseSuffix().IsMatch(match.Groups[2].Value))
            {
                continue;
            }

            var numbers = match.Groups[1].Value;
            if (PackageVersion.TryParse(numbers, out var version) && (best is null || version > bestVersion))
            {
                best = numbers;
                bestVersion = version;
            }
        }

        return best;
    }
}
