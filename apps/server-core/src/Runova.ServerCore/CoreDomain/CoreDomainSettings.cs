using System.Security.Cryptography;
using System.Text.Json;
using Runova.ServerCore.Hosting;

namespace Runova.ServerCore.CoreDomain;

/// <summary>
/// The core domain (E44): a domain nginx serves over HTTPS and passes to the core, so the app can
/// reach the core without SSH. Port is the loopback port the core opens for nginx alone; Key is
/// the secret nginx sends with every request, which proves a request on that port came through
/// nginx (and so through its client certificate check). Sources limit who nginx lets in; empty
/// lets everyone reach the device check. Mode says how a device proves itself: its TLS client
/// certificate (Direct) or a signed header that passes through Cloudflare's proxy (Cloudflare).
/// </summary>
internal sealed record CoreDomainSettings(
    bool Enabled,
    string? Domain,
    int Port,
    string? Key,
    string[] Sources,
    long? ChangedAt = null,
    string? ChangedBy = null,
    Contracts.CoreDomainMode Mode = Contracts.CoreDomainMode.Direct)
{
    /// <summary>The reserved site that serves the domain. The Websites calls refuse to touch it.</summary>
    public const string SiteId = "runova-core";

    /// <summary>The header nginx sends the key in.</summary>
    public const string KeyHeader = "X-Runova-Proxy-Key";

    /// <summary>The header nginx sends the client certificate in, as nginx's $ssl_client_escaped_cert.</summary>
    public const string CertificateHeader = "X-Runova-Client-Certificate";

    /// <summary>The header the app signs each request in, in Cloudflare mode (<see cref="DeviceProof"/>).</summary>
    public const string ProofHeader = "X-Runova-Device-Proof";

    /// <summary>The header a refused proof names its reason in, so a check that reads only the head can tell a clock that is off.</summary>
    public const string RefusalHeader = "X-Runova-Refusal";

    public bool ThroughCloudflare => Mode == Contracts.CoreDomainMode.Cloudflare;

    public static CoreDomainSettings Off { get; } = new(false, null, 0, null, []);

    /// <summary>32 random bytes, base64url: safe in an nginx quoted string and an HTTP header.</summary>
    public static string NewKey() => Base64Url(RandomNumberGenerator.GetBytes(32));

    /// <summary>Whether a key has the shape <see cref="NewKey"/> makes, so nothing else reaches nginx's files.</summary>
    public static bool IsKey(string? key) =>
        key is { Length: 43 } && key.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_');

    private static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    /// <summary>Mode is null in a file written before modes existed, which read as Direct.</summary>
    internal sealed record Stored(bool Enabled, string? Domain, int Port, string? Key, string[]? Sources, long? ChangedAt, string? ChangedBy, Contracts.CoreDomainMode? Mode = null);
}

/// <summary>
/// The core domain's settings in the core's own state folder (root only, 0600), next to the
/// direct TLS ones. The key lives here and nowhere else the core writes, besides the nginx site
/// file that sends it (also root only). Read once and kept in memory; every write goes through here.
/// </summary>
internal sealed class CoreDomainStore(CoreDirectories directories)
{
    public const string FileName = "core-domain.json";

    private readonly Lock _gate = new();

    private CoreDomainSettings? _cached;

    public string Path => System.IO.Path.Combine(directories.Data, FileName);

    public CoreDomainSettings Read()
    {
        lock (_gate)
        {
            return _cached ??= Load(Path);
        }
    }

    public void Write(CoreDomainSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        lock (_gate)
        {
            var path = Path;
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)!);
            var temporary = $"{path}.{Guid.NewGuid():N}.tmp";
            var stored = CoreDomainMapper.ToStored(settings);
            File.WriteAllText(temporary, JsonSerializer.Serialize(stored, CoreJson.Options));
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            }

            File.Move(temporary, path, overwrite: true);
            _cached = settings;
        }
    }

    private static CoreDomainSettings Load(string path)
    {
        if (!File.Exists(path))
        {
            return CoreDomainSettings.Off;
        }

        try
        {
            var stored = JsonSerializer.Deserialize<CoreDomainSettings.Stored>(File.ReadAllText(path), CoreJson.Options);
            if (stored is null || stored.Port is < 0 or > 65535 || (stored.Key is not null && !CoreDomainSettings.IsKey(stored.Key))
                || (stored.Mode is { } mode && !Enum.IsDefined(mode))
                || DirectTls.DirectTlsSettings.ValidateSources(stored.Sources, out var sources) is not null)
            {
                return CoreDomainSettings.Off;
            }

            // On without a port or a key is not a state the core can serve; it reads as off.
            var enabled = stored.Enabled && stored.Port > 0 && stored.Key is not null && stored.Domain is not null;
            return CoreDomainMapper.ToSettings(stored, enabled, sources);
        }
        catch (JsonException)
        {
            // A file nobody can read again turns the mode off rather than guessing.
            return CoreDomainSettings.Off;
        }
    }
}
