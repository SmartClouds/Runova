using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.SignalR.Client;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests.Stacks;

/// <summary>
/// Where a revision's images come from (E105). A revision from a registry or a GitHub Release
/// never builds on the server, even when the compose file has build sections; one with no source
/// (an app from before E105) and one from a local folder behave exactly as they always did.
/// </summary>
public sealed class StackSourceTests
{
    private const string BuildsWithImage = """
        services:
          api:
            build: ./api
            image: ghcr.io/acme/api:1.4.0
            restart: unless-stopped
            ports:
              - "3000:3000"
        """;

    private const string BuildsWithoutImage = """
        services:
          api:
            build: ./api
            restart: unless-stopped
        """;

    private static CancellationToken Cancel => StackKit.Cancel;

    private static StackRevisionUpload From(StackImageSource? source, string compose, bool context = false, string[]? proxied = null) =>
        StackKit.Upload(compose, proxied: proxied ?? ["api"], context: context) with { ImageSource = source };

    [Fact]
    public async Task A_registry_revision_of_pulled_images_deploys_exactly_as_one_without_a_source()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await kit.CreateStackAsync();

        var legacy = await kit.UploadAsync(stack.Id, StackKit.Upload());
        var registry = await kit.UploadAsync(stack.Id, StackKit.Upload() with { ImageSource = StackImageSource.Registry });
        var (job, _) = await kit.RunAsync(await kit.DeployAsync(stack.Id, registry.Number));
        var details = await kit.GetAsync(stack.Id);
        var legacyFiles = await kit.Hub.InvokeAsync<StackRevisionFiles>(nameof(ICoreHub.GetStackRevisionFiles), new StackRevisionRef(stack.Id, legacy.Number), Cancel);
        var registryFiles = await kit.Hub.InvokeAsync<StackRevisionFiles>(nameof(ICoreHub.GetStackRevisionFiles), new StackRevisionRef(stack.Id, registry.Number), Cancel);

        Assert.Null(legacy.ImageSource);
        Assert.Equal(StackImageSource.Registry, registry.ImageSource);
        Assert.Equal(StackRevisionState.Ready, registry.State);
        Assert.Equal(legacyFiles.Override, registryFiles.Override);
        Assert.Equal(JobState.Succeeded, job.State);
        var steps = details.Revisions.Single(r => r.Number == registry.Number).Steps;
        Assert.Equal(StackStepState.Skipped, steps.Single(step => step.Kind == StackStepKind.Build).State);
        Assert.All(steps.Where(step => step.Kind != StackStepKind.Build), step => Assert.Equal(StackStepState.Succeeded, step.State));
        Assert.Contains("site pull --ignore-buildable", kit.Simulated.Calls);
    }

    [Fact]
    public async Task A_registry_revision_never_builds_even_when_the_compose_file_has_a_build_section()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await kit.CreateStackAsync();

        var revision = await kit.UploadAsync(stack.Id, From(StackImageSource.Registry, BuildsWithImage));
        var files = await kit.Hub.InvokeAsync<StackRevisionFiles>(nameof(ICoreHub.GetStackRevisionFiles), new StackRevisionRef(stack.Id, revision.Number), Cancel);
        var (job, _) = await kit.RunAsync(await kit.DeployAsync(stack.Id, revision.Number));
        var steps = (await kit.GetAsync(stack.Id)).Revisions[0].Steps;

        Assert.Equal(StackRevisionState.Ready, revision.State);
        Assert.False(revision.HasBuildContext);
        Assert.Contains("build: !reset null", files.Override, StringComparison.Ordinal);
        Assert.Equal(JobState.Succeeded, job.State);
        Assert.Equal(StackStepState.Skipped, steps.Single(step => step.Kind == StackStepKind.Build).State);
        Assert.DoesNotContain(kit.Simulated.Calls, call => call.StartsWith("site build", StringComparison.Ordinal));
        Assert.Contains(kit.Simulated.Calls, call => call.StartsWith("site pull", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_registry_revision_with_project_files_takes_them_but_still_never_builds()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await kit.CreateStackAsync();
        var revision = await kit.UploadAsync(stack.Id, From(StackImageSource.Registry, BuildsWithImage, context: true));
        using var archive = StackKit.Archive(StackKit.File("nginx.conf", "events {}\n"));

        using var response = await kit.PutContextAsync(stack.Id, revision.Number, archive, StackKit.Sha(archive));
        var ready = (await response.Content.ReadFromJsonAsync<StackRevisionInfo>(CoreJson.Options, Cancel))!;
        var (job, _) = await kit.RunAsync(await kit.DeployAsync(stack.Id, revision.Number));

        Assert.Equal(StackRevisionState.AwaitingContext, revision.State);
        Assert.Equal(StackRevisionState.Ready, ready.State);
        Assert.Equal(JobState.Succeeded, job.State);
        Assert.Equal(StackStepState.Skipped, (await kit.GetAsync(stack.Id)).Revisions[0].Steps.Single(step => step.Kind == StackStepKind.Build).State);
    }

    [Fact]
    public async Task A_service_that_builds_without_naming_an_image_makes_a_registry_revision_invalid_with_the_fix()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await kit.CreateStackAsync();

        var revision = await kit.UploadAsync(stack.Id, From(StackImageSource.Registry, BuildsWithoutImage));

        Assert.Equal(StackRevisionState.Invalid, revision.State);
        Assert.Contains("api", revision.Error, StringComparison.Ordinal);
        Assert.Contains("image:", revision.Error, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_local_folder_revision_builds_from_its_context_as_before()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await kit.CreateStackAsync();
        var revision = await kit.UploadAsync(stack.Id, From(StackImageSource.LocalFolder, BuildsWithoutImage, context: true));
        using var archive = StackKit.Archive(StackKit.File("api/Dockerfile", "FROM scratch\n"));

        using var response = await kit.PutContextAsync(stack.Id, revision.Number, archive, StackKit.Sha(archive));
        var (job, _) = await kit.RunAsync(await kit.DeployAsync(stack.Id, revision.Number));
        var steps = (await kit.GetAsync(stack.Id)).Revisions[0].Steps;

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(JobState.Succeeded, job.State);
        Assert.Equal(StackStepState.Succeeded, steps.Single(step => step.Kind == StackStepKind.Build).State);
        Assert.Equal(StackImageSource.LocalFolder, (await kit.GetAsync(stack.Id)).Revisions[0].ImageSource);
    }

    [Fact]
    public async Task A_local_folder_revision_without_its_build_context_is_refused()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await kit.CreateStackAsync();

        using var response = await kit.PostRevisionAsync(stack.Id, From(StackImageSource.LocalFolder, BuildsWithoutImage));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
