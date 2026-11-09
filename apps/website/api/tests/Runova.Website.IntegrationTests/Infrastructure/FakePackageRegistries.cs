using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using Runova.Website.Api.Dependencies;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>
/// Stands in for npm, NuGet, pub.dev and OSV behind the check's HTTP clients. A test says what each
/// knows about a package; every request is kept so a test can count them.
/// </summary>
internal sealed class FakePackageRegistries
{
    private readonly ConcurrentDictionary<(string Ecosystem, string Name), (string Latest, string? Deprecated)> _packages = new();
    private readonly ConcurrentDictionary<(string Ecosystem, string Name, string Version), List<string>> _affected = new();
    private readonly ConcurrentDictionary<string, string> _vulns = new(StringComparer.Ordinal);
    private readonly ConcurrentQueue<string> _requests = new();
    private readonly ConcurrentDictionary<string, bool> _down = new(StringComparer.Ordinal);

    private readonly ConcurrentQueue<string> _osvEcosystems = new();

    public IReadOnlyList<string> Requests => [.. _requests];

    /// <summary>Every ecosystem name OSV has been asked about.</summary>
    public IReadOnlyList<string> OsvEcosystems => [.. _osvEcosystems];

    private static string Stored(string ecosystem, string name) => Runova.Website.Core.Dependencies.Ecosystems.PackageKey(ecosystem, name);

    private static string OsvName(string ecosystem) => ecosystem switch
    {
        "npm" => "npm",
        "nuget" => "NuGet",
        "pypi" => "PyPI",
        "crates" => "crates.io",
        "maven" => "Maven",
        "swift" => "SwiftURL",
        _ => "Pub",
    };

    private static string Ecosystem(string osvName) => osvName switch
    {
        "npm" => "npm",
        "NuGet" => "nuget",
        "PyPI" => "pypi",
        "crates.io" => "crates",
        "Maven" => "maven",
        "SwiftURL" => "swift",
        _ => "pub",
    };

    public int RequestsTo(string registry) => _requests.Count(r => r.StartsWith(registry + " ", StringComparison.Ordinal));

    /// <summary>The registry's newest version of a package, and its deprecation note if any.</summary>
    public FakePackageRegistries Has(string ecosystem, string name, string latest, string? deprecated = null)
    {
        _packages[(ecosystem, Stored(ecosystem, name))] = (latest, deprecated);
        return this;
    }

    /// <summary>An advisory, as GitHub's database writes it into OSV, on these versions of a package.</summary>
    public FakePackageRegistries Advisory(string id, string ecosystem, string name, string severity, string summary, string? fixedIn, params string[] versions)
    {
        foreach (var version in versions)
        {
            _affected.GetOrAdd((ecosystem, Stored(ecosystem, name), version), _ => []).Add(id);
        }

        var osvEcosystem = OsvName(ecosystem);
        var events = new JsonArray(new JsonObject { ["introduced"] = "0" });
        if (fixedIn is not null)
        {
            events.Add(new JsonObject { ["fixed"] = fixedIn });
        }

        _vulns[id] = new JsonObject
        {
            ["id"] = id,
            ["summary"] = summary,
            ["database_specific"] = new JsonObject { ["severity"] = severity.ToUpperInvariant() },
            ["affected"] = new JsonArray(new JsonObject
            {
                ["package"] = new JsonObject { ["ecosystem"] = osvEcosystem, ["name"] = name },
                ["ranges"] = new JsonArray(new JsonObject { ["type"] = "SEMVER", ["events"] = events }),
            }),
        }.ToJsonString();
        return this;
    }

    /// <summary>As when the registry (npm, nuget, pub or osv) can not be reached.</summary>
    public void IsDown(string registry, bool down = true) => _down[registry] = down;

    public void Register(IServiceCollection services)
    {
        services.AddHttpClient<NpmRegistryClient>().ConfigurePrimaryHttpMessageHandler(() => new Handler(this, "npm"));
        services.AddHttpClient<NuGetRegistryClient>().ConfigurePrimaryHttpMessageHandler(() => new Handler(this, "nuget"));
        services.AddHttpClient<PubRegistryClient>().ConfigurePrimaryHttpMessageHandler(() => new Handler(this, "pub"));
        services.AddHttpClient<OsvClient>().ConfigurePrimaryHttpMessageHandler(() => new Handler(this, "osv"));
        services.AddHttpClient<PyPiRegistryClient>().ConfigurePrimaryHttpMessageHandler(() => new Handler(this, "pypi"));
        services.AddHttpClient<CratesRegistryClient>().ConfigurePrimaryHttpMessageHandler(() => new Handler(this, "crates"));
        services.AddHttpClient<MavenRegistryClient>().ConfigurePrimaryHttpMessageHandler(() => new Handler(this, "maven"));
        services.AddHttpClient<SwiftRegistryClient>().ConfigurePrimaryHttpMessageHandler(() => new Handler(this, "swift"));
        services.AddHttpClient<CocoaPodsRegistryClient>().ConfigurePrimaryHttpMessageHandler(() => new Handler(this, "pods"));
    }

    private static HttpResponseMessage Json(string json) =>
        new(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    private HttpResponseMessage Answer(string registry, HttpRequestMessage request, string? body)
    {
        var path = Uri.UnescapeDataString(request.RequestUri!.AbsolutePath.TrimStart('/'));
        switch (registry)
        {
            case "npm":
                return _packages.TryGetValue(("npm", path), out var npm)
                    ? Json(new JsonObject
                    {
                        ["name"] = path,
                        ["dist-tags"] = new JsonObject { ["latest"] = npm.Latest },
                        ["versions"] = new JsonObject { [npm.Latest] = npm.Deprecated is null ? new JsonObject() : new JsonObject { ["deprecated"] = npm.Deprecated } },
                    }.ToJsonString())
                    : new HttpResponseMessage(HttpStatusCode.NotFound);
            case "pub":
                var pubName = path["api/packages/".Length..];
                return _packages.TryGetValue(("pub", pubName), out var pub)
                    ? Json(new JsonObject { ["name"] = pubName, ["latest"] = new JsonObject { ["version"] = pub.Latest }, ["isDiscontinued"] = pub.Deprecated is not null }.ToJsonString())
                    : new HttpResponseMessage(HttpStatusCode.NotFound);
            case "nuget":
                var id = path.Split('/')[2];
                if (!_packages.TryGetValue(("nuget", id), out var nuget))
                {
                    return new HttpResponseMessage(HttpStatusCode.NotFound);
                }

                var entry = new JsonObject { ["version"] = nuget.Latest, ["listed"] = true };
                if (nuget.Deprecated is not null)
                {
                    entry["deprecation"] = new JsonObject { ["reasons"] = new JsonArray("Legacy"), ["message"] = nuget.Deprecated };
                }

                return Json(new JsonObject
                {
                    ["items"] = new JsonArray(new JsonObject
                    {
                        ["items"] = new JsonArray(
                            new JsonObject { ["catalogEntry"] = new JsonObject { ["version"] = "0.0.1", ["listed"] = true } },
                            new JsonObject { ["catalogEntry"] = entry }),
                    }),
                }.ToJsonString());
            case "pypi":
                var pypiName = path.Split('/')[1];
                return _packages.TryGetValue(("pypi", pypiName), out var pypi)
                    ? Json(new JsonObject { ["info"] = new JsonObject { ["version"] = pypi.Latest } }.ToJsonString())
                    : new HttpResponseMessage(HttpStatusCode.NotFound);
            case "crates":
                return _packages.TryGetValue(("crates", path.Split('/')[^1]), out var crate)
                    ? Json(new JsonObject { ["vers"] = crate.Latest, ["yanked"] = false }.ToJsonString())
                    : new HttpResponseMessage(HttpStatusCode.NotFound);
            case "maven":
                var coordinates = path[(path.IndexOf("maven2/", StringComparison.Ordinal) + "maven2/".Length)..];
                var known = _packages.Where(p => p.Key.Ecosystem == "maven").FirstOrDefault(p => coordinates.StartsWith(p.Key.Name.Replace('.', '/').Replace(':', '/') + "/", StringComparison.Ordinal));
                return known.Key.Name is null
                    ? new HttpResponseMessage(HttpStatusCode.NotFound)
                    : Json($"<metadata><versioning><versions><version>{known.Value.Latest}</version></versions></versioning></metadata>");
            case "swift":
                var repository = "github.com/" + path[..path.IndexOf(".git/", StringComparison.Ordinal)];
                return _packages.TryGetValue(("swift", repository), out var swift)
                    ? Json($"003f{new string('a', 40)} refs/tags/{swift.Latest}\n0000")
                    : new HttpResponseMessage(HttpStatusCode.NotFound);
            case "pods":
                return Json(string.Join('\n', _packages.Where(p => p.Key.Ecosystem == "pods").Select(p => $"{p.Key.Name}/{p.Value.Latest}")));
            default:
                if (path == "v1/querybatch")
                {
                    var queries = JsonNode.Parse(body!)!["queries"]!.AsArray();
                    var results = new JsonArray();
                    foreach (var query in queries)
                    {
                        _osvEcosystems.Enqueue(query!["package"]!["ecosystem"]!.GetValue<string>());
                        var ecosystem = Ecosystem(query["package"]!["ecosystem"]!.GetValue<string>());
                        var key = (ecosystem, query["package"]!["name"]!.GetValue<string>(), query["version"]!.GetValue<string>());
                        var vulns = new JsonArray();
                        foreach (var vuln in _affected.GetValueOrDefault(key) ?? [])
                        {
                            vulns.Add(new JsonObject { ["id"] = vuln, ["modified"] = "2026-10-01T00:00:00Z" });
                        }

                        results.Add(vulns.Count == 0 ? new JsonObject() : new JsonObject { ["vulns"] = vulns });
                    }

                    return Json(new JsonObject { ["results"] = results }.ToJsonString());
                }

                return _vulns.TryGetValue(path["v1/vulns/".Length..], out var vulnJson) ? Json(vulnJson) : new HttpResponseMessage(HttpStatusCode.NotFound);
        }
    }

    private sealed class Handler(FakePackageRegistries fake, string registry) : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            fake._requests.Enqueue($"{registry} {request.Method} {request.RequestUri!.AbsolutePath}");
            if (fake._down.GetValueOrDefault(registry))
            {
                throw new HttpRequestException($"{registry} could not be reached (fake).");
            }

            var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
            return fake.Answer(registry, request, body);
        }
    }
}

/// <summary>A schedule that always lands in the middle: the first check half an hour on, the next exactly a day on.</summary>
internal sealed class FixedSchedule(TimeProvider time, double next = 0.5) : CheckSchedule(time)
{
    protected override double Next() => next;
}
