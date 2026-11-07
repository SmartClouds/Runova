using Riok.Mapperly.Abstractions;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Stacks;

[Mapper]
internal static partial class StackMapper
{
    /// <summary>The status, counts and running job come from Docker and the job engine.</summary>
    [MapPropertyFromSource(nameof(StackInfo.Source), Use = nameof(StackSourceOf))]
    [MapProperty(nameof(StackRecord.CreatedAt), nameof(StackInfo.CreatedAtUnixMs))]
    [MapProperty(nameof(StackRecord.UpdatedAt), nameof(StackInfo.UpdatedAtUnixMs))]
    public static partial StackInfo ToInfo(
        StackRecord stack,
        StackStatus status,
        int revisionCount,
        int runningContainers,
        int containers,
        Guid? activeJobId);

    /// <summary>A revision with its JSON columns read back, and the findings still waiting for an acknowledgment.</summary>
    [MapProperty(nameof(StackRevisionRecord.State), nameof(StackRevisionInfo.State), Use = nameof(StateOf))]
    [MapProperty(nameof(StackRevisionRecord.CreatedAt), nameof(StackRevisionInfo.CreatedAtUnixMs))]
    [MapProperty(nameof(StackRevisionRecord.EnvKeys), nameof(StackRevisionInfo.EnvKeys), Use = nameof(ReadNames))]
    [MapProperty(nameof(StackRevisionRecord.Services), nameof(StackRevisionInfo.Services), Use = nameof(ReadNames))]
    [MapProperty(nameof(StackRevisionRecord.ProxiedServices), nameof(StackRevisionInfo.ProxiedServices), Use = nameof(ReadNames))]
    [MapProperty(nameof(StackRevisionRecord.Steps), nameof(StackRevisionInfo.Steps), Use = nameof(ReadSteps))]
    [MapProperty(nameof(StackRevisionRecord.Findings), nameof(StackRevisionInfo.Findings), Use = nameof(ReadFindings))]
    [MapProperty(nameof(StackRevisionRecord.AcknowledgedRisks), nameof(StackRevisionInfo.AcknowledgedRisks), Use = nameof(ReadNames))]
    [MapPropertyFromSource(nameof(StackRevisionInfo.UnacknowledgedRisks), Use = nameof(Unacknowledged))]
    [MapProperty(nameof(StackRevisionRecord.Bindings), nameof(StackRevisionInfo.Bindings), Use = nameof(ReadBindings))]
    [MapProperty(nameof(StackRevisionRecord.DeployedAt), nameof(StackRevisionInfo.DeployedAtUnixMs))]
    [MapProperty(nameof(StackRevisionRecord.FinishedAt), nameof(StackRevisionInfo.FinishedAtUnixMs))]
    [MapPropertyFromSource(nameof(StackRevisionInfo.Source), Use = nameof(RevisionSourceOf))]
    [MapProperty(nameof(StackRevisionRecord.Limits), nameof(StackRevisionInfo.Limits), Use = nameof(ReadLimits))]
    [MapProperty(nameof(StackRevisionRecord.Networks), nameof(StackRevisionInfo.Networks), Use = nameof(ReadNetworks))]
    public static partial StackRevisionInfo ToInfo(StackRevisionRecord row);

    private static StackSource? StackSourceOf(StackRecord stack) =>
        SourceOf(stack.ProjectId, stack.ProjectName, stack.ComposePath, stack.EnvironmentId, stack.EnvironmentName);

    private static StackSource? RevisionSourceOf(StackRevisionRecord row) =>
        SourceOf(row.ProjectId, row.ProjectName, row.ComposePath, row.EnvironmentId, row.EnvironmentName);

    private static StackSource? SourceOf(string? projectId, string? projectName, string? composePath, string? environmentId, string? environmentName) =>
        projectId is null && projectName is null && composePath is null && environmentId is null && environmentName is null
            ? null
            : new StackSource(projectId, projectName, composePath, environmentId, environmentName);

    private static StackRevisionState StateOf(string state) => Enum.Parse<StackRevisionState>(state);

    private static string[] ReadNames(string json) => StackOperations.Read<string[]>(json);

    private static StackDeployStep[] ReadSteps(string json) => StackOperations.Read<StackDeployStep[]>(json);

    private static StackRisk[] ReadFindings(string json) => StackOperations.Read<StackRisk[]>(json);

    private static StackPortBinding[] ReadBindings(string json) => StackOperations.Read<StackPortBinding[]>(json);

    private static StackServiceLimits[] ReadLimits(string json) => StackOperations.Read<StackServiceLimits[]>(json);

    private static StackServiceNetworks[] ReadNetworks(string json) => StackOperations.Read<StackServiceNetworks[]>(json);

    private static string[] Unacknowledged(StackRevisionRecord row) =>
        StackOperations.Unacknowledged(ReadFindings(row.Findings), ReadNames(row.AcknowledgedRisks));
}
