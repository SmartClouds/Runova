using Runova.ServerCore.Backups;
using Runova.ServerCore.Tests.Docker;

namespace Runova.ServerCore.Tests.Backups;

/// <summary>
/// The backup engine's Docker client against the fake daemon. The rest of it needs a real Docker
/// (DockerBackupEngineSystemTests).
/// </summary>
public sealed class DockerBackupEngineTests
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    [Fact]
    public async Task A_container_gone_between_the_list_and_its_inspect_is_left_out()
    {
        // A nightly run failed on this: another job on the same Docker removed one of its
        // containers while the backup was reading them.
        await using var daemon = await FakeDockerDaemon.StartAsync();
        daemon.Remove("toolbox");
        using var engine = new DockerBackupEngine(daemon.Endpoint);

        var containers = await engine.ListContainersAsync(Cancel);

        Assert.Equal(["migrate-once", "shop-api-1", "shop-worker-1"], containers.Select(c => c.Name).Order(StringComparer.Ordinal));
    }
}
