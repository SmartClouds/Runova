using Tapper;

namespace Runova.ServerCore.Contracts;

// Compose stacks (E07), shown in the app as Apps. A stack is a named compose project; each
// upload of its files is a numbered revision, and a deploy runs one revision. Files arrive over
// REST (POST /api/v1/stacks/{id}/revisions, then PUT .../revisions/{n}/context for a build
// context), since a compose file and its .env can be larger than a hub message. Everything else
// is on the hub.

/// <summary>How a stack is doing, worked out from its containers and its last deploy.</summary>
[TranspilationSource]
public enum StackStatus
{
    /// <summary>Created, never deployed.</summary>
    New,

    /// <summary>A job is working on it right now.</summary>
    Busy,

    /// <summary>Every container runs, and none reports unhealthy.</summary>
    Running,

    /// <summary>Some containers run, others stopped or report unhealthy.</summary>
    Degraded,

    /// <summary>Its containers exist but none runs.</summary>
    Stopped,

    /// <summary>Deployed before, but no container is left (taken down).</summary>
    Down,

    /// <summary>The last deploy failed and nothing runs.</summary>
    Failed,
}

[TranspilationSource]
public enum StackRevisionState
{
    /// <summary>The files are in; the build context the upload announced has not arrived.</summary>
    AwaitingContext,

    /// <summary>The files are in; the GitHub Release image it deploys has not been loaded yet (E105).</summary>
    AwaitingImage,

    /// <summary>Checked with docker compose config and ready to deploy.</summary>
    Ready,

    /// <summary>docker compose config refused it; Error says why.</summary>
    Invalid,

    Deploying,

    /// <summary>What runs now.</summary>
    Live,

    Failed,

    /// <summary>Ran once; a later revision took its place.</summary>
    Superseded,
}

[TranspilationSource]
public enum StackStepKind
{
    Validate,
    Pull,
    Build,
    Up,
    Health,
}

[TranspilationSource]
public enum StackStepState
{
    Pending,
    Running,
    Succeeded,
    Failed,
    Skipped,
    Cancelled,
}

[TranspilationSource]
public enum StackRiskSeverity
{
    Critical,
    High,
    Medium,
    Low,
}

[TranspilationSource]
public enum StackAction
{
    Start,
    Stop,
    Restart,

    /// <summary>docker compose down: the containers and networks go, volumes stay.</summary>
    Down,
}

/// <summary>
/// Where a revision's images come from (E105). Registry and GithubRelease revisions never build on
/// the server: the core resets every service's build section, and only the compose file, the .env
/// and the project files the compose file reads arrive. LocalFolder builds from the compose folder
/// the user approved sending. A revision without one (an app from before E105) works as it always
/// did: it builds when the compose file builds.
/// </summary>
[TranspilationSource]
public enum StackImageSource
{
    Registry,
    GithubRelease,
    LocalFolder,
}

/// <summary>
/// The GitHub Release asset a revision deploys (E105), as the core downloaded and checked it, and
/// the image names docker load reported from it.
/// </summary>
/// <param name="Repository">owner/name on github.com.</param>
/// <param name="Sha256">The asset's SHA-256 in lowercase hex, as GitHub reports it and as it arrived.</param>
[TranspilationSource]
public sealed record StackReleaseImage(string Repository, string Tag, long AssetId, string AssetName, long Size, string Sha256, string[] Images);

/// <summary>Where the app took the files from, so it can deploy again from the same place.</summary>
[TranspilationSource]
public sealed record StackSource(
    string? ProjectId = null,
    string? ProjectName = null,
    string? ComposePath = null,
    string? EnvironmentId = null,
    string? EnvironmentName = null);

[TranspilationSource]
public sealed record StackInfo(
    Guid Id,
    string Name,
    StackStatus Status,
    long CreatedAtUnixMs,
    long UpdatedAtUnixMs,
    int RevisionCount,
    int? LiveRevision = null,
    string? Description = null,
    StackSource? Source = null,
    int RunningContainers = 0,
    int Containers = 0,
    Guid? ActiveJobId = null);

/// <summary>
/// A risk the core found in the compose file as docker compose config resolved it. Ids follow the
/// app's linter (rule:service:subject), so an acknowledgment given there counts here.
/// </summary>
[TranspilationSource]
public sealed record StackRisk(string Id, string Rule, StackRiskSeverity Severity, string Message, string? Service = null);

/// <summary>One step of a deploy, with the job log lines it wrote (FirstLogSeq to LastLogSeq).</summary>
[TranspilationSource]
public sealed record StackDeployStep(
    StackStepKind Kind,
    StackStepState State,
    long? StartedAtUnixMs = null,
    long? FinishedAtUnixMs = null,
    long? FirstLogSeq = null,
    long? LastLogSeq = null,
    string? Detail = null);

/// <summary>A published port as the deploy binds it (after the loopback override).</summary>
[TranspilationSource]
public sealed record StackPortBinding(string Service, int Target, string Protocol, string? HostIp = null, string? Published = null);

[TranspilationSource]
public sealed record StackRevisionInfo(
    Guid StackId,
    int Number,
    StackRevisionState State,
    long CreatedAtUnixMs,
    string ComposeSha256,
    string[] EnvKeys,
    string[] Services,
    string[] ProxiedServices,
    bool HasBuildContext,
    StackDeployStep[] Steps,
    StackRisk[] Findings,
    string[] AcknowledgedRisks,
    string[] UnacknowledgedRisks,
    StackPortBinding[] Bindings,
    string? CreatedBy = null,
    Guid? JobId = null,
    long? DeployedAtUnixMs = null,
    long? FinishedAtUnixMs = null,
    int? RollbackOf = null,
    string? Error = null,
    StackSource? Source = null,
    StackServiceLimits[]? Limits = null,
    StackServiceNetworks[]? Networks = null,
    StackImageSource? ImageSource = null,
    StackReleaseImage? ReleaseImage = null);

/// <summary>
/// Resource caps on one service of an app; a field left null is no cap. Cores and share are kept
/// apart (Docker applies their product as `cpus`) so the app shows what was picked. The core
/// writes them into the override file, so every redeploy and rollback of the revision holds them.
/// </summary>
/// <param name="CpuCores">Whole cores, 1 up to the server's count.</param>
/// <param name="CpuPercent">How much of those cores it may use, 5 to 100.</param>
/// <param name="MemoryMb">6 MB up to the server's memory; swap cannot go past it.</param>
/// <param name="DiskGb">The container's writable layer, on storage drivers that can cap it.</param>
[TranspilationSource]
public sealed record StackServiceLimits(string Service, int? CpuCores = null, int? CpuPercent = null, int? MemoryMb = null, int? DiskGb = null);

/// <summary>
/// Docker networks one service of an app joins besides its own, by name, such as another app's
/// default network so the two reach each other by service name. The core writes them into the
/// override file as external networks, so every redeploy and rollback of the revision keeps them.
/// </summary>
[TranspilationSource]
public sealed record StackServiceNetworks(string Service, string[] Networks);

[TranspilationSource]
public sealed record StackServiceInfo(string Name, ContainerSummary[] Containers, StackPortBinding[] Ports, string? Image = null);

[TranspilationSource]
public sealed record StackDetails(StackInfo Stack, StackRevisionInfo[] Revisions, StackServiceInfo[] Services);

/// <summary>A revision's files as uploaded (never interpolated) and the override the core wrote. Env values never leave the core.</summary>
[TranspilationSource]
public sealed record StackRevisionFiles(int Number, string Compose, string[] EnvKeys, string? Override = null);

[TranspilationSource]
public sealed record CreateStackRequest(string Name, string? Description = null, StackSource? Source = null);

[TranspilationSource]
public sealed record StackRevisionRef(Guid StackId, int Revision);

[TranspilationSource]
public sealed record AcknowledgeStackRisksRequest(Guid StackId, int Revision, string[] RiskIds);

[TranspilationSource]
public sealed record StackActionRequest(Guid StackId, StackAction Action);

/// <summary>
/// The body of POST /api/v1/stacks/{id}/revisions. Env is the rendered .env text (stored 0600,
/// never shown again); ProxiedServices publish on 127.0.0.1 only. BuildContext announces a
/// .tar.gz that follows with PUT .../revisions/{n}/context: the compose folder for a LocalFolder
/// revision, only the files the compose file reads for the others. A GithubRelease revision then
/// waits for POST .../revisions/{n}/release-image.
/// </summary>
[TranspilationSource]
public sealed record StackRevisionUpload(
    string Compose,
    string Env,
    string[] ProxiedServices,
    string[] AcknowledgedRisks,
    bool BuildContext = false,
    StackSource? Source = null,
    StackServiceLimits[]? Limits = null,
    StackImageSource? ImageSource = null);

/// <summary>Why a revision was made from another one on the server, for the audit trail.</summary>
[TranspilationSource]
public enum StackRevisionPurpose
{
    /// <summary>Anything else: the same files with other proxied services.</summary>
    Edit,

    /// <summary>Services that published beyond 127.0.0.1 move to loopback (E13).</summary>
    MakePrivate,

    /// <summary>An App Store app on newer images: a new compose file, the same .env (E12).</summary>
    Update,

    /// <summary>The same files with other resource caps on its services.</summary>
    Limits,

    /// <summary>The same files with its services on other networks besides their own.</summary>
    Networks,
}

/// <summary>
/// A new revision copied from Revision on the server, its .env and project files included, so
/// no env value travels. Compose replaces the compose file when set (an App Store update);
/// ProxiedServices replaces the loopback set; AcknowledgedRisks, Limits and Networks default to
/// the source's. The revision is validated like an upload and deployed with DeployStack.
/// </summary>
[TranspilationSource]
public sealed record ReviseStackRequest(
    Guid StackId,
    int Revision,
    string[] ProxiedServices,
    string? Compose = null,
    string[]? AcknowledgedRisks = null,
    StackRevisionPurpose Purpose = StackRevisionPurpose.Edit,
    StackServiceLimits[]? Limits = null,
    StackServiceNetworks[]? Networks = null);

/// <summary>One entry of a revision's .env. Only RevealStackEnv returns these (Admin, step-up).</summary>
[TranspilationSource]
public sealed record StackEnvEntry(string Key, string Value);

/// <summary>What a refused upload answers with (status 400, 404 or 409).</summary>
[TranspilationSource]
public sealed record StackUploadError(string Message);
