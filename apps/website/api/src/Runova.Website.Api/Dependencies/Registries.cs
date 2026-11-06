using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Nodes;
using Runova.Website.Core.Dependencies;

namespace Runova.Website.Api.Dependencies;

/// <summary>Where the registries are, from <c>PackageRegistries:*</c>. Only tests and mirrors change them.</summary>
internal sealed class PackageRegistryOptions
{
    public Uri Npm { get; set; } = new("https://registry.npmjs.org/");

    public Uri NuGet { get; set; } = new("https://api.nuget.org/");

    public Uri Pub { get; set; } = new("https://pub.dev/");

    public Uri Osv { get; set; } = new("https://api.osv.dev/");

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
