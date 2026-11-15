using System.Net;
using System.Text.RegularExpressions;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Platform;

namespace Runova.ServerCore.Cloudflare;

/// <summary>The server as a Cloudflare Mesh node: the Cloudflare One client, registered with a node token.</summary>
internal interface ICloudflareMesh
{
    /// <summary>Installs the client if needed, registers the node and connects; returns the node's Mesh address.</summary>
    Task<string> JoinAsync(string token, JobContext job, CancellationToken cancellationToken);
}

/// <summary>
/// Follows Cloudflare's guide for a Linux Mesh node: cloudflare-warp from pkg.cloudflareclient.com
/// (with its key checked against the pinned fingerprint first), then `warp-cli connector new` with
/// the node token and `warp-cli connect`. warp-cli only takes the token as an argument, so it is on
/// that one root command's argument list for the moment it runs; it never reaches the job's log or
/// an error message. The node's address is the one on the CloudflareWARP interface, which must lie
/// in Mesh's range (100.96.0.0/12).
/// </summary>
internal sealed partial class LinuxCloudflareMesh(
    IProcessRunner runner,
    SystemdRunner units,
    ISystemFiles files,
    OsInfo os,
    IRepositoryKeys keys,
    TimeProvider time) : ICloudflareMesh
{
    public const string Binary = "/usr/bin/warp-cli";

    public const string Interface = "CloudflareWARP";

    private const string AptGet = "/usr/bin/apt-get";

    private const string Dnf = "/usr/bin/dnf";

    private const UnixFileMode Readable =
        UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead;

    private static readonly IPNetwork _mesh = IPNetwork.Parse(TunnelFirewallPlanner.MeshRange);

    private static readonly TimeSpan _addressWait = TimeSpan.FromSeconds(60);

    private static readonly string[] _aptOptions =
    [
        "-q", "-y", "-o", "DPkg::Lock::Timeout=300", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold",
    ];

    private static readonly Dictionary<string, string> _aptEnvironment = new(StringComparer.Ordinal)
    {
        ["DEBIAN_FRONTEND"] = "noninteractive",
        ["NEEDRESTART_MODE"] = "a",
        ["APT_LISTCHANGES_FRONTEND"] = "none",
        ["UCF_FORCE_CONFFOLD"] = "1",
    };

    public async Task<string> JoinAsync(string token, JobContext job, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(job);
        TunnelToken.Parse(token);
        await InstallAsync(job, cancellationToken);

        job.Log("Registering this server as a Cloudflare Mesh node.");
        var registered = await WarpAsync(["--accept-tos", "connector", "new", token], cancellationToken);
        if (!registered.Succeeded)
        {
            throw new JobFailedException(
                "The Cloudflare One client did not register the node. The token may be revoked or meant for another node; add the server to Mesh again from the app.");
        }

        job.Log("Connecting to Cloudflare Mesh.");
        var connected = await WarpAsync(["--accept-tos", "connect"], cancellationToken);
        if (!connected.Succeeded)
        {
            throw new JobFailedException($"The Cloudflare One client registered the node but did not connect: {Scrub(connected.StandardError, token)}");
        }

        var deadline = time.GetUtcNow() + _addressWait;
        while (true)
        {
            var shown = await runner.RunAsync(
                new ProcessSpec { Program = "ip", Arguments = ["-4", "-o", "addr", "show", "dev", Interface], Timeout = TimeSpan.FromSeconds(10) },
                onLine: null,
                cancellationToken);
            if (ParseAddress(shown.StandardOutput) is { } address)
            {
                job.Log($"This server's Mesh address is {address}.");
                job.ExitCode = 0;
                return address;
            }

            if (time.GetUtcNow() >= deadline)
            {
                throw new JobFailedException("The node connected, but no Mesh address showed up on the CloudflareWARP interface within a minute.");
            }

            await Task.Delay(TimeSpan.FromSeconds(2), time, cancellationToken);
        }
    }

    /// <summary>The IPv4 address on the interface, when it lies in Mesh's range; otherwise null.</summary>
    public static string? ParseAddress(string? output)
    {
        var match = InetAddress().Match(output ?? string.Empty);
        return match.Success && IPAddress.TryParse(match.Groups[1].Value, out var address) && _mesh.Contains(address) ? address.ToString() : null;
    }

    private async Task InstallAsync(JobContext job, CancellationToken cancellationToken)
    {
        if (files.Exists(Binary))
        {
            job.Log("The Cloudflare One client is already installed.");
            return;
        }

        if (os.Family is not (OsFamily.Debian or OsFamily.Rhel))
        {
            throw new JobFailedException("The Cloudflare One client can be installed on Ubuntu, Debian and the RHEL family.");
        }

        job.Log($"Downloading Cloudflare's client repository key from {CloudflareRepositories.WarpKeyUrl}.");
        var key = await keys.FetchAsync(CloudflareRepositories.WarpKeyUrl, cancellationToken);
        if (!OpenPgpKey.HasOnly(key, CloudflareRepositories.WarpFingerprint))
        {
            var found = OpenPgpKey.PrimaryFingerprints(key);
            throw new JobFailedException(
                $"The downloaded key is not Cloudflare's: expected fingerprint {CloudflareRepositories.WarpFingerprint}, got {(found.Count == 0 ? "no key" : string.Join(", ", found))}. Nothing was changed.");
        }

        job.Log($"The key's fingerprint is Cloudflare's: {CloudflareRepositories.WarpFingerprint}.");
        if (os.Family == OsFamily.Debian)
        {
            var release = OsRelease.Parse(files.ReadText(OsRelease.Path) ?? files.ReadText(OsRelease.FallbackPath) ?? string.Empty);
            var codename = release.GetValueOrDefault("UBUNTU_CODENAME") is { Length: > 0 } ubuntu ? ubuntu : release.GetValueOrDefault("VERSION_CODENAME");
            if (string.IsNullOrEmpty(codename) || !codename.All(c => char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c)))
            {
                throw new JobFailedException("This system's release has no codename, so Cloudflare's client repository cannot be picked.");
            }

            files.WriteText(CloudflareRepositories.WarpAptKeyring, key, Readable);
            files.WriteText(CloudflareRepositories.WarpAptSource, CloudflareRepositories.WarpAptSourceFor(codename), Readable);
            await PackagesAsync(job, "index", "Refresh the package index", AptGet, [.. _aptOptions, "update"], cancellationToken);
            await PackagesAsync(job, "install", "Install the Cloudflare One client", AptGet, [.. _aptOptions, "install", "cloudflare-warp"], cancellationToken);
        }
        else
        {
            files.WriteText(CloudflareRepositories.WarpRpmKey, key, Readable);
            files.WriteText(CloudflareRepositories.WarpRpmRepository, CloudflareRepositories.WarpRpmRepositoryText, Readable);
            await PackagesAsync(job, "install", "Install the Cloudflare One client", Dnf, ["-y", "install", "cloudflare-warp"], cancellationToken);
        }
    }

    private Task<ProcessResult> WarpAsync(string[] arguments, CancellationToken cancellationToken) =>
        runner.RunAsync(new ProcessSpec { Program = "warp-cli", Arguments = arguments, Timeout = TimeSpan.FromMinutes(1) }, onLine: null, cancellationToken);

    private static string Scrub(string text, string token)
    {
        var trimmed = text.Replace(token, "[token]", StringComparison.Ordinal).Trim();
        return trimmed.Length > 300 ? trimmed[..299] + "…" : trimmed;
    }

    private async Task PackagesAsync(JobContext job, string step, string description, string program, string[] arguments, CancellationToken cancellationToken)
    {
        var command = new ProcessSpec
        {
            Program = program,
            Arguments = arguments,
            Environment = program == AptGet ? _aptEnvironment : new Dictionary<string, string>(),
            Timeout = TimeSpan.FromMinutes(20),
            MaxOutputBytes = 256 * 1024,
        };
        var result = await units.RunAsync(job.UnitFor(step), description, command, job.Output, cancellationToken);
        job.ExitCode = result.ExitCode;
        if (!result.Succeeded)
        {
            throw new JobFailedException(
                result.TimedOut ? $"{Path.GetFileName(program)} did not finish within 20 minutes and was stopped." : $"{Path.GetFileName(program)} exited with code {result.ExitCode}. The log shows why.",
                result.ExitCode);
        }
    }

    [GeneratedRegex(@"\binet\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/\d+", RegexOptions.CultureInvariant)]
    private static partial Regex InetAddress();
}
