using System.Globalization;
using System.Text.RegularExpressions;

namespace Runova.Website.Core.Dependencies;

/// <summary>
/// A package version as npm, pub and NuGet write them: up to four numbers and a prerelease tag.
/// It also reads the start of a manifest range (<c>^4.17.20</c>, <c>&gt;=2.0.0 &lt;3</c>), which is
/// the oldest version the range allows. Build metadata is ignored, as semver says.
/// </summary>
public readonly partial record struct PackageVersion(int Major, int Minor, int Patch, int Revision, string Prerelease)
    : IComparable<PackageVersion>
{
    [GeneratedRegex(@"^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?", RegexOptions.CultureInvariant)]
    private static partial Regex Pattern();

    public bool IsPrerelease => Prerelease.Length > 0;

    public static bool TryParse(string? text, out PackageVersion version)
    {
        version = default;
        var rest = (text ?? "").Trim().TrimStart('^', '~', '=', '<', '>', ' ');
        if (rest.Length > 1 && rest[0] is 'v' or 'V' && char.IsAsciiDigit(rest[1]))
        {
            rest = rest[1..];
        }

        var match = Pattern().Match(rest);
        if (!match.Success)
        {
            return false;
        }

        static int Number(Group group) =>
            group.Success && int.TryParse(group.Value, NumberStyles.None, CultureInfo.InvariantCulture, out var n) ? n : 0;

        version = new PackageVersion(Number(match.Groups[1]), Number(match.Groups[2]), Number(match.Groups[3]), Number(match.Groups[4]), match.Groups[5].Value);
        return true;
    }

    public static PackageVersion Parse(string text) =>
        TryParse(text, out var version) ? version : throw new FormatException($"'{text}' is not a version.");

    /// <summary><c>major</c>, <c>minor</c> or <c>patch</c> for a move up to <paramref name="latest"/>, or null when it is not newer.</summary>
    public static string? BumpKind(PackageVersion current, PackageVersion latest)
    {
        if (latest.CompareTo(current) <= 0)
        {
            return null;
        }

        if (latest.Major != current.Major)
        {
            return FindingKinds.Major;
        }

        return latest.Minor != current.Minor ? FindingKinds.Minor : FindingKinds.Patch;
    }

    public int CompareTo(PackageVersion other)
    {
        var numbers = (Major, Minor, Patch, Revision).CompareTo((other.Major, other.Minor, other.Patch, other.Revision));
        if (numbers != 0)
        {
            return numbers;
        }

        // A release ranks above its own prereleases.
        if (IsPrerelease != other.IsPrerelease)
        {
            return IsPrerelease ? -1 : 1;
        }

        return ComparePrerelease(Prerelease, other.Prerelease);
    }

    private static int ComparePrerelease(string left, string right)
    {
        var a = left.Split('.');
        var b = right.Split('.');
        for (var i = 0; i < Math.Min(a.Length, b.Length); i++)
        {
            var aNumber = int.TryParse(a[i], NumberStyles.None, CultureInfo.InvariantCulture, out var x);
            var bNumber = int.TryParse(b[i], NumberStyles.None, CultureInfo.InvariantCulture, out var y);
            var order = (aNumber, bNumber) switch
            {
                (true, true) => x.CompareTo(y),
                (true, false) => -1,
                (false, true) => 1,
                _ => string.CompareOrdinal(a[i], b[i]),
            };
            if (order != 0)
            {
                return order;
            }
        }

        return a.Length.CompareTo(b.Length);
    }

    public static bool operator <(PackageVersion left, PackageVersion right) => left.CompareTo(right) < 0;

    public static bool operator >(PackageVersion left, PackageVersion right) => left.CompareTo(right) > 0;

    public static bool operator <=(PackageVersion left, PackageVersion right) => left.CompareTo(right) <= 0;

    public static bool operator >=(PackageVersion left, PackageVersion right) => left.CompareTo(right) >= 0;

    public override string ToString()
    {
        var text = Revision > 0 ? $"{Major}.{Minor}.{Patch}.{Revision}" : $"{Major}.{Minor}.{Patch}";
        return IsPrerelease ? $"{text}-{Prerelease}" : text;
    }
}
