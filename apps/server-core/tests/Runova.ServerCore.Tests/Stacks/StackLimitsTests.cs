using System.Net;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Security;
using Runova.ServerCore.Stacks;

namespace Runova.ServerCore.Tests.Stacks;

/// <summary>
/// Resource caps on an app's services: written into the override file the core passes to
/// docker compose, kept with each revision so redeploys, rollbacks and App Store updates hold
/// them, checked against what the server has, and for containers outside an app, set live.
/// </summary>
public sealed class StackLimitsTests
{
    private static CancellationToken Cancel => StackKit.Cancel;

    private static InMemoryDockerEngine Engine(StackKit kit) => kit.Harness.Services.GetRequiredService<InMemoryDockerEngine>();

    private static ContainerSummary Web(StackKit kit) =>
        Engine(kit).ListContainersAsync(Cancel).Result.Select(c => c.Summary).Single(c => c.ComposeProject == "site");

    private static Task<ContainerDetails> InspectWebAsync(StackKit kit) =>
        kit.Hub.InvokeAsync<ContainerDetails>(nameof(ICoreHub.InspectContainer), Web(kit).Id, Cancel);

    private static Task<StackRevisionFiles> FilesAsync(StackKit kit, Guid stackId, int number) =>
        kit.Hub.InvokeAsync<StackRevisionFiles>(nameof(ICoreHub.GetStackRevisionFiles), new StackRevisionRef(stackId, number), Cancel);

    private static StackRevisionUpload WithLimits(params StackServiceLimits[] limits) =>
        StackKit.Upload() with { Limits = limits };

    [Fact]
    public async Task Caps_in_an_upload_reach_the_override_and_the_running_container()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await kit.CreateStackAsync();

        var revision = await kit.UploadAsync(stack.Id, WithLimits(new StackServiceLimits("web", CpuCores: 2, CpuPercent: 50, MemoryMb: 512)));
        await kit.RunAsync(await kit.DeployAsync(stack.Id, 1));
        var files = await FilesAsync(kit, stack.Id, 1);
        var details = await InspectWebAsync(kit);

        Assert.Equal(StackRevisionState.Ready, revision.State);
        var saved = Assert.Single(revision.Limits!);
        Assert.Equal(new StackServiceLimits("web", 2, 50, 512), saved);
        Assert.Contains("    cpus: 1\n", files.Override, StringComparison.Ordinal);
        Assert.Contains("    mem_limit: \"512m\"\n", files.Override, StringComparison.Ordinal);
        Assert.Contains("    memswap_limit: \"512m\"\n", files.Override, StringComparison.Ordinal);
        Assert.Contains("        limits:\n          cpus: \"1\"\n          memory: \"512m\"\n", files.Override, StringComparison.Ordinal);
        // The proxied port still goes to loopback in the same file.
        Assert.Contains("ports: !override", files.Override, StringComparison.Ordinal);
        Assert.Equal(512L * 1024 * 1024, details.MemoryLimitBytes);
        Assert.Equal(1.0, details.CpuLimit);
    }

    [Fact]
    public async Task Caps_without_a_proxied_service_still_get_an_override()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await kit.CreateStackAsync();

        await kit.UploadAsync(stack.Id, StackKit.Upload(proxied: [], acknowledged: ["public-port:web:*:8080:80/tcp"]) with
        {
            Limits = [new StackServiceLimits("web", CpuCores: 1, CpuPercent: 25)],
        });
        var files = await FilesAsync(kit, stack.Id, 1);

        Assert.Contains("    cpus: 0.25\n", files.Override, StringComparison.Ordinal);
        Assert.DoesNotContain("ports: !override", files.Override, StringComparison.Ordinal);
    }

    [Fact]
    public async Task New_caps_are_a_revision_and_redeploying_it_replaces_the_container()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await kit.CreateStackAsync();
        await kit.UploadAsync(stack.Id, StackKit.Upload());
        await kit.RunAsync(await kit.DeployAsync(stack.Id, 1));
        Assert.Null((await InspectWebAsync(kit)).MemoryLimitBytes);

        var revision = await kit.Hub.InvokeAsync<StackRevisionInfo>(
            nameof(ICoreHub.ReviseStack),
            new ReviseStackRequest(stack.Id, 1, ["web"], Purpose: StackRevisionPurpose.Limits, Limits: [new StackServiceLimits("web", MemoryMb: 256)]),
            Cancel);
        await kit.RunAsync(await kit.DeployAsync(stack.Id, revision.Number));

        Assert.Equal(256L * 1024 * 1024, (await InspectWebAsync(kit)).MemoryLimitBytes);
        Assert.Contains(await kit.AuditAsync(), e => e.Action == "stack.revise" && e.Parameters!.Contains("limits", StringComparison.Ordinal));

        // Rolling back puts the old, uncapped revision back.
        await kit.RunAsync(await kit.Hub.InvokeAsync<JobInfo>(nameof(ICoreHub.RollbackStack), new StackRevisionRef(stack.Id, 1), Cancel));
        Assert.Null((await InspectWebAsync(kit)).MemoryLimitBytes);
    }

    [Fact]
    public async Task A_revision_that_does_not_name_caps_keeps_the_ones_it_came_from()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await kit.CreateStackAsync();
        await kit.UploadAsync(stack.Id, WithLimits(new StackServiceLimits("web", MemoryMb: 300)));
        var newer = StackKit.Compose.Replace("nginx:1.29", "nginx:1.30", StringComparison.Ordinal);

        var update = await kit.Hub.InvokeAsync<StackRevisionInfo>(
            nameof(ICoreHub.ReviseStack),
            new ReviseStackRequest(stack.Id, 1, ["web"], newer, Purpose: StackRevisionPurpose.Update),
            Cancel);
        var files = await FilesAsync(kit, stack.Id, update.Number);

        Assert.Equal([new StackServiceLimits("web", MemoryMb: 300)], update.Limits!);
        Assert.Contains("mem_limit: \"300m\"", files.Override, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Caps_can_all_be_lifted()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await kit.CreateStackAsync();
        await kit.UploadAsync(stack.Id, WithLimits(new StackServiceLimits("web", MemoryMb: 300)));

        var lifted = await kit.Hub.InvokeAsync<StackRevisionInfo>(
            nameof(ICoreHub.ReviseStack),
            new ReviseStackRequest(stack.Id, 1, ["web"], Purpose: StackRevisionPurpose.Limits, Limits: []),
            Cancel);
        var files = await FilesAsync(kit, stack.Id, lifted.Number);

        Assert.Empty(lifted.Limits!);
        Assert.DoesNotContain("mem_limit", files.Override, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("web", 0, null, null, null)]
    [InlineData("web", null, 4, null, null)]
    [InlineData("web", null, 101, null, null)]
    [InlineData("web", null, null, 5, null)]
    [InlineData("web", null, null, null, 0)]
    [InlineData("bad name!", null, null, 64, null)]
    public async Task An_upload_with_caps_out_of_shape_is_refused(string service, int? cores, int? percent, int? memory, int? disk)
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await kit.CreateStackAsync();

        using var response = await kit.PostRevisionAsync(stack.Id, WithLimits(new StackServiceLimits(service, cores, percent, memory, disk)));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Caps_for_a_service_the_app_lacks_or_beyond_the_server_make_the_revision_invalid()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await kit.CreateStackAsync();

        var missing = await kit.UploadAsync(stack.Id, WithLimits(new StackServiceLimits("db", MemoryMb: 64)));
        var cores = await kit.UploadAsync(stack.Id, WithLimits(new StackServiceLimits("web", CpuCores: 64)));
        var memory = await kit.UploadAsync(stack.Id, WithLimits(new StackServiceLimits("web", MemoryMb: 64 * 1024 * 1024)));

        Assert.Equal(StackRevisionState.Invalid, missing.State);
        Assert.Contains("db", missing.Error, StringComparison.Ordinal);
        Assert.Equal(StackRevisionState.Invalid, cores.State);
        Assert.Contains("4 cores", cores.Error, StringComparison.Ordinal);
        Assert.Equal(StackRevisionState.Invalid, memory.State);
        Assert.Contains("memory", memory.Error, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_disk_cap_needs_a_storage_driver_that_can_apply_it()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await kit.CreateStackAsync();

        var refused = await kit.UploadAsync(stack.Id, WithLimits(new StackServiceLimits("web", DiskGb: 10)));
        Engine(kit).Info = Engine(kit).Info with { StorageDriver = "overlay2", BackingFilesystem = "xfs" };
        var accepted = await kit.UploadAsync(stack.Id, WithLimits(new StackServiceLimits("web", DiskGb: 10)));
        var files = await FilesAsync(kit, stack.Id, accepted.Number);

        Assert.Equal(StackRevisionState.Invalid, refused.State);
        Assert.Contains("disk", refused.Error, StringComparison.Ordinal);
        Assert.Equal(StackRevisionState.Ready, accepted.State);
        Assert.Contains("    storage_opt:\n      size: \"10G\"\n", files.Override, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("overlay2", "xfs", true)]
    [InlineData("overlay2", "extfs", false)]
    [InlineData("btrfs", null, true)]
    [InlineData("zfs", null, true)]
    [InlineData("overlayfs", null, false)]
    [InlineData(null, null, false)]
    public void Disk_caps_follow_the_storage_driver(string? driver, string? backing, bool supported)
    {
        var support = ResourceLimits.DiskSupport(new EngineInfo(driver, 2, 8, 16L << 30, backing));

        Assert.Equal(supported, support.Supported);
        Assert.Equal(supported, support.Note is null);
    }

    [Fact]
    public async Task The_engine_status_says_what_the_server_can_give()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Viewer);

        var status = await kit.Hub.InvokeAsync<DockerStatus>(nameof(ICoreHub.GetDockerStatus), Cancel);

        Assert.Equal(4, status.Cpus);
        Assert.Equal(8L << 30, status.MemoryBytes);
        Assert.False(status.DiskLimits);
        Assert.Contains("disk", status.DiskLimitNote, StringComparison.Ordinal);
    }

    [Fact]
    public async Task An_operator_caps_a_container_outside_any_app_live()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);

        var details = await kit.Hub.InvokeAsync<ContainerDetails>(
            nameof(ICoreHub.UpdateContainerLimits),
            new ContainerLimitsRequest("toolbox", Cpus: 0.5, MemoryMb: 128),
            Cancel);

        Assert.Equal(0.5, details.CpuLimit);
        Assert.Equal(128L * 1024 * 1024, details.MemoryLimitBytes);
        Assert.Contains("update-limits toolbox", Engine(kit).Changes);
        Assert.Contains(await kit.AuditAsync(), e => e.Action == "container.limits" && e.Result == "success" && e.Target == "toolbox");
    }

    [Theory]
    [InlineData(0.001, null)]
    [InlineData(65.0, null)]
    [InlineData(null, 5)]
    public async Task Live_caps_out_of_range_are_refused(double? cpus, int? memory)
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);

        await Assert.ThrowsAsync<HubException>(() => kit.Hub.InvokeAsync<ContainerDetails>(
            nameof(ICoreHub.UpdateContainerLimits),
            new ContainerLimitsRequest("toolbox", cpus, memory),
            Cancel));
        Assert.Contains(await kit.AuditAsync(), e => e.Action == "container.limits" && e.Result == "denied");
    }

    [Fact]
    public async Task Live_caps_are_refused_for_a_container_an_app_owns()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await kit.CreateStackAsync();
        await kit.UploadAsync(stack.Id, StackKit.Upload());
        await kit.RunAsync(await kit.DeployAsync(stack.Id, 1));

        var refused = await Assert.ThrowsAsync<HubException>(() => kit.Hub.InvokeAsync<ContainerDetails>(
            nameof(ICoreHub.UpdateContainerLimits),
            new ContainerLimitsRequest(Web(kit).Name, Cpus: 1),
            Cancel));

        Assert.Contains("app's page", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_viewer_cannot_cap_a_container()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Viewer);

        await Assert.ThrowsAsync<HubException>(() => kit.Hub.InvokeAsync<ContainerDetails>(
            nameof(ICoreHub.UpdateContainerLimits),
            new ContainerLimitsRequest("toolbox", Cpus: 1, MemoryMb: null),
            Cancel));
    }
}
