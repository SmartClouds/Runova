using Runova.ServerCore.Cloudflare;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Platform;

namespace Runova.ServerCore.Tests.Cloudflare;

/// <summary>
/// E95 T8: the server as a Cloudflare Mesh node. The Cloudflare One client comes from Cloudflare's
/// own signed repository (the key checked against its pinned fingerprint), the node is registered
/// with the token the app made and connected, and the core reads the Mesh address it was given.
/// </summary>
public sealed class CloudflareMeshSetupTests
{
    private static readonly string[] _aptOptions =
    [
        "-q", "-y", "-o", "DPkg::Lock::Timeout=300", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold",
    ];

    private static readonly Guid _node = Guid.Parse("0b7c1e0a-3f43-4d4e-9d6b-1f5a52c6a0d1");

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private sealed class Keys(string key) : IRepositoryKeys
    {
        public List<Uri> Fetched { get; } = [];

        public Task<string> FetchAsync(Uri url, CancellationToken cancellationToken)
        {
            Fetched.Add(url);
            return Task.FromResult(key);
        }
    }

    private static string Key(string name) => Fixtures.Read($"cloudflare/keys/{name}.asc");

    private static OsInfo Os(TestRoot root) => OsRelease.Describe(OsRelease.Parse(root.Files.ReadText(OsRelease.Path)!));

    private static TestRoot Ubuntu()
    {
        var root = new TestRoot("ubuntu-24.04");
        root.Write("/etc/apt/keyrings/.keep", string.Empty);
        root.Write("/etc/apt/sources.list.d/.keep", string.Empty);
        return root;
    }

    private static FakeProcessRunner Processes(string address = "100.96.0.12")
    {
        var processes = new FakeProcessRunner();
        processes.Respond("ip", ["-4", "-o", "addr", "show", "dev", "CloudflareWARP"], _ =>
            FakeProcessRunner.Ok($"7: CloudflareWARP    inet {address}/32 scope global CloudflareWARP\\       valid_lft forever preferred_lft forever\n"));
        return processes;
    }

    private static LinuxCloudflareMesh Mesh(TestRoot root, FakeProcessRunner processes, IRepositoryKeys keys) =>
        new(processes, Units.Runner(processes), root.Files, Os(root), keys, TimeProvider.System);

    [Fact]
    public async Task On_ubuntu_it_installs_the_client_from_cloudflare_registers_the_node_and_reads_its_mesh_address()
    {
        using var root = Ubuntu();
        var processes = Processes();
        var keys = new Keys(Key("warp"));
        using var job = new TestJob(JobKind.CloudflareMeshSetup);

        var address = await Mesh(root, processes, keys).JoinAsync(CloudflaredSetupTests.Token(_node), job.Context, Cancel);

        Assert.Equal("100.96.0.12", address);
        Assert.Equal([CloudflareRepositories.WarpKeyUrl], keys.Fetched);
        var source = File.ReadAllText(root.Resolve(CloudflareRepositories.WarpAptSource));
        Assert.Contains("URIs: https://pkg.cloudflareclient.com/\n", source, StringComparison.Ordinal);
        Assert.Contains("Suites: noble\n", source, StringComparison.Ordinal);
        Assert.Contains($"Signed-By: {CloudflareRepositories.WarpAptKeyring}\n", source, StringComparison.Ordinal);
        Assert.Equal(
            [
                ["/usr/bin/apt-get", .. _aptOptions, "update"],
                ["/usr/bin/apt-get", .. _aptOptions, "install", "cloudflare-warp"],
            ],
            processes.Calls.Where(Units.IsUnitRun).Select(Units.Command).ToList());
        var warp = processes.Calls.Where(spec => FakeProcessRunner.Is(spec, "warp-cli")).Select(spec => string.Join(' ', spec.Arguments)).ToList();
        Assert.Equal(["--accept-tos connector new " + CloudflaredSetupTests.Token(_node), "--accept-tos connect"], warp);
        var log = string.Join('\n', (await job.LinesAsync()).Select(line => line.Text));
        Assert.DoesNotContain(CloudflaredSetupTests.Token(_node), log, StringComparison.Ordinal);
        Assert.Contains(CloudflareRepositories.WarpFingerprint, log, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_key_that_is_not_cloudflare_s_stops_before_anything_changes()
    {
        using var root = Ubuntu();
        var processes = Processes();
        using var job = new TestJob(JobKind.CloudflareMeshSetup);

        var refusal = await Assert.ThrowsAsync<JobFailedException>(() =>
            Mesh(root, processes, new Keys(Key("cloudflared"))).JoinAsync(CloudflaredSetupTests.Token(_node), job.Context, Cancel));

        Assert.Contains("is not Cloudflare's", refusal.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(processes.Calls, spec => FakeProcessRunner.Is(spec, "warp-cli"));
    }

    [Fact]
    public async Task A_registration_cloudflare_refuses_fails_the_job_without_repeating_the_token()
    {
        using var root = Ubuntu();
        root.Write(LinuxCloudflareMesh.Binary, "#!/bin/sh");
        var processes = Processes();
        processes.Respond("warp-cli", ["--accept-tos", "connector"], _ => FakeProcessRunner.Exit(1, error: "Error: invalid token " + CloudflaredSetupTests.Token(_node)));
        using var job = new TestJob(JobKind.CloudflareMeshSetup);

        var refusal = await Assert.ThrowsAsync<JobFailedException>(() =>
            Mesh(root, processes, new Keys(string.Empty)).JoinAsync(CloudflaredSetupTests.Token(_node), job.Context, Cancel));

        Assert.Contains("did not register", refusal.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(CloudflaredSetupTests.Token(_node), refusal.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("100.96.0.12", true)]
    [InlineData("100.111.255.1", true)]
    [InlineData("100.112.0.1", false)]
    [InlineData("10.0.0.5", false)]
    public void Only_an_address_in_the_mesh_range_counts(string address, bool mesh)
    {
        var output = $"7: CloudflareWARP    inet {address}/32 scope global CloudflareWARP\n";

        Assert.Equal(mesh ? address : null, LinuxCloudflareMesh.ParseAddress(output));
    }
}
