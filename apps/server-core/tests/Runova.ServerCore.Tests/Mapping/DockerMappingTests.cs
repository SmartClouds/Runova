using Docker.DotNet.Models;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Docker;
using VolumeInfo = Runova.ServerCore.Contracts.VolumeInfo;

namespace Runova.ServerCore.Tests.Mapping;

/// <summary>The engine's list and info responses as the core's own types.</summary>
public sealed class DockerMappingTests
{
    [Fact]
    public void An_image_loses_the_placeholders_of_an_untagged_one()
    {
        var created = new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc);
        var image = new ImagesListResponse
        {
            ID = "sha256:1",
            RepoTags = ["<none>:<none>", "shop:2"],
            RepoDigests = ["<none>@<none>", "shop@sha256:3"],
            Created = created,
            Size = 4_096,
        };

        var info = DockerMapping.ToInfo(image, 2);

        Assert.Equal("sha256:1", info.Id);
        Assert.Equal(["shop:2"], info.Tags);
        Assert.Equal(["shop@sha256:3"], info.Digests);
        Assert.Equal(new DateTimeOffset(created).ToUnixTimeMilliseconds(), info.CreatedAtUnixMs);
        Assert.Equal(4_096, info.SizeBytes);
        Assert.Equal(2, info.Containers);
        Assert.Empty(DockerMapping.ToInfo(new ImagesListResponse { ID = "sha256:4" }, 0).Tags);
    }

    [Fact]
    public void A_volume_has_a_size_only_when_the_engine_measured_it()
    {
        var volume = new VolumeResponse
        {
            Name = "shop_data",
            Driver = "nfs",
            Mountpoint = "/var/lib/docker/volumes/shop_data/_data",
            CreatedAt = "2026-01-02T03:04:05Z",
            UsageData = new UsageData { Size = 2_048 },
            Labels = new Dictionary<string, string> { [DockerMapping.ProjectLabel] = "shop" },
        };

        var info = DockerMapping.ToInfo(volume, 1);

        Assert.Equal(
            new VolumeInfo("shop_data", "nfs", "/var/lib/docker/volumes/shop_data/_data", 1, DockerTime.ToUnixMs("2026-01-02T03:04:05Z"), 2_048, "shop"),
            info);
        Assert.NotNull(info.CreatedAtUnixMs);

        var bare = DockerMapping.ToInfo(new VolumeResponse { Name = "x", Driver = null!, Mountpoint = null!, UsageData = new UsageData { Size = -1 } }, 0);
        Assert.Equal(new VolumeInfo("x", "local", string.Empty, 0), bare);
    }

    [Fact]
    public void A_network_knows_the_three_docker_makes_itself()
    {
        var network = new NetworkResponse
        {
            ID = "n1",
            Name = "bridge",
            Driver = "bridge",
            Scope = "swarm",
            Internal = true,
            IPAM = new IPAM { Config = [new IPAMConfig { Subnet = "172.17.0.0/16" }, new IPAMConfig { Subnet = string.Empty }] },
            Labels = new Dictionary<string, string> { [DockerMapping.ProjectLabel] = "shop" },
        };

        Assert.Equal(
            "n1|bridge|bridge|swarm|True|True|172.17.0.0/16|3|shop",
            Flat(DockerMapping.ToInfo(network, 3)));
        Assert.Equal(
            "n2|shop_default||local|False|False||0|",
            Flat(DockerMapping.ToInfo(new NetworkResponse { ID = "n2", Name = "shop_default", Driver = null!, Scope = null! }, 0)));
    }

    [Fact]
    public void The_engine_info_keeps_only_what_the_engine_gave()
    {
        var info = new SystemInfoResponse
        {
            Driver = "overlay2",
            CgroupVersion = "2",
            NCPU = 4,
            MemTotal = 8_000_000_000,
            DriverStatus = [["Backing Filesystem", "extfs"], ["Supports d_type", "true"]],
        };

        Assert.Equal(new EngineInfo("overlay2", 2, 4, 8_000_000_000, "extfs"), DockerMapping.ToInfo(info));
        Assert.Equal(new EngineInfo(null, null), DockerMapping.ToInfo(new SystemInfoResponse { Driver = string.Empty, CgroupVersion = "v?", DriverStatus = [["Backing Filesystem", string.Empty]] }));
    }

    [Fact]
    public void Pull_progress_and_environment_variables_copy_across()
    {
        var progress = DockerMapping.ToProgress(new JSONMessage
        {
            ID = "layer1",
            Status = "Downloading",
            Progress = new JSONProgress { Current = 10, Total = 20 },
            Error = new JSONError { Message = "denied" },
        });

        Assert.Equal(new PullProgress("layer1", "Downloading", 10, 20, "denied"), progress);
        Assert.Equal(new PullProgress(null, "Pulling fs layer", null, null, null), DockerMapping.ToProgress(new JSONMessage { Status = "Pulling fs layer" }));
        Assert.Equal(new ContainerEnvVariable("TOKEN", "abc"), DockerMapping.ToVariable(new KeyValuePair<string, string>("TOKEN", "abc")));
    }

    private static string Flat(NetworkInfo info) =>
        string.Join('|', info.Id, info.Name, info.Driver, info.Scope, info.Internal, info.BuiltIn, string.Join(',', info.Subnets), info.Containers, info.ComposeProject);
}
