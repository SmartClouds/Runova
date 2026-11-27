using System.Globalization;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Platform;

namespace Runova.ServerCore.Cloudflare;

/// <summary>What the machine has of cloudflared.</summary>
internal sealed record CloudflaredState(bool Installed, string? Version, bool Running);

/// <summary>cloudflared on the server: the package, and the tunnel unit the core runs it in.</summary>
internal interface ICloudflared
{
    Task<CloudflaredState> InspectAsync(CancellationToken cancellationToken);

    /// <summary>cloudflared from pkg.cloudflare.com, as a job step; nothing happens when it is already there.</summary>
    Task InstallAsync(JobContext job, CancellationToken cancellationToken);

    /// <summary>Writes the token and the unit, then (re)starts the tunnel.</summary>
    Task StartAsync(string token, int metricsPort, CancellationToken cancellationToken);

    /// <summary>Stops the tunnel for good: the unit goes and the token with it. The package stays.</summary>
    Task StopAsync(CancellationToken cancellationToken);
}

/// <summary>
/// Installs cloudflared the way Cloudflare's own guide does, but with the key checked against its
/// pinned fingerprint first, and runs the tunnel in a unit of the core's own rather than the one
/// `cloudflared service install` writes, which puts the token in ExecStart for anyone running
/// `systemctl show` to read. Here the token sits in a root-only environment file that systemd reads
/// before it drops to a throwaway user, and the unit is hardened: cloudflared only dials out, so it
/// needs no capability, no home and nothing writable.
/// </summary>
internal sealed class LinuxCloudflared(
    IProcessRunner runner,
    SystemdRunner units,
    ISystemFiles files,
    OsInfo os,
    IRepositoryKeys keys,
    string configDirectory) : ICloudflared
{
    public const string Binary = "/usr/bin/cloudflared";

    public const string UnitName = "runova-cloudflared.service";

    public const string UnitPath = "/etc/systemd/system/" + UnitName;

    private const string AptGet = "/usr/bin/apt-get";

    private const string Dnf = "/usr/bin/dnf";

    private const UnixFileMode Readable =
        UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead;

    private const UnixFileMode RootOnly = UnixFileMode.UserRead | UnixFileMode.UserWrite;

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

    public string EnvironmentPath => configDirectory.TrimEnd('/') + "/cloudflared.env";

    /// <summary>The unit's text; the token is never part of it.</summary>
    public string UnitText(int metricsPort) => $"""
        # Written by Runova: the Cloudflare Tunnel of this server's sites and core domain.
        # The token is in {EnvironmentPath} (root only); systemd reads it before dropping privileges.
        [Unit]
        Description=Cloudflare Tunnel (Runova)
        After=network-online.target
        Wants=network-online.target

        [Service]
        Type=notify
        EnvironmentFile={EnvironmentPath}
        ExecStart={Binary} --no-autoupdate tunnel --metrics 127.0.0.1:{metricsPort.ToString(CultureInfo.InvariantCulture)} run
        Restart=always
        RestartSec=5s
        TimeoutStartSec=0
        DynamicUser=yes
        NoNewPrivileges=yes
        CapabilityBoundingSet=
        AmbientCapabilities=
        ProtectSystem=strict
        ProtectHome=yes
        PrivateTmp=yes
        PrivateDevices=yes
        ProtectKernelTunables=yes
        ProtectKernelModules=yes
        ProtectKernelLogs=yes
        ProtectControlGroups=yes
        ProtectClock=yes
        ProtectHostname=yes
        RestrictNamespaces=yes
        RestrictRealtime=yes
        RestrictSUIDSGID=yes
        LockPersonality=yes
        RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
        SystemCallArchitectures=native

        [Install]
        WantedBy=multi-user.target

        """;

    public async Task<CloudflaredState> InspectAsync(CancellationToken cancellationToken)
    {
        if (!files.Exists(Binary))
        {
            return new CloudflaredState(false, null, false);
        }

        var version = await PlainAsync("cloudflared", ["--version"], cancellationToken);
        var active = await PlainAsync("systemctl", ["is-active", UnitName], cancellationToken);
        return new CloudflaredState(true, ParseVersion(version.StandardOutput), active.StandardOutput.Trim() == "active");
    }

    public async Task InstallAsync(JobContext job, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(job);
        if (files.Exists(Binary))
        {
            job.Log("cloudflared is already installed.");
            return;
        }

        if (os.Family is not (OsFamily.Debian or OsFamily.Rhel))
        {
            throw new JobFailedException("cloudflared can be installed on Ubuntu, Debian and the RHEL family (RHEL, Rocky, Alma, CentOS Stream).");
        }

        job.Log($"Downloading Cloudflare's repository key from {CloudflareRepositories.CloudflaredKeyUrl}.");
        var key = await keys.FetchAsync(CloudflareRepositories.CloudflaredKeyUrl, cancellationToken);
        if (!OpenPgpKey.HasOnly(key, CloudflareRepositories.CloudflaredFingerprint))
        {
            var found = OpenPgpKey.PrimaryFingerprints(key);
            throw new JobFailedException(
                $"The downloaded key is not Cloudflare's: expected fingerprint {CloudflareRepositories.CloudflaredFingerprint}, got {(found.Count == 0 ? "no key" : string.Join(", ", found))}. Nothing was changed.");
        }

        job.Log($"The key's fingerprint is Cloudflare's: {CloudflareRepositories.CloudflaredFingerprint}.");
        if (os.Family == OsFamily.Debian)
        {
            files.WriteText(CloudflareRepositories.CloudflaredAptKeyring, key, Readable);
            files.WriteText(CloudflareRepositories.CloudflaredAptSource, CloudflareRepositories.CloudflaredAptSourceText, Readable);
            job.Log("Added Cloudflare's cloudflared repository.");
            await PackagesAsync(job, "index", "Refresh the package index", AptGet, [.. _aptOptions, "update"], cancellationToken);
            await PackagesAsync(job, "install", "Install cloudflared", AptGet, [.. _aptOptions, "install", "cloudflared"], cancellationToken);
        }
        else
        {
            files.WriteText(CloudflareRepositories.CloudflaredRpmKey, key, Readable);
            files.WriteText(CloudflareRepositories.CloudflaredRpmRepository, CloudflareRepositories.CloudflaredRpmRepositoryText, Readable);
            job.Log("Added Cloudflare's cloudflared repository.");
            await PackagesAsync(job, "install", "Install cloudflared", Dnf, ["-y", "install", "cloudflared"], cancellationToken);
        }

        job.Log("cloudflared is installed.");
    }

    public async Task StartAsync(string token, int metricsPort, CancellationToken cancellationToken)
    {
        TunnelToken.Parse(token);
        ArgumentOutOfRangeException.ThrowIfLessThan(metricsPort, 1);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(metricsPort, 65535);
        files.WriteText(EnvironmentPath, $"TUNNEL_TOKEN={token}\n", RootOnly);
        files.WriteText(UnitPath, UnitText(metricsPort), Readable);
        await SystemctlAsync(["daemon-reload"], "systemd did not take the tunnel's unit", cancellationToken);
        await SystemctlAsync(["enable", UnitName], "The tunnel's unit could not be enabled at boot", cancellationToken);
        // cloudflared tells systemd it is ready only once it holds a connection to Cloudflare. Where
        // outbound UDP 7844 is blocked it first spends a minute or more on QUIC before it falls back to
        // HTTP/2, so the unit has no start timeout (a 60 s one killed it mid-fallback, over and over)
        // and the restart does not wait. The setup job waits for /ready on its own clock instead.
        await SystemctlAsync(["--no-block", "restart", UnitName], "cloudflared did not start", cancellationToken);
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        await PlainAsync("systemctl", ["disable", "--now", UnitName], cancellationToken);
        files.Delete(EnvironmentPath);
        files.Delete(UnitPath);
        await PlainAsync("systemctl", ["daemon-reload"], cancellationToken);
    }

    /// <summary>"cloudflared version 2025.10.1 (built …)" to "2025.10.1".</summary>
    public static string? ParseVersion(string? output)
    {
        var words = (output ?? string.Empty).Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        var index = Array.IndexOf(words, "version");
        return index >= 0 && index + 1 < words.Length ? words[index + 1] : null;
    }

    private async Task SystemctlAsync(string[] arguments, string failure, CancellationToken cancellationToken)
    {
        var result = await PlainAsync("systemctl", arguments, cancellationToken);
        if (!result.Succeeded)
        {
            var why = (result.StandardError.Trim() is { Length: > 0 } error ? error : result.StandardOutput.Trim()) is { Length: > 0 } text ? $": {text}" : ".";
            throw new CloudflareTunnelException(failure + why);
        }
    }

    private Task<ProcessResult> PlainAsync(string program, string[] arguments, CancellationToken cancellationToken) =>
        runner.RunAsync(new ProcessSpec { Program = program, Arguments = arguments, Timeout = TimeSpan.FromMinutes(1) }, onLine: null, cancellationToken);

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
        if (result.TimedOut)
        {
            throw new JobFailedException($"{Path.GetFileName(program)} did not finish within 20 minutes and was stopped.");
        }

        if (!result.Succeeded)
        {
            throw new JobFailedException($"{Path.GetFileName(program)} exited with code {result.ExitCode}. The log shows why.", result.ExitCode);
        }
    }
}
