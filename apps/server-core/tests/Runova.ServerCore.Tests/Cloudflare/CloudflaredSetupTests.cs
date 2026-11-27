using System.Text;
using System.Text.Json;
using Runova.ServerCore.Cloudflare;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Platform;

namespace Runova.ServerCore.Tests.Cloudflare;

/// <summary>
/// E95 T2: cloudflared from Cloudflare's own signed repository on both families, the key trusted
/// only with its pinned fingerprint, and the tunnel run as a hardened unit of the core's own whose
/// token sits in a root-only environment file and nowhere else: never in a unit, an argument list
/// or the job log.
/// </summary>
public sealed class CloudflaredSetupTests
{
    private static readonly string[] _aptOptions =
    [
        "-q", "-y", "-o", "DPkg::Lock::Timeout=300", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold",
    ];

    private static readonly Guid _tunnelId = Guid.Parse("c1744f8b-faa1-48a4-9e5c-02ac921467fa");

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    internal static string Token(Guid? tunnel = null, string account = "699d98642c564d2e855e9661899b7252") =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new Dictionary<string, string>
        {
            ["a"] = account,
            ["t"] = (tunnel ?? _tunnelId).ToString(),
            ["s"] = Convert.ToBase64String(new byte[32]),
        })));

    private sealed class Keys(string key) : IRepositoryKeys
    {
        public List<Uri> Fetched { get; } = [];

        public Task<string> FetchAsync(Uri url, CancellationToken cancellationToken)
        {
            Fetched.Add(url);
            return Task.FromResult(key);
        }
    }

    /// <summary>The real files, with the mode each was written with.</summary>
    private sealed class RecordingFiles(ISystemFiles inner) : ISystemFiles
    {
        public Dictionary<string, UnixFileMode> Modes { get; } = new(StringComparer.Ordinal);

        public string? ReadText(string path) => inner.ReadText(path);

        public bool Exists(string path) => inner.Exists(path);

        public void WriteText(string path, string content, UnixFileMode mode)
        {
            Modes[path] = mode;
            inner.WriteText(path, content, mode);
        }

        public void Delete(string path) => inner.Delete(path);
    }

    private static string Key(string name) => Fixtures.Read($"cloudflare/keys/{name}.asc");

    private static OsInfo Os(TestRoot root) => OsRelease.Describe(OsRelease.Parse(root.Files.ReadText(OsRelease.Path)!));

    private static TestRoot Ubuntu()
    {
        var root = new TestRoot("ubuntu-24.04");
        root.Write("/etc/apt/keyrings/.keep", string.Empty);
        root.Write("/etc/apt/sources.list.d/.keep", string.Empty);
        root.Write("/etc/systemd/system/.keep", string.Empty);
        root.Write("/etc/runova-core/.keep", string.Empty);
        return root;
    }

    private static TestRoot Rocky()
    {
        var root = new TestRoot("rocky-9");
        root.Write("/etc/pki/rpm-gpg/.keep", string.Empty);
        root.Write("/etc/yum.repos.d/.keep", string.Empty);
        return root;
    }

    private static LinuxCloudflared Setup(TestRoot root, FakeProcessRunner processes, IRepositoryKeys keys, ISystemFiles? files = null) =>
        new(processes, Units.Runner(processes), files ?? root.Files, Os(root), keys, "/etc/runova-core");

    [Fact]
    public async Task On_ubuntu_it_adds_cloudflare_s_signed_repository_and_installs_cloudflared()
    {
        using var root = Ubuntu();
        var processes = new FakeProcessRunner();
        var keys = new Keys(Key("cloudflared"));
        using var job = new TestJob(JobKind.CloudflareTunnelSetup);

        await Setup(root, processes, keys).InstallAsync(job.Context, Cancel);

        Assert.Equal([CloudflareRepositories.CloudflaredKeyUrl], keys.Fetched);
        Assert.Equal(Key("cloudflared"), File.ReadAllText(root.Resolve(CloudflareRepositories.CloudflaredAptKeyring)));
        var source = File.ReadAllText(root.Resolve(CloudflareRepositories.CloudflaredAptSource));
        Assert.Contains("URIs: https://pkg.cloudflare.com/cloudflared\n", source, StringComparison.Ordinal);
        Assert.Contains("Suites: any\n", source, StringComparison.Ordinal);
        Assert.Contains("Components: main\n", source, StringComparison.Ordinal);
        Assert.Contains($"Signed-By: {CloudflareRepositories.CloudflaredAptKeyring}\n", source, StringComparison.Ordinal);
        Assert.Equal(
            [
                ["/usr/bin/apt-get", .. _aptOptions, "update"],
                ["/usr/bin/apt-get", .. _aptOptions, "install", "cloudflared"],
            ],
            processes.Calls.Where(Units.IsUnitRun).Select(Units.Command).ToList());
        Assert.Contains(await job.LinesAsync(), line => line.Text.Contains(CloudflareRepositories.CloudflaredFingerprint, StringComparison.Ordinal));
    }

    [Fact]
    public async Task On_rocky_it_installs_from_the_rpm_repository_with_the_key_on_disk()
    {
        using var root = Rocky();
        var processes = new FakeProcessRunner();
        using var job = new TestJob(JobKind.CloudflareTunnelSetup);

        await Setup(root, processes, new Keys(Key("cloudflared"))).InstallAsync(job.Context, Cancel);

        var repository = File.ReadAllText(root.Resolve(CloudflareRepositories.CloudflaredRpmRepository));
        Assert.Contains("baseurl=https://pkg.cloudflare.com/cloudflared/rpm\n", repository, StringComparison.Ordinal);
        Assert.Contains("gpgcheck=1\n", repository, StringComparison.Ordinal);
        Assert.Contains($"gpgkey=file://{CloudflareRepositories.CloudflaredRpmKey}\n", repository, StringComparison.Ordinal);
        Assert.Equal([["/usr/bin/dnf", "-y", "install", "cloudflared"]], processes.Calls.Where(Units.IsUnitRun).Select(Units.Command).ToList());
    }

    [Fact]
    public async Task A_key_that_is_not_cloudflare_s_stops_before_anything_changes()
    {
        using var root = Ubuntu();
        var processes = new FakeProcessRunner();
        using var job = new TestJob(JobKind.CloudflareTunnelSetup);

        var refusal = await Assert.ThrowsAsync<JobFailedException>(() =>
            Setup(root, processes, new Keys(Key("warp"))).InstallAsync(job.Context, Cancel));

        Assert.Contains("is not Cloudflare's", refusal.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(processes.Calls, Units.IsUnitRun);
        Assert.False(File.Exists(root.Resolve(CloudflareRepositories.CloudflaredAptKeyring)));
    }

    [Fact]
    public async Task An_installed_cloudflared_is_left_as_it_is()
    {
        using var root = Ubuntu();
        root.Write(LinuxCloudflared.Binary, "#!/bin/sh");
        var processes = new FakeProcessRunner();
        var keys = new Keys(Key("cloudflared"));
        using var job = new TestJob(JobKind.CloudflareTunnelSetup);

        await Setup(root, processes, keys).InstallAsync(job.Context, Cancel);

        Assert.Empty(keys.Fetched);
        Assert.DoesNotContain(processes.Calls, Units.IsUnitRun);
    }

    [Fact]
    public async Task Starting_writes_the_token_to_a_root_only_file_and_a_hardened_unit_without_it()
    {
        using var root = Ubuntu();
        var processes = new FakeProcessRunner();
        var files = new RecordingFiles(root.Files);
        var token = Token();

        await Setup(root, processes, new Keys(string.Empty), files).StartAsync(token, metricsPort: 20241, Cancel);

        var environment = File.ReadAllText(root.Resolve("/etc/runova-core/cloudflared.env"));
        Assert.Equal($"TUNNEL_TOKEN={token}\n", environment);
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, files.Modes["/etc/runova-core/cloudflared.env"]);
        var unit = File.ReadAllText(root.Resolve(LinuxCloudflared.UnitPath));
        Assert.DoesNotContain(token, unit, StringComparison.Ordinal);
        Assert.Contains("EnvironmentFile=/etc/runova-core/cloudflared.env\n", unit, StringComparison.Ordinal);
        Assert.Contains("ExecStart=/usr/bin/cloudflared --no-autoupdate tunnel --metrics 127.0.0.1:20241 run\n", unit, StringComparison.Ordinal);
        Assert.Contains("DynamicUser=yes\n", unit, StringComparison.Ordinal);
        Assert.Contains("NoNewPrivileges=yes\n", unit, StringComparison.Ordinal);
        Assert.Contains("ProtectSystem=strict\n", unit, StringComparison.Ordinal);
        Assert.Contains("CapabilityBoundingSet=\n", unit, StringComparison.Ordinal);
        Assert.Contains("Restart=always\n", unit, StringComparison.Ordinal);
        // No start timeout: with QUIC blocked, cloudflared needs over a minute to fall back to HTTP/2.
        Assert.Contains("TimeoutStartSec=0\n", unit, StringComparison.Ordinal);
        Assert.Contains(processes.Calls, spec => FakeProcessRunner.Is(spec, "systemctl", "daemon-reload"));
        Assert.Contains(processes.Calls, spec => FakeProcessRunner.Is(spec, "systemctl", "enable", LinuxCloudflared.UnitName));
        Assert.Contains(processes.Calls, spec => FakeProcessRunner.Is(spec, "systemctl", "--no-block", "restart", LinuxCloudflared.UnitName));
        Assert.DoesNotContain(processes.Calls, spec => spec.Arguments.Any(argument => argument.Contains(token, StringComparison.Ordinal)));
        Assert.DoesNotContain(processes.Calls, spec => spec.Environment.Values.Any(value => value.Contains(token, StringComparison.Ordinal)));
    }

    [Theory]
    [InlineData("")]
    [InlineData("abc\nEVIL=1")]
    [InlineData("not base64 at all!")]
    public async Task A_token_that_is_not_a_tunnel_token_is_refused_before_anything_is_written(string token)
    {
        using var root = Ubuntu();
        var processes = new FakeProcessRunner();

        await Assert.ThrowsAsync<CloudflareTunnelException>(() => Setup(root, processes, new Keys(string.Empty)).StartAsync(token, 20241, Cancel));

        Assert.False(File.Exists(root.Resolve("/etc/runova-core/cloudflared.env")));
        Assert.Empty(processes.Calls);
    }

    [Fact]
    public async Task A_unit_that_does_not_start_says_why()
    {
        using var root = Ubuntu();
        var processes = new FakeProcessRunner();
        processes.Respond("systemctl", ["--no-block", "restart"], _ => FakeProcessRunner.Exit(1, error: "Job for runova-cloudflared.service failed."));

        var failure = await Assert.ThrowsAsync<CloudflareTunnelException>(() => Setup(root, processes, new Keys(string.Empty)).StartAsync(Token(), 20241, Cancel));

        Assert.Contains("did not start", failure.Message, StringComparison.Ordinal);
        Assert.Contains("runova-cloudflared.service failed", failure.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Stopping_disables_the_unit_and_removes_the_token_and_the_unit()
    {
        using var root = Ubuntu();
        var processes = new FakeProcessRunner();
        var setup = Setup(root, processes, new Keys(string.Empty));
        await setup.StartAsync(Token(), 20241, Cancel);

        await setup.StopAsync(Cancel);

        Assert.Contains(processes.Calls, spec => FakeProcessRunner.Is(spec, "systemctl", "disable", "--now", LinuxCloudflared.UnitName));
        Assert.False(File.Exists(root.Resolve("/etc/runova-core/cloudflared.env")));
        Assert.False(File.Exists(root.Resolve(LinuxCloudflared.UnitPath)));
    }

    [Fact]
    public async Task Inspecting_reads_the_version_and_whether_the_unit_runs()
    {
        using var root = Ubuntu();
        root.Write(LinuxCloudflared.Binary, "#!/bin/sh");
        var processes = new FakeProcessRunner();
        processes.Respond("cloudflared", ["--version"], _ => FakeProcessRunner.Ok("cloudflared version 2025.10.1 (built 2025-10-23-1200 UTC)\n"));
        processes.Respond("systemctl", ["is-active"], _ => FakeProcessRunner.Ok("active\n"));

        var state = await Setup(root, processes, new Keys(string.Empty)).InspectAsync(Cancel);

        Assert.True(state.Installed);
        Assert.Equal("2025.10.1", state.Version);
        Assert.True(state.Running);
    }

    [Fact]
    public void The_pinned_fingerprint_is_the_one_in_the_published_key()
    {
        Assert.True(OpenPgpKey.HasOnly(Key("cloudflared"), CloudflareRepositories.CloudflaredFingerprint));
        Assert.True(OpenPgpKey.HasOnly(Key("warp"), CloudflareRepositories.WarpFingerprint));
    }
}
