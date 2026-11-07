using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Security;
using Runova.ServerCore.Stacks;

namespace Runova.ServerCore.Tests.Stacks;

/// <summary>
/// Networks an app's service joins besides its own: written into the override file as external
/// networks, kept with each revision so redeploys, rollbacks and App Store updates hold them, and
/// checked against the networks the server has.
/// </summary>
public sealed class StackNetworksTests
{
    private static CancellationToken Cancel => StackKit.Cancel;

    private const string WithAgent = """
        services:
          web:
            image: nginx:1.29
            restart: unless-stopped
            environment:
              DB_PASSWORD: ${DB_PASSWORD}
            ports:
              - "8080:80"
          agent:
            image: busybox:1.37
            network_mode: host
        """;

    private static InMemoryDockerEngine Engine(StackKit kit) => kit.Harness.Services.GetRequiredService<InMemoryDockerEngine>();

    private static ContainerSummary Web(StackKit kit) =>
        Engine(kit).ListContainersAsync(Cancel).Result.Select(c => c.Summary).Single(c => c.ComposeProject == "site" && c.ComposeService == "web");

    private static async Task<string[]> WebNetworksAsync(StackKit kit) =>
        [.. (await kit.Hub.InvokeAsync<ContainerDetails>(nameof(ICoreHub.InspectContainer), Web(kit).Id, Cancel)).Networks.Select(n => n.Network).Order(StringComparer.Ordinal)];

    private static Task<StackRevisionFiles> FilesAsync(StackKit kit, Guid stackId, int number) =>
        kit.Hub.InvokeAsync<StackRevisionFiles>(nameof(ICoreHub.GetStackRevisionFiles), new StackRevisionRef(stackId, number), Cancel);

    private static Task<StackRevisionInfo> JoinAsync(StackKit kit, Guid stackId, int from, params StackServiceNetworks[] networks) =>
        kit.Hub.InvokeAsync<StackRevisionInfo>(
            nameof(ICoreHub.ReviseStack),
            new ReviseStackRequest(stackId, from, ["web"], Purpose: StackRevisionPurpose.Networks, Networks: networks),
            Cancel);

    private static async Task<(StackKit Kit, StackInfo Stack)> DeployedAsync()
    {
        var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await kit.CreateStackAsync();
        await kit.UploadAsync(stack.Id, StackKit.Upload());
        await kit.RunAsync(await kit.DeployAsync(stack.Id, 1));
        return (kit, stack);
    }

    [Fact]
    public async Task Joining_a_network_is_a_revision_and_the_redeployed_container_is_on_it()
    {
        var (kit, stack) = await DeployedAsync();
        await using var owned = kit;
        Assert.Equal(["site_default"], await WebNetworksAsync(kit));

        var revision = await JoinAsync(kit, stack.Id, 1, new StackServiceNetworks("web", ["shop_default"]));
        var (job, _) = await kit.RunAsync(await kit.DeployAsync(stack.Id, revision.Number));
        var files = await FilesAsync(kit, stack.Id, revision.Number);

        Assert.Equal(JobState.Succeeded, job.State);
        Assert.Equal(StackRevisionState.Live, (await kit.GetAsync(stack.Id)).Revisions.Single(r => r.Number == revision.Number).State);
        Assert.Equal([new StackServiceNetworks("web", ["shop_default"])], revision.Networks!, new NetworksComparer());
        Assert.Equal(["shop_default", "site_default"], await WebNetworksAsync(kit));
        // The service keeps its own network next to the joined one.
        Assert.Contains("    networks:\n      default: {}\n      runova-joined-shop_default: {}\n", files.Override, StringComparison.Ordinal);
        Assert.Contains("networks:\n  runova-joined-shop_default:\n    name: \"shop_default\"\n    external: true\n", files.Override, StringComparison.Ordinal);
        // The proxied port still goes to loopback in the same file.
        Assert.Contains("ports: !override", files.Override, StringComparison.Ordinal);
        Assert.Contains(await kit.AuditAsync(), e => e.Action == "stack.revise" && e.Result == "success" && e.Parameters!.Contains("web=shop_default", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_revision_that_does_not_name_networks_keeps_the_ones_it_came_from()
    {
        var (kit, stack) = await DeployedAsync();
        await using var owned = kit;
        var joined = await JoinAsync(kit, stack.Id, 1, new StackServiceNetworks("web", ["shop_default"]));
        var newer = StackKit.Compose.Replace("nginx:1.29", "nginx:1.30", StringComparison.Ordinal);

        var update = await kit.Hub.InvokeAsync<StackRevisionInfo>(
            nameof(ICoreHub.ReviseStack),
            new ReviseStackRequest(stack.Id, joined.Number, ["web"], newer, Purpose: StackRevisionPurpose.Update),
            Cancel);
        var files = await FilesAsync(kit, stack.Id, update.Number);

        Assert.Equal([new StackServiceNetworks("web", ["shop_default"])], update.Networks!, new NetworksComparer());
        Assert.Contains("name: \"shop_default\"", files.Override, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_rollback_brings_back_the_networks_and_caps_of_the_revision_it_copies()
    {
        var (kit, stack) = await DeployedAsync();
        await using var owned = kit;
        var capped = await kit.Hub.InvokeAsync<StackRevisionInfo>(
            nameof(ICoreHub.ReviseStack),
            new ReviseStackRequest(stack.Id, 1, ["web"], Purpose: StackRevisionPurpose.Limits, Limits: [new StackServiceLimits("web", MemoryMb: 256)]),
            Cancel);
        var joined = await JoinAsync(kit, stack.Id, capped.Number, new StackServiceNetworks("web", ["shop_default"]));
        await kit.RunAsync(await kit.DeployAsync(stack.Id, joined.Number));
        var left = await JoinAsync(kit, stack.Id, joined.Number);
        await kit.RunAsync(await kit.DeployAsync(stack.Id, left.Number));
        Assert.Equal(["site_default"], await WebNetworksAsync(kit));

        await kit.RunAsync(await kit.Hub.InvokeAsync<JobInfo>(nameof(ICoreHub.RollbackStack), new StackRevisionRef(stack.Id, joined.Number), Cancel));
        var copy = (await kit.GetAsync(stack.Id)).Revisions[0];

        Assert.Equal(joined.Number, copy.RollbackOf);
        Assert.Equal([new StackServiceNetworks("web", ["shop_default"])], copy.Networks!, new NetworksComparer());
        Assert.Equal([new StackServiceLimits("web", MemoryMb: 256)], copy.Limits!);
        Assert.Equal(["shop_default", "site_default"], await WebNetworksAsync(kit));
    }

    [Fact]
    public async Task Leaving_every_joined_network_takes_the_container_off_them()
    {
        var (kit, stack) = await DeployedAsync();
        await using var owned = kit;
        var joined = await JoinAsync(kit, stack.Id, 1, new StackServiceNetworks("web", ["shop_default", "monitoring_default"]));
        await kit.RunAsync(await kit.DeployAsync(stack.Id, joined.Number));
        Assert.Equal(["monitoring_default", "shop_default", "site_default"], await WebNetworksAsync(kit));

        var left = await JoinAsync(kit, stack.Id, joined.Number);
        await kit.RunAsync(await kit.DeployAsync(stack.Id, left.Number));
        var files = await FilesAsync(kit, stack.Id, left.Number);

        Assert.Empty(left.Networks!);
        Assert.DoesNotContain("runova-joined", files.Override, StringComparison.Ordinal);
        Assert.Equal(["site_default"], await WebNetworksAsync(kit));
    }

    [Theory]
    [InlineData("web", "bad/name")]
    [InlineData("web", "")]
    [InlineData("web", "host")]
    [InlineData("web", "none")]
    [InlineData("web", "bridge")]
    [InlineData("bad name!", "shop_default")]
    public async Task Networks_out_of_shape_are_refused(string service, string network)
    {
        var (kit, stack) = await DeployedAsync();
        await using var owned = kit;

        await Assert.ThrowsAsync<HubException>(() => JoinAsync(kit, stack.Id, 1, new StackServiceNetworks(service, [network])));
        Assert.Contains(await kit.AuditAsync(), e => e.Action == "stack.revise" && e.Result == "denied");
    }

    [Fact]
    public async Task A_service_listed_twice_or_with_too_many_networks_is_refused()
    {
        var (kit, stack) = await DeployedAsync();
        await using var owned = kit;
        var many = Enumerable.Range(1, JoinedNetworks.MaxPerService + 1).Select(i => $"net{i}").ToArray();

        await Assert.ThrowsAsync<HubException>(() => JoinAsync(kit, stack.Id, 1, new StackServiceNetworks("web", ["shop_default"]), new StackServiceNetworks("web", ["monitoring_default"])));
        await Assert.ThrowsAsync<HubException>(() => JoinAsync(kit, stack.Id, 1, new StackServiceNetworks("web", many)));
    }

    [Fact]
    public async Task A_network_the_server_lacks_the_app_own_one_or_a_missing_service_make_the_revision_invalid()
    {
        var (kit, stack) = await DeployedAsync();
        await using var owned = kit;

        var missing = await JoinAsync(kit, stack.Id, 1, new StackServiceNetworks("web", ["ghost_default"]));
        var own = await JoinAsync(kit, stack.Id, 1, new StackServiceNetworks("web", ["site_default"]));
        var service = await JoinAsync(kit, stack.Id, 1, new StackServiceNetworks("db", ["shop_default"]));

        Assert.Equal(StackRevisionState.Invalid, missing.State);
        Assert.Contains("ghost_default", missing.Error, StringComparison.Ordinal);
        Assert.Equal(StackRevisionState.Invalid, own.State);
        Assert.Contains("already on its own network", own.Error, StringComparison.Ordinal);
        Assert.Equal(StackRevisionState.Invalid, service.State);
        Assert.Contains("no service called db", service.Error, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_service_with_its_own_network_mode_cannot_join_networks()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await kit.CreateStackAsync();
        await kit.UploadAsync(stack.Id, StackKit.Upload(WithAgent, acknowledged: ["host-network:agent"]));

        var revision = await JoinAsync(kit, stack.Id, 1, new StackServiceNetworks("agent", ["shop_default"]));

        Assert.Equal(StackRevisionState.Invalid, revision.State);
        Assert.Contains("network_mode: host", revision.Error, StringComparison.Ordinal);
    }

    [Fact]
    public void The_override_keeps_the_networks_a_service_already_has_and_adds_the_joined_ones()
    {
        using var config = ComposeConfig.Parse("""
            {"name":"site","services":{
              "web":{"image":"nginx","networks":{"front":null}},
              "db":{"image":"postgres"}}}
            """);

        var result = LoopbackOverride.Render(config, [], networks: [new StackServiceNetworks("web", ["shop_default"]), new StackServiceNetworks("db", ["shop_default", "monitoring_default"])]);

        Assert.NotNull(result.Text);
        // web names its networks already, so Compose merges the joined one into them.
        Assert.Contains("  \"web\":\n    networks:\n      runova-joined-shop_default: {}\n", result.Text, StringComparison.Ordinal);
        // db is on the default network only because it names none, so the override has to keep it.
        Assert.Contains("  \"db\":\n    networks:\n      default: {}\n      runova-joined-shop_default: {}\n      runova-joined-monitoring_default: {}\n", result.Text, StringComparison.Ordinal);
        Assert.EndsWith(
            "networks:\n  runova-joined-shop_default:\n    name: \"shop_default\"\n    external: true\n  runova-joined-monitoring_default:\n    name: \"monitoring_default\"\n    external: true\n",
            result.Text,
            StringComparison.Ordinal);
    }

    [Fact]
    public void No_override_is_written_for_services_that_join_nothing()
    {
        using var config = ComposeConfig.Parse("""{"services":{"worker":{"image":"busybox"}}}""");

        var result = LoopbackOverride.Render(config, [], networks: [new StackServiceNetworks("worker", [])]);

        Assert.Null(result.Text);
    }

    [Fact]
    public async Task A_viewer_cannot_join_a_network()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Viewer);

        await Assert.ThrowsAsync<HubException>(() => JoinAsync(kit, Guid.NewGuid(), 1, new StackServiceNetworks("web", ["shop_default"])));
    }

    private sealed class NetworksComparer : IEqualityComparer<StackServiceNetworks>
    {
        public bool Equals(StackServiceNetworks? x, StackServiceNetworks? y) =>
            x is not null && y is not null && x.Service == y.Service && x.Networks.SequenceEqual(y.Networks);

        public int GetHashCode(StackServiceNetworks obj) => obj.Service.GetHashCode(StringComparison.Ordinal);
    }
}
