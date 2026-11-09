using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;
using Runova.Website.Core.Dependencies;

namespace Runova.Website.Api.Dependencies;

/// <summary>Where the registries are, from <c>PackageRegistries:*</c>. Only tests and mirrors change them.</summary>
internal sealed class PackageRegistryOptions
{
    public Uri Npm { get; set; } = new("https://registry.npmjs.org/");

    public Uri NuGet { get; set; } = new("https://api.nuget.org/");

    public Uri Pub { get; set; } = new("https://pub.dev/");

    public Uri Osv { get; set; } = new("https://api.osv.dev/");

    public Uri PyPi { get; set; } = new("https://pypi.org/");

    public Uri Crates { get; set; } = new("https://index.crates.io/");

    public Uri MavenCentral { get; set; } = new("https://repo1.maven.org/maven2/");

    public Uri GoogleMaven { get; set; } = new("https://dl.google.com/dl/android/maven2/");

    public Uri GitHub { get; set; } = new("https://github.com/");

    public Uri CocoaPods { get; set; } = new("https://cdn.cocoapods.org/");

    /// <summary>How long what a registry said is trusted before it is asked again.</summary>
    public TimeSpan CacheFor { get; set; } = TimeSpan.FromHours(6);
}

/// <summary>What one registry says about a package now: null when it has no such package.</summary>
internal interface IPackageRegistry
{
    string Ecosystem { get; }

    Task<PackageFactsView?> GetAsync(string name, CancellationToken cancellationToken);
}

/// <summary>A registry that answered with something other than a package or a 404.</summary>
internal sealed class RegistryException(string message) : Exception(message);

internal static class RegistryReplies
{
    public static async Task<JsonNode?> ReadAsync(HttpResponseMessage response, string what, CancellationToken cancellationToken)
    {
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }

        if (!response.IsSuccessStatusCode)
        {
            throw new RegistryException($"{what} answered {(int)response.StatusCode}.");
        }

        try
        {
            return await JsonNode.ParseAsync(await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken)
                ?? throw new RegistryException($"{what} sent an empty answer.");
        }
        catch (JsonException)
        {
            throw new RegistryException($"{what} sent something that is not JSON.");
        }
    }

    /// <summary>The body as text, or null for a 404 and the other statuses in <paramref name="missing"/>.</summary>
    public static async Task<string?> ReadTextAsync(HttpResponseMessage response, string what, CancellationToken cancellationToken, params HttpStatusCode[] missing)
    {
        if (response.StatusCode == HttpStatusCode.NotFound || missing.Contains(response.StatusCode))
        {
            return null;
        }

        if (!response.IsSuccessStatusCode)
        {
            throw new RegistryException($"{what} answered {(int)response.StatusCode}.");
        }

        return await response.Content.ReadAsStringAsync(cancellationToken);
    }

    public static string? Text(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<string>(out var text) && !string.IsNullOrWhiteSpace(text) ? text : null;
}

/// <summary>registry.npmjs.org, with the short "install" document that has the dist-tags and deprecations.</summary>
internal sealed class NpmRegistryClient(HttpClient http) : IPackageRegistry
{
    public string Ecosystem => Ecosystems.Npm;

    public async Task<PackageFactsView?> GetAsync(string name, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, Uri.EscapeDataString(name).Replace("%40", "@", StringComparison.Ordinal));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.npm.install-v1+json"));
        using var response = await http.SendAsync(request, cancellationToken);
        if (await RegistryReplies.ReadAsync(response, "npm", cancellationToken) is not { } document)
        {
            return null;
        }

        var latest = RegistryReplies.Text(document["dist-tags"]?["latest"]);
        // npm deprecates version by version; a package whose latest version is deprecated is deprecated as a whole.
        var deprecated = latest is null ? null : RegistryReplies.Text(document["versions"]?[latest]?["deprecated"]);
        return new PackageFactsView(latest, deprecated);
    }
}

/// <summary>pub.dev's package API, where a discontinued package names its replacement.</summary>
internal sealed class PubRegistryClient(HttpClient http) : IPackageRegistry
{
    public string Ecosystem => Ecosystems.Pub;

    public async Task<PackageFactsView?> GetAsync(string name, CancellationToken cancellationToken)
    {
        using var response = await http.GetAsync("api/packages/" + Uri.EscapeDataString(name), cancellationToken);
        if (await RegistryReplies.ReadAsync(response, "pub.dev", cancellationToken) is not { } document)
        {
            return null;
        }

        var latest = RegistryReplies.Text(document["latest"]?["version"]);
        string? deprecated = null;
        if (document["isDiscontinued"] is JsonValue flag && flag.TryGetValue<bool>(out var discontinued) && discontinued)
        {
            deprecated = RegistryReplies.Text(document["replacedBy"]) is { } replacement
                ? $"Discontinued, replaced by {replacement}"
                : "Discontinued";
        }

        return new PackageFactsView(latest, deprecated);
    }
}

/// <summary>
/// NuGet's registration index: the last page holds the newest versions. A big package's page is
/// only linked, and fetched. Unlisted versions are skipped, as nuget.org hides them.
/// </summary>
internal sealed class NuGetRegistryClient(HttpClient http) : IPackageRegistry
{
    public string Ecosystem => Ecosystems.NuGet;

    public async Task<PackageFactsView?> GetAsync(string name, CancellationToken cancellationToken)
    {
        using var response = await http.GetAsync($"v3/registration5-gz-semver2/{Uri.EscapeDataString(name.ToLowerInvariant())}/index.json", cancellationToken);
        if (await RegistryReplies.ReadAsync(response, "NuGet", cancellationToken) is not { } index)
        {
            return null;
        }

        if (index["items"] is not JsonArray pages || pages.Count == 0)
        {
            return new PackageFactsView(null, null);
        }

        var page = pages[^1];
        if (page?["items"] is not JsonArray items)
        {
            var link = RegistryReplies.Text(page?["@id"]) ?? throw new RegistryException("NuGet sent a page with no items and no link.");
            using var pageResponse = await http.GetAsync(link, cancellationToken);
            items = (await RegistryReplies.ReadAsync(pageResponse, "NuGet", cancellationToken))?["items"] as JsonArray ?? [];
        }

        var entries = items
            .Select(item => item?["catalogEntry"])
            .Where(entry => entry is not null && (entry["listed"] is not JsonValue listed || !listed.TryGetValue<bool>(out var on) || on))
            .Select(entry => (Entry: entry!, Version: RegistryReplies.Text(entry!["version"])))
            .Where(e => e.Version is not null && PackageVersion.TryParse(e.Version, out _))
            .ToList();
        var stable = entries.Where(e => !PackageVersion.Parse(e.Version!).IsPrerelease).ToList();
        var newest = (stable.Count > 0 ? stable : entries).OrderBy(e => PackageVersion.Parse(e.Version!)).LastOrDefault();
        if (newest.Entry is null)
        {
            return new PackageFactsView(null, null);
        }

        return new PackageFactsView(newest.Version, Deprecation(newest.Entry["deprecation"]));
    }

    private static string? Deprecation(JsonNode? deprecation)
    {
        if (deprecation is null)
        {
            return null;
        }

        var message = RegistryReplies.Text(deprecation["message"]);
        var reasons = deprecation["reasons"] is JsonArray list ? string.Join(", ", list.Select(RegistryReplies.Text).OfType<string>()) : "";
        var alternate = RegistryReplies.Text(deprecation["alternatePackage"]?["id"]);
        var text = message ?? (reasons.Length > 0 ? $"Deprecated ({reasons})" : "Deprecated");
        return alternate is null ? text : $"{text}. Use {alternate} instead";
    }
}

/// <summary>PyPI's JSON API, whose <c>info.version</c> is the release pip would install.</summary>
internal sealed class PyPiRegistryClient(HttpClient http) : IPackageRegistry
{
    public string Ecosystem => Ecosystems.PyPi;

    public async Task<PackageFactsView?> GetAsync(string name, CancellationToken cancellationToken)
    {
        using var response = await http.GetAsync($"pypi/{Uri.EscapeDataString(name)}/json", cancellationToken);
        if (await RegistryReplies.ReadAsync(response, "PyPI", cancellationToken) is not { } document)
        {
            return null;
        }

        var latest = RegistryReplies.Text(document["info"]?["version"]);
        return new PackageFactsView(latest is null || RegistryVersions.IsPrerelease(latest) ? null : latest, null);
    }
}

/// <summary>The crates.io sparse index: one JSON object per published version, one per line.</summary>
internal sealed partial class CratesRegistryClient(HttpClient http) : IPackageRegistry
{
    [GeneratedRegex("^[A-Za-z0-9_-]{1,64}$", RegexOptions.CultureInvariant)]
    private static partial Regex CrateName();

    public string Ecosystem => Ecosystems.Crates;

    public async Task<PackageFactsView?> GetAsync(string name, CancellationToken cancellationToken)
    {
        if (!CrateName().IsMatch(name))
        {
            return null;
        }

        using var response = await http.GetAsync(IndexPath(name.ToLowerInvariant()), cancellationToken);
        if (await RegistryReplies.ReadTextAsync(response, "crates.io", cancellationToken) is not { } body)
        {
            return null;
        }

        return new PackageFactsView(RegistryVersions.NewestRelease(Unyanked(body)), null);
    }

    private static string IndexPath(string name) => name.Length switch
    {
        <= 2 => $"{name.Length}/{name}",
        3 => $"3/{name[0]}/{name}",
        _ => $"{name[..2]}/{name[2..4]}/{name}",
    };

    private static IEnumerable<string> Unyanked(string body)
    {
        foreach (var line in body.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            JsonNode? release;
            try
            {
                release = JsonNode.Parse(line);
            }
            catch (JsonException)
            {
                continue;
            }

            var yanked = release?["yanked"] is JsonValue value && value.TryGetValue<bool>(out var flag) && flag;
            if (!yanked && RegistryReplies.Text(release?["vers"]) is { } version)
            {
                yield return version;
            }
        }
    }
}

/// <summary>Maven Central and Google's repository, tried in the order the group is likelier to be in.</summary>
internal sealed partial class MavenRegistryClient(HttpClient http, IOptions<PackageRegistryOptions> options) : IPackageRegistry
{
    [GeneratedRegex("^([A-Za-z0-9_][A-Za-z0-9_.-]*):([A-Za-z0-9_][A-Za-z0-9_.-]*)$", RegexOptions.CultureInvariant)]
    private static partial Regex Coordinates();

    [GeneratedRegex(@"^(?:androidx|android\.arch|com\.android|com\.google\.android|com\.google\.firebase|com\.google\.gms)(?:\.|$)", RegexOptions.CultureInvariant)]
    private static partial Regex GoogleGroup();

    [GeneratedRegex("<version>([^<]+)</version>", RegexOptions.CultureInvariant)]
    private static partial Regex VersionTag();

    public string Ecosystem => Ecosystems.Maven;

    public async Task<PackageFactsView?> GetAsync(string name, CancellationToken cancellationToken)
    {
        var match = Coordinates().Match(name);
        if (!match.Success)
        {
            return null;
        }

        var (group, artifact) = (match.Groups[1].Value, match.Groups[2].Value);
        Uri[] repositories = GoogleGroup().IsMatch(group)
            ? [options.Value.GoogleMaven, options.Value.MavenCentral]
            : [options.Value.MavenCentral, options.Value.GoogleMaven];
        foreach (var repository in repositories)
        {
            using var response = await http.GetAsync(new Uri(repository, $"{group.Replace('.', '/')}/{artifact}/maven-metadata.xml"), cancellationToken);
            if (await RegistryReplies.ReadTextAsync(response, "Maven", cancellationToken) is { } metadata)
            {
                return new PackageFactsView(RegistryVersions.NewestRelease(VersionTag().Matches(metadata).Select(m => m.Groups[1].Value)), null);
            }
        }

        return null;
    }
}

/// <summary>
/// A Swift package's releases are its git tags. The name comes from a client, so only an address
/// on GitHub is ever asked about: the server must not fetch whatever host an upload names.
/// </summary>
internal sealed partial class SwiftRegistryClient(HttpClient http) : IPackageRegistry
{
    /// <summary>Tags are listed after every branch, so a repository past this is not worth reading.</summary>
    public const int MaxAnswerBytes = 8 * 1024 * 1024;

    [GeneratedRegex("^github\\.com/([A-Za-z0-9_-][A-Za-z0-9_.-]*)/([A-Za-z0-9_-][A-Za-z0-9_.-]*)$", RegexOptions.CultureInvariant)]
    private static partial Regex GitHubAddress();

    [GeneratedRegex(@"refs/tags/([^\s^\0]+)", RegexOptions.CultureInvariant)]
    private static partial Regex Tag();

    [GeneratedRegex(@"^v?\d+(?:\.\d+){1,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$", RegexOptions.CultureInvariant)]
    private static partial Regex SemverTag();

    public string Ecosystem => Ecosystems.Swift;

    public async Task<PackageFactsView?> GetAsync(string name, CancellationToken cancellationToken)
    {
        var match = GitHubAddress().Match(name);
        if (!match.Success)
        {
            return null;
        }

        using var response = await http.GetAsync($"{match.Groups[1].Value}/{match.Groups[2].Value}.git/info/refs?service=git-upload-pack", cancellationToken);
        if (await RegistryReplies.ReadTextAsync(response, "GitHub", cancellationToken, HttpStatusCode.Unauthorized, HttpStatusCode.Forbidden) is not { } refs)
        {
            return null;
        }

        var tags = Tag().Matches(refs).Select(m => m.Groups[1].Value).Where(t => SemverTag().IsMatch(t));
        return new PackageFactsView(RegistryVersions.NewestRelease(tags), null);
    }
}

/// <summary>The CDN CocoaPods itself reads: files of <c>Name/1.0.0/1.1.0</c> lines, split by the hash of the name.</summary>
internal sealed partial class CocoaPodsRegistryClient(HttpClient http) : IPackageRegistry
{
    [GeneratedRegex(@"^[A-Za-z0-9_.+-]{1,214}$", RegexOptions.CultureInvariant)]
    private static partial Regex PodName();

    public string Ecosystem => Ecosystems.CocoaPods;

    public async Task<PackageFactsView?> GetAsync(string name, CancellationToken cancellationToken)
    {
        if (!PodName().IsMatch(name))
        {
            return null;
        }

#pragma warning disable CA5351 // The CDN's own file layout, not a security use.
        var hash = Convert.ToHexStringLower(MD5.HashData(Encoding.UTF8.GetBytes(name)));
#pragma warning restore CA5351
        using var response = await http.GetAsync($"all_pods_versions_{hash[0]}_{hash[1]}_{hash[2]}.txt", cancellationToken);
        if (await RegistryReplies.ReadTextAsync(response, "CocoaPods", cancellationToken) is not { } shard)
        {
            return null;
        }

        var line = shard.Split('\n', StringSplitOptions.TrimEntries).FirstOrDefault(l => l.StartsWith(name + "/", StringComparison.Ordinal));
        return line is null ? null : new PackageFactsView(RegistryVersions.NewestRelease(line.Split('/').Skip(1)), null);
    }
}

/// <summary>
/// OSV.dev: which advisories affect a package version (a batch at a time), then each advisory's
/// severity, summary and fixed versions. Severity is GitHub's rating where OSV has one.
/// </summary>
internal sealed class OsvClient(HttpClient http)
{
    public const int MaxBatch = 500;

    public sealed record Query(string Ecosystem, string Name, string Version);

    /// <summary>The advisory ids for each query, in the same order.</summary>
    public async Task<IReadOnlyList<IReadOnlyList<string>>> QueryAsync(IReadOnlyList<Query> queries, CancellationToken cancellationToken)
    {
        var results = new List<IReadOnlyList<string>>();
        foreach (var chunk in queries.Chunk(MaxBatch))
        {
            var body = new JsonObject
            {
                ["queries"] = new JsonArray([.. chunk.Select(q => (JsonNode)new JsonObject
                {
                    ["package"] = new JsonObject { ["name"] = q.Name, ["ecosystem"] = Ecosystems.OsvName(q.Ecosystem) },
                    ["version"] = q.Version,
                })]),
            };
            using var response = await http.PostAsync("v1/querybatch", new StringContent(body.ToJsonString(), System.Text.Encoding.UTF8, "application/json"), cancellationToken);
            var document = await RegistryReplies.ReadAsync(response, "OSV", cancellationToken) ?? throw new RegistryException("OSV answered 404.");
            var answers = document["results"] as JsonArray ?? [];
            for (var i = 0; i < chunk.Length; i++)
            {
                var vulns = i < answers.Count ? answers[i]?["vulns"] as JsonArray : null;
                results.Add([.. (vulns ?? []).Select(v => RegistryReplies.Text(v?["id"])).OfType<string>()]);
            }
        }

        return results;
    }

    public sealed record Advisory(string Id, string Severity, string Summary, IReadOnlyList<(string Ecosystem, string Name, string Fixed)> Fixes);

    public async Task<Advisory?> GetAsync(string id, CancellationToken cancellationToken)
    {
        using var response = await http.GetAsync("v1/vulns/" + Uri.EscapeDataString(id), cancellationToken);
        if (await RegistryReplies.ReadAsync(response, "OSV", cancellationToken) is not { } document)
        {
            return null;
        }

        var severity = Severities.Normalize(RegistryReplies.Text(document["database_specific"]?["severity"]));
        var summary = RegistryReplies.Text(document["summary"]) ?? RegistryReplies.Text(document["details"])?.Split('\n')[0] ?? id;
        var fixes = new List<(string, string, string)>();
        foreach (var affected in document["affected"] as JsonArray ?? [])
        {
            var ecosystem = RegistryReplies.Text(affected?["package"]?["ecosystem"]) ?? "";
            var name = RegistryReplies.Text(affected?["package"]?["name"]) ?? "";
            foreach (var range in affected?["ranges"] as JsonArray ?? [])
            {
                foreach (var change in range?["events"] as JsonArray ?? [])
                {
                    if (RegistryReplies.Text(change?["fixed"]) is { } fixedVersion)
                    {
                        fixes.Add((ecosystem, name, fixedVersion));
                    }
                }
            }
        }

        return new Advisory(id, severity, summary.Length > 300 ? summary[..300] : summary, fixes);
    }
}
