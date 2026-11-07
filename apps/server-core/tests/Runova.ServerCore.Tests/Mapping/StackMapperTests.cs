using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Stacks;

namespace Runova.ServerCore.Tests.Mapping;

public sealed class StackMapperTests
{
    [Fact]
    public void An_app_takes_its_status_and_counts_from_the_caller()
    {
        var id = Guid.NewGuid();
        var job = Guid.NewGuid();
        var stack = new StackRecord
        {
            Id = id,
            Name = "shop",
            Description = "The shop",
            ProjectId = "p1",
            ProjectName = "Shop",
            ComposePath = "deploy/compose.yaml",
            CreatedAt = 1,
            UpdatedAt = 2,
            LiveRevision = 3,
            LastRevision = 4,
        };

        var info = StackMapper.ToInfo(stack, StackStatus.Degraded, 4, 1, 2, job);

        Assert.Equal(
            new StackInfo(id, "shop", StackStatus.Degraded, 1, 2, 4, 3, "The shop", new StackSource("p1", "Shop", "deploy/compose.yaml"), 1, 2, job),
            info);
    }

    [Fact]
    public void An_app_made_without_a_project_has_no_source()
    {
        var info = StackMapper.ToInfo(new StackRecord { Name = "shop" }, StackStatus.New, 0, 0, 0, null);

        Assert.Null(info.Source);
        Assert.Null(info.ActiveJobId);
    }

    [Fact]
    public void A_revision_reads_its_json_columns_back_and_lists_what_still_needs_an_acknowledgment()
    {
        var stackId = Guid.NewGuid();
        var job = Guid.NewGuid();
        StackRisk[] findings =
        [
            new("privileged:web:web", "privileged", StackRiskSeverity.High, "Runs privileged.", "web"),
            new("port:db:5432", "port", StackRiskSeverity.Critical, "Published to everyone.", "db"),
            new("latest:web:web", "latest", StackRiskSeverity.Low, "Uses latest.", "web"),
        ];
        StackDeployStep[] steps = [new(StackStepKind.Pull, StackStepState.Succeeded, 1, 2, 3, 4, "pulled")];
        StackPortBinding[] bindings = [new("web", 80, "tcp", "127.0.0.1", "8080")];
        StackServiceLimits[] limits = [new("web", CpuCores: 2, MemoryMb: 512)];
        var row = new StackRevisionRecord
        {
            StackId = stackId,
            Number = 5,
            State = nameof(StackRevisionState.Live),
            CreatedAt = 10,
            CreatedBy = "alice",
            ComposeSha256 = "sha",
            EnvKeys = StackOperations.Write<string[]>(["TOKEN"]),
            Services = StackOperations.Write<string[]>(["web", "db"]),
            ProxiedServices = StackOperations.Write<string[]>(["web"]),
            Limits = StackOperations.Write(limits),
            Networks = StackOperations.Write<StackServiceNetworks[]>([new("web", ["shop_default", "shared"])]),
            Findings = StackOperations.Write(findings),
            AcknowledgedRisks = StackOperations.Write<string[]>(["privileged:web:web"]),
            Bindings = StackOperations.Write(bindings),
            Steps = StackOperations.Write(steps),
            HasBuildContext = true,
            JobId = job,
            DeployedAt = 11,
            FinishedAt = 12,
            RollbackOf = 4,
            Error = "half done",
            EnvironmentId = "e1",
            EnvironmentName = "Production",
        };

        var info = StackMapper.ToInfo(row);

        Assert.Equal(stackId, info.StackId);
        Assert.Equal(5, info.Number);
        Assert.Equal(StackRevisionState.Live, info.State);
        Assert.Equal(10, info.CreatedAtUnixMs);
        Assert.Equal("sha", info.ComposeSha256);
        Assert.Equal(["TOKEN"], info.EnvKeys);
        Assert.Equal(["web", "db"], info.Services);
        Assert.Equal(["web"], info.ProxiedServices);
        Assert.True(info.HasBuildContext);
        Assert.Equal(steps, info.Steps);
        Assert.Equal(findings, info.Findings);
        Assert.Equal(["privileged:web:web"], info.AcknowledgedRisks);
        Assert.Equal(["port:db:5432"], info.UnacknowledgedRisks);
        Assert.Equal(bindings, info.Bindings);
        Assert.Equal("alice", info.CreatedBy);
        Assert.Equal(job, info.JobId);
        Assert.Equal(11, info.DeployedAtUnixMs);
        Assert.Equal(12, info.FinishedAtUnixMs);
        Assert.Equal(4, info.RollbackOf);
        Assert.Equal("half done", info.Error);
        Assert.Equal(new StackSource(EnvironmentId: "e1", EnvironmentName: "Production"), info.Source);
        Assert.Equal(limits, info.Limits);
        var joined = Assert.Single(info.Networks!);
        Assert.Equal("web", joined.Service);
        Assert.Equal(["shop_default", "shared"], joined.Networks);
    }
}
