using System.Diagnostics;
using System.Globalization;
using System.Runtime.CompilerServices;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Registries;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Hubs;

/// <summary>
/// Docker. Every role reads (lists, inspect without environment values, stats, logs, events);
/// Operators run the lifecycle and pull images; Admins reveal environment values (after a
/// step-up), open consoles, remove with volumes, remove volumes, prune and install the engine.
/// Every name is checked before it reaches the engine, and every change lands in the audit
/// trail, refused ones included. Nothing here ever records an environment value or a keystroke.
/// </summary>
internal sealed partial class CoreHub
{
    private const int MaxConsoleArguments = 32;
    private const int MaxConsoleArgumentLength = 4_096;

    [Authorize(Policy = CorePolicies.Viewer)]
    public Task<DockerStatus> GetDockerStatus() => docker.GetStatusAsync(Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Viewer)]
    public Task<ContainerList> ListContainers() => DockerCallAsync(() => docker.ListAsync(Context.ConnectionAborted));

    [Authorize(Policy = CorePolicies.Viewer)]
    public Task<ContainerDetails> InspectContainer(string containerId)
    {
        RequireContainer(containerId);
        return DockerCallAsync(() => docker.InspectAsync(containerId, Context.ConnectionAborted));
    }

    [Authorize(Policy = CorePolicies.Viewer)]
    public async IAsyncEnumerable<ContainerStatsBatch> StreamContainerStats(
        ContainerStatsRequest request,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        using var lease = server.Streams.Open(Context.ConnectionId, StreamLimits.ContainerStats);
        var ids = request?.ContainerIds;
        if (ids is not null && (ids.Length is 0 or > DockerOperations.MaxStatsContainers || !ids.All(DockerNames.IsContainer)))
        {
            throw new HubException($"Ask for 1 to {DockerOperations.MaxStatsContainers} containers by id or name, or none for every running one.");
        }

        await foreach (var batch in Guard(docker.StreamStatsAsync(ids, DockerOperations.ClampInterval(request?.IntervalMs), cancellationToken), cancellationToken))
        {
            yield return batch;
        }
    }

    [Authorize(Policy = CorePolicies.Viewer)]
    public async IAsyncEnumerable<ContainerLogBatch> StreamContainerLogs(
        ContainerLogsRequest request,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        using var lease = server.Streams.Open(Context.ConnectionId, StreamLimits.ContainerLogs);
        RequireContainer(request?.ContainerId);
        if (request!.AfterTimestamp is not null && !DockerTime.TryParseNanoseconds(request.AfterTimestamp, out _))
        {
            throw new HubException("AfterTimestamp is a line's Timestamp, as the stream sent it.");
        }

        await foreach (var batch in Guard(docker.StreamLogsAsync(request, cancellationToken), cancellationToken))
        {
            yield return batch;
        }
    }

    [Authorize(Policy = CorePolicies.Viewer)]
    public async Task<ImageInfo[]> ListImages() => [.. await DockerCallAsync(() => docker.ListImagesAsync(Context.ConnectionAborted))];

    [Authorize(Policy = CorePolicies.Viewer)]
    public async Task<VolumeInfo[]> ListVolumes() => [.. await DockerCallAsync(() => docker.ListVolumesAsync(Context.ConnectionAborted))];

    [Authorize(Policy = CorePolicies.Viewer)]
    public async Task<NetworkInfo[]> ListNetworks() => [.. await DockerCallAsync(() => docker.ListNetworksAsync(Context.ConnectionAborted))];

    [Authorize(Policy = CorePolicies.Viewer)]
    public Task<DockerDiskUsage> GetDockerDiskUsage() => DockerCallAsync(() => docker.DiskUsageAsync(Context.ConnectionAborted));

    [Authorize(Policy = CorePolicies.Viewer)]
    public async IAsyncEnumerable<DockerEvent> StreamDockerEvents(
        DockerEventsRequest request,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        using var lease = server.Streams.Open(Context.ConnectionId, StreamLimits.DockerEvents);
        if (request?.AfterCursor is { } cursor && (cursor.Length > 20 || !cursor.All(char.IsAsciiDigit)))
        {
            throw new HubException("AfterCursor is an event's Cursor, as the stream sent it.");
        }

        await foreach (var engineEvent in Guard(docker.StreamEventsAsync(request ?? new DockerEventsRequest(), cancellationToken), cancellationToken))
        {
            yield return engineEvent;
        }
    }

    [Authorize(Policy = CorePolicies.Operator)]
    public Task<ContainerSummary> StartContainer(string containerId) =>
        ContainerChangeAsync("container.start", containerId, null, engine => engine.StartContainerAsync(containerId, Context.ConnectionAborted));

    [Authorize(Policy = CorePolicies.Operator)]
    public Task<ContainerSummary> StopContainer(string containerId, int? timeoutSeconds) =>
        ContainerChangeAsync(
            "container.stop",
            containerId,
            Timeout(timeoutSeconds),
            engine => engine.StopContainerAsync(containerId, timeoutSeconds, Context.ConnectionAborted),
            valid: timeoutSeconds is null or (>= 0 and <= 600));

    [Authorize(Policy = CorePolicies.Operator)]
    public Task<ContainerSummary> RestartContainer(string containerId, int? timeoutSeconds) =>
        ContainerChangeAsync(
            "container.restart",
            containerId,
            Timeout(timeoutSeconds),
            engine => engine.RestartContainerAsync(containerId, timeoutSeconds, Context.ConnectionAborted),
            valid: timeoutSeconds is null or (>= 0 and <= 600));

    [Authorize(Policy = CorePolicies.Operator)]
    public Task<ContainerSummary> PauseContainer(string containerId) =>
        ContainerChangeAsync("container.pause", containerId, null, engine => engine.PauseContainerAsync(containerId, Context.ConnectionAborted));

    [Authorize(Policy = CorePolicies.Operator)]
    public Task<ContainerSummary> UnpauseContainer(string containerId) =>
        ContainerChangeAsync("container.unpause", containerId, null, engine => engine.UnpauseContainerAsync(containerId, Context.ConnectionAborted));

    [Authorize(Policy = CorePolicies.Operator)]
    public Task<ContainerSummary> KillContainer(string containerId, string? signal)
    {
        var chosen = signal ?? "SIGKILL";
        return ContainerChangeAsync(
            "container.kill",
            containerId,
            new() { ["signal"] = chosen.Length > 16 ? chosen[..16] : chosen },
            engine => engine.KillContainerAsync(containerId, chosen, Context.ConnectionAborted),
            valid: DockerNames.Signals.Contains(chosen));
    }

    [Authorize(Policy = CorePolicies.Operator)]
    public async Task<ContainerDetails> UpdateContainerLimits(ContainerLimitsRequest request)
    {
        const string action = "container.limits";
        var parameters = new Dictionary<string, string?>
        {
            ["cpus"] = request?.Cpus?.ToString("0.##", CultureInfo.InvariantCulture) ?? "server",
            ["memoryMb"] = request?.MemoryMb?.ToString(CultureInfo.InvariantCulture) ?? "server",
        };
        var problem = await LimitsProblemAsync(request);
        if (problem is not null)
        {
            await AuditAsync(action, AuditResult.Denied, Clip(request?.Container), parameters);
            throw new HubException(problem);
        }

        await DockerChangeAsync(action, request!.Container, parameters, () => docker.UpdateLimitsAsync(request.Container, request.Cpus, request.MemoryMb, Context.ConnectionAborted));
        return await DockerCallAsync(() => docker.InspectAsync(request.Container, Context.ConnectionAborted));
    }

    /// <summary>Why live caps are refused, or null: the shape, the server's own size, and a container an app owns.</summary>
    private async Task<string?> LimitsProblemAsync(ContainerLimitsRequest? request)
    {
        if (request is null || !DockerNames.IsContainer(request.Container))
        {
            return "That is not a container id or name.";
        }

        if (request.Cpus is { } cpus && (double.IsNaN(cpus) || cpus < 0.01))
        {
            return "The CPU cap has to be at least 0.01 of a core.";
        }

        if (request.MemoryMb is { } memory && memory < Stacks.ResourceLimits.MinMemoryMb)
        {
            return $"The memory cap has to be {Stacks.ResourceLimits.MinMemoryMb} MB or more.";
        }

        var info = await DockerCallAsync(() => docker.InfoAsync(Context.ConnectionAborted));
        if (request.Cpus is { } wanted && info.Cpus is { } available && wanted > available)
        {
            return $"The server has {available} {(available == 1 ? "core" : "cores")}, so the container cannot get {wanted.ToString("0.##", CultureInfo.InvariantCulture)}.";
        }

        if (request.MemoryMb is { } asked && info.MemoryBytes is { } total && asked * 1024L * 1024 > total)
        {
            return $"The server has {total / (1024 * 1024)} MB of memory, so the container cannot get {asked} MB.";
        }

        var summary = await DockerCallAsync(() => docker.SummaryAsync(request.Container, Context.ConnectionAborted));
        return summary.ComposeProject is { } project && await stacks.IsAppAsync(project, Context.ConnectionAborted)
            ? $"This container belongs to the app {project}. Change its caps on the app's page, so they hold when the app is redeployed."
            : null;
    }

    [Authorize(Policy = CorePolicies.Operator)]
    public async Task RemoveContainer(ContainerRemoveRequest request)
    {
        var parameters = new Dictionary<string, string?>
        {
            ["removeVolumes"] = request?.RemoveVolumes == true ? "true" : "false",
            ["force"] = request?.Force == true ? "true" : "false",
        };
        if (request is null || !DockerNames.IsContainer(request.ContainerId))
        {
            await AuditAsync("container.remove", AuditResult.Denied, Clip(request?.ContainerId), parameters);
            throw new HubException("That is not a container id or name.");
        }

        if (request.RemoveVolumes && !IsAdmin)
        {
            await AuditAsync("container.remove", AuditResult.Denied, request.ContainerId, parameters);
            throw new HubException("Removing a container with its volumes is for Admins.");
        }

        await DockerChangeAsync(
            "container.remove",
            request.ContainerId,
            parameters,
            () => docker.RemoveContainerAsync(request.ContainerId, request.RemoveVolumes, request.Force, Context.ConnectionAborted));
    }

    [Authorize(Policy = CorePolicies.Operator)]
    public async Task<JobInfo> PullImage(ImagePullRequest request)
    {
        if (!DockerNames.TryParseReference(request?.Reference, out var image))
        {
            await AuditAsync("image.pull", AuditResult.Denied, Clip(request?.Reference));
            throw new HubException("That is not an image reference (such as nginx:1.29 or ghcr.io/org/app@sha256:...).");
        }

        RegistryLogin? login = null;
        if (request!.Auth is { } auth)
        {
            login = RegistryCredentials.Check(auth.Registry, auth.Username, auth.Secret, RegistryLoginSource.Request);
            if (login is null || login.Registry != RegistryNames.HostOfRepository(image.Repository))
            {
                await AuditAsync("image.pull", AuditResult.Denied, image.ToString(), new() { ["registryAuth"] = "invalid" });
                throw new HubException("The sign-in sent with this pull is not valid for the image's registry.");
            }
        }

        var parameters = new Dictionary<string, string?> { ["image"] = image.ToString() };
        if (login is not null)
        {
            parameters["registry"] = login.Registry;
        }

        return await StartJobAsync(
            "image.pull",
            () => docker.PullAsync(image, Caller, Context.ConnectionAborted, login),
            parameters);
    }

    [Authorize(Policy = CorePolicies.Operator)]
    public async Task RemoveImage(ImageRemoveRequest request)
    {
        var parameters = new Dictionary<string, string?> { ["force"] = request?.Force == true ? "true" : "false" };
        if (request is null || !DockerNames.IsImage(request.Image))
        {
            await AuditAsync("image.remove", AuditResult.Denied, Clip(request?.Image), parameters);
            throw new HubException("That is not an image id or reference.");
        }

        await DockerChangeAsync("image.remove", request.Image, parameters, () => docker.RemoveImageAsync(request.Image, request.Force, Context.ConnectionAborted));
    }

    [Authorize(Policy = CorePolicies.Operator)]
    public async Task RemoveNetwork(string network)
    {
        if (!DockerNames.IsNetwork(network))
        {
            await AuditAsync("network.remove", AuditResult.Denied, Clip(network));
            throw new HubException("That is not a network id or name.");
        }

        await DockerChangeAsync("network.remove", network, null, () => docker.RemoveNetworkAsync(network, Context.ConnectionAborted));
    }

    [Authorize(Policy = CorePolicies.Operator)]
    public Task ConnectContainerNetwork(ContainerNetworkRequest request) =>
        ContainerNetworkChangeAsync("network.connect", request, (network, container) => docker.ConnectNetworkAsync(network, container, Context.ConnectionAborted));

    [Authorize(Policy = CorePolicies.Operator)]
    public Task DisconnectContainerNetwork(ContainerNetworkRequest request) =>
        ContainerNetworkChangeAsync("network.disconnect", request, (network, container) => docker.DisconnectNetworkAsync(network, container, Context.ConnectionAborted));

    /// <summary>Both names are checked before either reaches a request path; the container is the target in the trail.</summary>
    private async Task ContainerNetworkChangeAsync(string action, ContainerNetworkRequest? request, Func<string, string, Task> change)
    {
        var parameters = new Dictionary<string, string?> { ["network"] = Clip(request?.Network) };
        if (request is null || !DockerNames.IsContainer(request.ContainerId) || !DockerNames.IsNetwork(request.Network))
        {
            await AuditAsync(action, AuditResult.Denied, Clip(request?.ContainerId), parameters);
            throw new HubException(request is not null && DockerNames.IsContainer(request.ContainerId)
                ? "That is not a network id or name."
                : "That is not a container id or name.");
        }

        await DockerChangeAsync(action, request.ContainerId, parameters, () => change(request.Network, request.ContainerId));
    }

    [Authorize(Policy = CorePolicies.Admin)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<ContainerEnvVariable[]> RevealContainerEnv(string containerId)
    {
        if (!DockerNames.IsContainer(containerId))
        {
            await AuditAsync("container.env-reveal", AuditResult.Denied, Clip(containerId));
            throw new HubException("That is not a container id or name.");
        }

        var variables = await DockerCallAsync(() => docker.RevealEnvironmentAsync(containerId, Context.ConnectionAborted));
        // The names and values stay out of the trail; how many were shown is enough.
        await AuditAsync(
            "container.env-reveal",
            AuditResult.Success,
            containerId,
            new() { ["variables"] = variables.Length.ToString(CultureInfo.InvariantCulture) });
        return variables;
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public async IAsyncEnumerable<ConsoleOutput> ContainerConsole(
        ConsoleRequest request,
        IAsyncEnumerable<ConsoleInput> input,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        using var lease = server.Streams.Open(Context.ConnectionId, StreamLimits.Console);
        var command = request?.Command is { Length: > 0 } asked ? asked : DockerOperations.DefaultShell;
        var valid = request is not null
            && DockerNames.IsContainer(request.ContainerId)
            && (request.User is null || DockerNames.IsUser(request.User))
            && command.Length <= MaxConsoleArguments
            && command[0].Length > 0
            && command.All(argument => argument is not null && argument.Length <= MaxConsoleArgumentLength && !argument.Contains('\0', StringComparison.Ordinal));
        var parameters = new Dictionary<string, string?>
        {
            ["command"] = valid ? string.Join(' ', command) : null,
            ["user"] = request?.User,
        };
        if (!valid)
        {
            await AuditAsync("container.console-open", AuditResult.Denied, Clip(request?.ContainerId), parameters);
            throw new HubException("A console needs a container id or name, a valid user, and at most 32 arguments.");
        }

        var started = Stopwatch.GetTimestamp();
        await AuditAsync("container.console-open", AuditResult.Success, request!.ContainerId, parameters);
        int? exitCode = null;
        var result = AuditResult.Cancelled;
        try
        {
            await foreach (var output in Guard(docker.ConsoleAsync(request, command, input, cancellationToken), cancellationToken))
            {
                if (output.Ended)
                {
                    exitCode = output.ExitCode;
                    result = AuditResult.Success;
                }

                yield return output;
            }
        }
        finally
        {
            var closed = new Dictionary<string, string?>
            {
                // Not "exitCode": the redactor hides anything named like a code.
                ["exit"] = exitCode?.ToString(CultureInfo.InvariantCulture),
                ["seconds"] = ((long)Stopwatch.GetElapsedTime(started).TotalSeconds).ToString(CultureInfo.InvariantCulture),
            };
            await AuditAsync("container.console-close", result, request.ContainerId, closed);
        }
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task RemoveVolume(string volume, bool force)
    {
        var parameters = new Dictionary<string, string?> { ["force"] = force ? "true" : "false" };
        if (!DockerNames.IsVolume(volume))
        {
            await AuditAsync("volume.remove", AuditResult.Denied, Clip(volume), parameters);
            throw new HubException("That is not a volume name.");
        }

        await DockerChangeAsync("volume.remove", volume, parameters, () => docker.RemoveVolumeAsync(volume, force, Context.ConnectionAborted));
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<DockerPruneResult> PruneDocker(DockerPruneRequest request)
    {
        var parameters = new Dictionary<string, string?>
        {
            ["target"] = request is null ? null : ((int)request.Target).ToString(CultureInfo.InvariantCulture),
            ["allImages"] = request?.AllImages == true ? "true" : "false",
            ["includeVolumes"] = request?.IncludeVolumes == true ? "true" : "false",
        };
        if (request is null || !Enum.IsDefined(request.Target))
        {
            await AuditAsync("docker.prune", AuditResult.Denied, null, parameters);
            throw new HubException("Prune containers, images, volumes, networks, the build cache or the whole system.");
        }

        parameters["target"] = Jobs.JobEngine.KindName(request.Target);
        DockerPruneResult? pruned = null;
        await DockerChangeAsync("docker.prune", null, parameters, async () => pruned = await docker.PruneAsync(request, Context.ConnectionAborted));
        return pruned!;
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public Task<JobInfo> InstallDocker(DockerInstallRequest request) =>
        StartJobAsync(
            "docker.install",
            () => docker.InstallAsync(request?.RemoveConflictingPackages == true, Caller, Context.ConnectionAborted),
            new() { ["removeConflictingPackages"] = request?.RemoveConflictingPackages == true ? "true" : "false" });

    private static void RequireContainer(string? containerId)
    {
        if (!DockerNames.IsContainer(containerId))
        {
            throw new HubException("That is not a container id or name.");
        }
    }

    private static Dictionary<string, string?>? Timeout(int? seconds) =>
        seconds is int value ? new() { ["timeoutSeconds"] = value.ToString(CultureInfo.InvariantCulture) } : null;

    /// <summary>Whatever the app sent, short enough for the trail.</summary>
    private static string? Clip(string? value) => value is { Length: > 64 } ? value[..64] : value;

    private async Task<ContainerSummary> ContainerChangeAsync(
        string action,
        string containerId,
        Dictionary<string, string?>? parameters,
        Func<DockerOperations, Task> change,
        bool valid = true)
    {
        if (!valid || !DockerNames.IsContainer(containerId))
        {
            await AuditAsync(action, AuditResult.Denied, Clip(containerId), parameters);
            throw new HubException(valid ? "That is not a container id or name." : "That is not something this action accepts.");
        }

        await DockerChangeAsync(action, containerId, parameters, () => change(docker));
        return await DockerCallAsync(() => docker.SummaryAsync(containerId, Context.ConnectionAborted));
    }

    /// <summary>A change on the engine, recorded either way; the engine's refusal reaches the app as it said it.</summary>
    private async Task DockerChangeAsync(string action, string? target, Dictionary<string, string?>? parameters, Func<Task> change)
    {
        try
        {
            await change();
        }
        catch (Exception error) when (error is DockerUnavailableException or DockerNotFoundException or DockerRequestException)
        {
            await AuditAsync(action, AuditResult.Failed, target, new Dictionary<string, string?>(parameters ?? []) { ["error"] = error.Message });
            throw new HubException(error.Message);
        }

        await AuditAsync(action, AuditResult.Success, target, parameters);
    }

    private static async Task<T> DockerCallAsync<T>(Func<Task<T>> call)
    {
        try
        {
            return await call();
        }
        catch (Exception error) when (error is DockerUnavailableException or DockerNotFoundException or DockerRequestException)
        {
            throw new HubException(error.Message);
        }
    }

    /// <summary>A stream whose engine errors reach the app as messages instead of a bare stream failure.</summary>
    private static async IAsyncEnumerable<T> Guard<T>(IAsyncEnumerable<T> source, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        await using var items = source.GetAsyncEnumerator(cancellationToken);
        while (true)
        {
            bool more;
            try
            {
                more = await items.MoveNextAsync();
            }
            catch (Exception error) when (error is DockerUnavailableException or DockerNotFoundException or DockerRequestException)
            {
                throw new HubException(error.Message);
            }

            if (!more)
            {
                yield break;
            }

            yield return items.Current;
        }
    }
}
