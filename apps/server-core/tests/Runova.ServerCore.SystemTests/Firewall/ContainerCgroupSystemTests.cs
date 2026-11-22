using System.Globalization;
using Runova.ServerCore.Firewall;
using Runova.ServerCore.SystemTests.Nginx;

namespace Runova.ServerCore.SystemTests.Firewall;

/// <summary>
/// Real Docker for how the core ties a listening program to its container: it reads the
/// program's /proc/&lt;pid&gt;/cgroup and takes the container id from it. A container on the host
/// network publishes no ports, so this is the only way the New App wizard can name it when it
/// already holds a port the app wants. The cgroup path depends on the engine, its cgroup driver
/// and the cgroup version, so it is read here from the engine that runs the tests rather than
/// trusted from a fixture.
/// </summary>
/// <remarks>
/// The core runs on the host and sees the host's process table. These tests may run in a
/// container (the CI job container has its own pid namespace), so they read the file through a
/// helper container that shares the host's pid and cgroup namespaces, which gives the same view.
/// With Docker Desktop that is the view inside its Linux VM, so they run there too.
/// </remarks>
public sealed class ContainerCgroupSystemTests
{
    private const string Alpine = "alpine:3.22";

    private static readonly TimeSpan _minute = TimeSpan.FromMinutes(1);

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    [Theory]
    [InlineData("bridge")]
    [InlineData("host")]
    public async Task A_program_in_a_container_is_tied_to_that_container(string network)
    {
        DockerCli.RequireAvailable();
        await DockerCli.CheckedAsync(["pull", "-q", Alpine], TimeSpan.FromMinutes(5), Cancel);
        var name = $"runova-cgroup-{Guid.NewGuid():N}"[..26];
        try
        {
            var id = (await DockerCli.CheckedAsync(["run", "-d", "--name", name, "--network", network, Alpine, "sleep", "600"], _minute, Cancel)).Trim();
            var pid = int.Parse((await DockerCli.CheckedAsync(["inspect", "-f", "{{.State.Pid}}", name], _minute, Cancel)).Trim(), CultureInfo.InvariantCulture);
            Assert.True(pid > 0, $"{name} has no pid on the host.");

            var cgroup = await HostFileAsync($"/proc/{pid.ToString(CultureInfo.InvariantCulture)}/cgroup");

            Assert.True(ProcNet.ContainerId(cgroup) == id, $"Expected {id} from this cgroup file:\n{cgroup}");
        }
        finally
        {
            await DockerCli.RunAsync(["rm", "-f", name], _minute, CancellationToken.None);
        }
    }

    [Fact]
    public async Task The_hosts_own_programs_belong_to_no_container()
    {
        DockerCli.RequireAvailable();
        await DockerCli.CheckedAsync(["pull", "-q", Alpine], TimeSpan.FromMinutes(5), Cancel);

        var cgroup = await HostFileAsync("/proc/1/cgroup");

        Assert.True(ProcNet.ContainerId(cgroup) is null, $"The host's init came out as a container from:\n{cgroup}");
    }

    /// <summary>A file of the host's /proc, read the way the core on the host reads it.</summary>
    private static Task<string> HostFileAsync(string path) =>
        DockerCli.CheckedAsync(["run", "--rm", "--pid", "host", "--cgroupns", "host", Alpine, "cat", path], _minute, Cancel);
}
