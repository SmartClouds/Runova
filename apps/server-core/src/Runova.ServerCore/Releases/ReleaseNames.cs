using System.Text.RegularExpressions;

namespace Runova.ServerCore.Releases;

/// <summary>
/// What a GitHub Release image request may hold (E105): repositories as GitHub names them, a tag,
/// an asset name, a SHA-256, and the only hosts a download may go to. GitHub's API answers a
/// release asset download with a redirect to its asset hosts, and the app's signed links point
/// there too; anything else is refused before a request is made, so a link cannot turn the core
/// into a way to reach other hosts.
/// </summary>
internal static partial class ReleaseNames
{
    /// <summary>A docker save archive of an app's images; larger than this is not a release asset worth loading here.</summary>
    public const long MaxImageBytes = 8L * 1024 * 1024 * 1024;

    public const int MaxTagLength = 255;

    public const int MaxAssetNameLength = 255;

    public const int MaxTokenLength = 255;

    private static readonly string[] _assetHosts = ["objects.githubusercontent.com", "release-assets.githubusercontent.com"];

    [GeneratedRegex("^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$", RegexOptions.CultureInvariant)]
    private static partial Regex Repository();

    [GeneratedRegex("^github-production-release-asset-[a-z0-9]+\\.s3\\.amazonaws\\.com$", RegexOptions.CultureInvariant)]
    private static partial Regex S3AssetHost();

    [GeneratedRegex("^[0-9A-Fa-f]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex Sha256();

    public static bool IsRepository(string? repository) =>
        repository is not null && Repository().IsMatch(repository) && !repository.EndsWith("/.", StringComparison.Ordinal) && !repository.EndsWith("/..", StringComparison.Ordinal);

    /// <summary>GitHub treats owner and name case-insensitively; the stored tokens are keyed by this.</summary>
    public static string Normalize(string repository) => repository.ToLowerInvariant();

    public static bool IsTag(string? tag) => IsText(tag, MaxTagLength);

    public static bool IsAssetName(string? name) =>
        IsText(name, MaxAssetNameLength) && !name!.Contains('/', StringComparison.Ordinal) && !name.Contains('\\', StringComparison.Ordinal);

    public static bool IsSha256(string? sha) => sha is not null && Sha256().IsMatch(sha);

    /// <summary>A fine-grained or classic GitHub token: printable, one line, no spaces.</summary>
    public static bool IsToken(string? token) =>
        token is { Length: > 0 and <= MaxTokenLength } && token.All(c => c > ' ' && c < '\u007f');

    /// <summary>HTTPS on the default port to one of GitHub's release asset hosts, with nothing in the user part.</summary>
    public static bool IsAssetHost(Uri? uri) =>
        uri is { IsAbsoluteUri: true }
        && uri.Scheme == Uri.UriSchemeHttps
        && uri.IsDefaultPort
        && uri.UserInfo.Length == 0
        && (_assetHosts.Contains(uri.Host, StringComparer.OrdinalIgnoreCase) || S3AssetHost().IsMatch(uri.Host.ToLowerInvariant()));

    /// <summary>
    /// Whether two image references name the same image, as docker load and Compose write them:
    /// Docker Hub's docker.io/ and library/ prefixes and a missing :latest make no difference.
    /// </summary>
    public static bool SameImage(string left, string right) => Canonical(left) == Canonical(right);

    private static string Canonical(string image)
    {
        var name = image.Trim();
        if (name.StartsWith("docker.io/", StringComparison.Ordinal))
        {
            name = name["docker.io/".Length..];
        }

        if (name.StartsWith("library/", StringComparison.Ordinal))
        {
            name = name["library/".Length..];
        }

        var slash = name.LastIndexOf('/');
        return name.IndexOf(':', slash + 1) < 0 && !name.Contains('@', StringComparison.Ordinal) ? name + ":latest" : name;
    }

    private static bool IsText(string? value, int max) =>
        value is { Length: > 0 } && value.Length <= max && !value.Any(char.IsControl) && value.Trim().Length == value.Length;
}
