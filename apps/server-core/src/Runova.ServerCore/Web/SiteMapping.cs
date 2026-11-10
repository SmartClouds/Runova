using System.Diagnostics.CodeAnalysis;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Riok.Mapperly.Abstractions;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Web;

/// <summary>
/// Between what the app sends and the typed nginx model. Nothing here decides what is allowed:
/// the model goes through <see cref="NginxValidator"/> whoever built it. This only turns the wire
/// shape into the model, hashes new basic auth passwords, and says which wire fields are missing.
/// </summary>
[Mapper]
internal static partial class SiteMapping
{
    /// <summary>Snippets arrive inside a 64 KB message; this leaves room for everything else in it.</summary>
    public const int MaxSnippetLength = 16 * 1024;

    public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, CoreJson.Options);

    public static T Deserialize<T>(string json) =>
        JsonSerializer.Deserialize<T>(json, CoreJson.Options) ?? throw new InvalidDataException("A stored site could not be read.");

    /// <summary>The settings as stored and shown: no passwords, domains in lowercase.</summary>
    public static SiteSettings Normalize(SiteSettings settings) => settings with
    {
        Domains = [.. (settings.Domains ?? []).Select(domain => (domain ?? string.Empty).Trim().ToLowerInvariant())],
        BasicAuth = settings.BasicAuth is { } auth
            ? auth with { Users = [.. (auth.Users ?? []).Select(user => new SiteBasicAuthUser(user?.Name ?? string.Empty))] }
            : null,
    };

    /// <summary>
    /// The hashes to store: a new password is hashed, a missing one keeps the hash stored for that
    /// user. A user with neither is a problem.
    /// </summary>
    public static Dictionary<string, string> HashPasswords(SiteSettings settings, IReadOnlyDictionary<string, string> stored, List<NginxProblem> problems)
    {
        var hashes = new Dictionary<string, string>(StringComparer.Ordinal);
        var users = settings.BasicAuth?.Users ?? [];
        for (var i = 0; i < users.Length; i++)
        {
            var name = users[i]?.Name ?? string.Empty;
            var password = users[i]?.Password;
            if (!string.IsNullOrEmpty(password))
            {
                if (password.Length is < 8 or > 256)
                {
                    problems.Add(new NginxProblem($"sites[{settings.Id}].basicAuth.users[{i}].password", "A basic auth password is 8 to 256 characters."));
                    continue;
                }

                hashes[name] = Sha512Crypt.Hash(password);
            }
            else if (stored.TryGetValue(name, out var hash))
            {
                hashes[name] = hash;
            }
            else
            {
                problems.Add(new NginxProblem($"sites[{settings.Id}].basicAuth.users[{i}].password", $"{NginxNames.Show(name)} needs a password."));
            }
        }

        return hashes;
    }

    public static NginxSite ToModel(Site row, NginxCertificate? certificate)
    {
        ArgumentNullException.ThrowIfNull(row);
        var settings = Deserialize<SiteSettings>(row.Settings);
        var hashes = row.BasicAuthHashes is null ? [] : Deserialize<Dictionary<string, string>>(row.BasicAuthHashes);
        return ToModel(settings, hashes, row.ServerSnippet, row.LocationSnippet, certificate);
    }

    public static NginxSite ToModel(
        SiteSettings settings,
        IReadOnlyDictionary<string, string> hashes,
        string? serverSnippet,
        string? locationSnippet,
        NginxCertificate? certificate)
    {
        ArgumentNullException.ThrowIfNull(settings);
        return ToModel(settings, BasicAuthOf(settings.BasicAuth, hashes), serverSnippet, locationSnippet, certificate);
    }

    public static NginxStreamProxy ToModel(StreamProxySettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        return ToStreamModel(settings);
    }

    /// <summary>A stable hash of what a site renders from, so "applied" can be told from "saved".</summary>
    public static string Fingerprint(params string?[] parts)
    {
        var text = string.Join('\u001f', parts.Select(part => part ?? "\u0000"));
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));
    }

    public static NginxProblemInfo ToInfo(NginxProblem problem)
    {
        ArgumentNullException.ThrowIfNull(problem);
        return ToProblemInfo(problem);
    }

    /// <summary>A stored site as the app sees it; whether it is applied and its certificate come from the caller.</summary>
    [MapProperty(nameof(Site.Settings), nameof(SiteInfo.Settings), Use = nameof(ReadSiteSettings))]
    [MapProperty(nameof(Site.CreatedAt), nameof(SiteInfo.CreatedAtUnixMs))]
    [MapProperty(nameof(Site.UpdatedAt), nameof(SiteInfo.UpdatedAtUnixMs))]
    public static partial SiteInfo ToInfo(Site site, bool applied, CertificateInfo? certificate);

    /// <summary>A stored stream proxy; it is applied when nginx runs what is saved.</summary>
    [MapProperty(nameof(StreamProxy.Settings), nameof(StreamProxyInfo.Settings), Use = nameof(ReadStreamSettings))]
    [MapPropertyFromSource(nameof(StreamProxyInfo.Applied), Use = nameof(IsApplied))]
    [MapProperty(nameof(StreamProxy.UpdatedAt), nameof(StreamProxyInfo.UpdatedAtUnixMs))]
    public static partial StreamProxyInfo ToInfo(StreamProxy row);

    /// <summary>
    /// The wire settings as the model. Enums map by name: values outside their range are refused
    /// as wire problems before a model is ever built.
    /// </summary>
    [MapperIgnoreSource(nameof(SiteSettings.BasicAuth))]
    [MapperIgnoreTarget(nameof(NginxSite.OcspStapling))]
    [MapProperty(nameof(SiteSettings.Id), nameof(NginxSite.Id), Use = nameof(OrEmpty))]
    [MapProperty(nameof(SiteSettings.Domains), nameof(NginxSite.Domains), Use = nameof(OrNone))]
    [MapProperty(nameof(SiteSettings.Upstream), nameof(NginxSite.Upstream), Use = nameof(SiteUpstream))]
    [MapProperty(nameof(SiteSettings.SecurityHeaders), nameof(NginxSite.SecurityHeaders), Use = nameof(SecurityHeadersOf))]
    [MapProperty(nameof(SiteSettings.ResponseHeaders), nameof(NginxSite.ResponseHeaders), Use = nameof(ResponseHeadersOf))]
    private static partial NginxSite ToModel(
        SiteSettings settings,
        NginxBasicAuth? basicAuth,
        string? serverSnippet,
        string? locationSnippet,
        NginxCertificate? certificate);

    [MapProperty(nameof(SiteProxyCache.BypassCookies), nameof(NginxProxyCache.BypassCookies), Use = nameof(OrNone))]
    private static partial NginxProxyCache ToModel(SiteProxyCache cache);

    private static partial NginxSecurityHeaders ToModel(SiteSecurityHeaders security);

    private static partial NginxHsts ToModel(SiteHsts hsts);

    [MapProperty(nameof(SiteIpRules.Allow), nameof(NginxIpRules.Allow), Use = nameof(OrNone))]
    [MapProperty(nameof(SiteIpRules.Deny), nameof(NginxIpRules.Deny), Use = nameof(OrNone))]
    private static partial NginxIpRules ToModel(SiteIpRules rules);

    private static partial NginxRateLimit ToModel(SiteRateLimit rate);

    private static partial NginxTimeouts ToModel(SiteTimeouts timeouts);

    [MapProperty(nameof(StreamProxySettings.Id), nameof(NginxStreamProxy.Id), Use = nameof(OrEmpty))]
    [MapProperty(nameof(StreamProxySettings.Upstream), nameof(NginxStreamProxy.Upstream), Use = nameof(StreamUpstream))]
    [MapProperty(nameof(StreamProxySettings.AllowFrom), nameof(NginxStreamProxy.AllowFrom), Use = nameof(OrNone))]
    private static partial NginxStreamProxy ToStreamModel(StreamProxySettings settings);

    [MapProperty(nameof(NginxProblem.Field), nameof(NginxProblemInfo.SiteId), Use = nameof(SiteIdOf))]
    private static partial NginxProblemInfo ToProblemInfo(NginxProblem problem);

    /// <summary>Each user with the hash stored for them; a user with none gets an empty one, which the validator refuses.</summary>
    private static NginxBasicAuth? BasicAuthOf(SiteBasicAuth? auth, IReadOnlyDictionary<string, string> hashes) =>
        auth is null
            ? null
            : new NginxBasicAuth(
                [.. (auth.Users ?? []).Select(user => new NginxBasicAuthUser(user?.Name ?? string.Empty, hashes.GetValueOrDefault(user?.Name ?? string.Empty, string.Empty)))],
                auth.Realm ?? string.Empty);

    // The wire can leave out what the contract calls required; these read a missing value as empty.
    private static string OrEmpty(string? value) => value ?? string.Empty;

    [SuppressMessage("Performance", "CA1859", Justification = "Mapperly needs the target member's own type.")]
    private static IReadOnlyList<string> OrNone(string[]? values) => values ?? [];

    private static NginxSecurityHeaders SecurityHeadersOf(SiteSecurityHeaders? security) => ToModel(security ?? new SiteSecurityHeaders());

    private static IReadOnlyList<NginxHeader> ResponseHeadersOf(SiteHeader[]? headers) =>
        [.. (headers ?? []).Select(header => new NginxHeader(header?.Name ?? string.Empty, header?.Value ?? string.Empty))];

    private static NginxUpstream StreamUpstream(UpstreamTarget? target) => target switch
    {
        { Kind: UpstreamKind.ServicePort } service => new NginxServiceUpstream(Label(service), service.Port ?? 0),
        { Kind: UpstreamKind.Endpoint } endpoint => new NginxEndpointUpstream(endpoint.Address ?? string.Empty),
        _ => new Unsupported(),
    };

    private static string? SiteIdOf(string field) => NginxTestOutput.SiteIdOf(field);

    private static SiteSettings ReadSiteSettings(string settings) => Deserialize<SiteSettings>(settings);

    private static StreamProxySettings ReadStreamSettings(string settings) => Deserialize<StreamProxySettings>(settings);

    private static bool IsApplied(StreamProxy row) => row.AppliedFingerprint == Fingerprint(row.Settings);

    private static NginxUpstream SiteUpstream(UpstreamTarget? target) => target switch
    {
        { Kind: UpstreamKind.ServicePort } service => new NginxServiceUpstream(Label(service), service.Port ?? 0),
        { Kind: UpstreamKind.Url } url => new NginxUrlUpstream(url.Address ?? string.Empty, url.VerifyCertificate, url.SendUpstreamHost),
        { Kind: UpstreamKind.RunovaCore } core => new NginxCoreUpstream(core.Port ?? 0),
        _ => new Unsupported(),
    };

    private static string Label(UpstreamTarget target) => string.IsNullOrWhiteSpace(target.Service) ? "local" : target.Service;

    /// <summary>An upstream kind the site or proxy cannot use; the validator reports it.</summary>
    private sealed record Unsupported : NginxUpstream;
}
