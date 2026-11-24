using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Releases;

namespace Runova.ServerCore.Stacks;

/// <summary>
/// GitHub Release images (E105): a GithubRelease revision waits for its image, which the core
/// downloads from GitHub, checks, matches against the compose file's images and loads into Docker
/// before the revision is validated. The deploy then pulls only the images the release does not
/// bring. The signed link in the request is used for the download and goes nowhere else.
/// </summary>
internal sealed partial class StackOperations
{
    /// <summary>Where the asset lands while it is checked and loaded; deleted however that ends.</summary>
    public const string ReleaseDownloadFileName = "release-image.download";

    public async Task<StackRevisionInfo> LoadReleaseImageAsync(
        Guid stackId,
        int number,
        StackReleaseImageRequest? request,
        StackCaller caller,
        CancellationToken cancellationToken)
    {
        var stack = await StackAsync(stackId, cancellationToken);
        var row = await RevisionAsync(stackId, number, cancellationToken);
        if (row.ImageSource != nameof(StackImageSource.GithubRelease) || row.State != nameof(StackRevisionState.AwaitingImage))
        {
            throw new StackRefusedException("This revision is not waiting for a GitHub Release image.", StatusCodes.Status409Conflict);
        }

        var target = request is null ? null : $"{request.Repository}@{request.Tag}";
        Dictionary<string, string?> Describe(ReleaseVia? via) => new()
        {
            ["revision"] = number.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["release"] = target,
            ["asset"] = request?.AssetName,
            ["sha256"] = request?.Sha256,
            ["via"] = via?.ToString(),
        };

        async Task<StackRefusedException> RefuseAsync(string reason)
        {
            var parameters = Describe(null);
            parameters["reason"] = reason;
            await AuditAsync("stack.release-image", AuditResult.Denied, caller, stack.Name, parameters, cancellationToken);
            return new StackRefusedException(reason);
        }

        if (ReleaseDownloads.Problem(request) is { } problem)
        {
            throw await RefuseAsync(problem);
        }

        var folder = RevisionFolder(stackId, number);
        var download = Path.Combine(folder, ReleaseDownloadFileName);
        try
        {
            if (File.Exists(download))
            {
                File.Delete(download);
            }

            ReleaseVia via;
            try
            {
                via = await releases.DownloadAsync(request!, download, cancellationToken);
            }
            catch (ReleaseRefusedException refused)
            {
                throw await RefuseAsync(refused.Message);
            }

            string[] tags;
            try
            {
                tags = await ReleaseArchive.ReadTagsAsync(download, cancellationToken);
            }
            catch (InvalidDataException invalid)
            {
                throw await RefuseAsync(invalid.Message);
            }

            if (tags.Length == 0)
            {
                throw await RefuseAsync($"{request!.AssetName} holds no tagged image. Save the image with its name (docker save name:tag) in the pipeline.");
            }

            string[] used;
            try
            {
                using var config = await ConfigAsync(Project(stack.Name, folder, withOverride: false), cancellationToken);
                used = [.. config.Services.Select(s => s.Image).OfType<string>()];
            }
            catch (ComposeConfigException invalid)
            {
                throw await RefuseAsync(invalid.Message);
            }

            // Docker applies every one of these names to the engine all apps share, so each has to be
            // an image of this app: one more would move a tag another app runs onto this image.
            var foreign = tags.Where(tag => !used.Any(image => ReleaseNames.SameImage(tag, image))).ToArray();
            if (foreign.Length > 0)
            {
                throw await RefuseAsync(
                    $"{request!.AssetName} holds {string.Join(", ", foreign)}, which no service of the compose file uses ({(used.Length == 0 ? "none names an image" : string.Join(", ", used))}). Save only the images this app runs, under the names its image: lines give.");
            }

            IReadOnlyList<string> loaded;
            try
            {
                await using var archive = new FileStream(download, FileMode.Open, FileAccess.Read, FileShare.Read, 81920, useAsync: true);
                loaded = await engine.LoadImageAsync(archive, cancellationToken);
            }
            catch (Exception error) when (error is DockerUnavailableException or DockerRequestException)
            {
                throw await RefuseAsync($"Docker could not load {request!.AssetName}: {error.Message}");
            }

            var image = new StackReleaseImage(
                request!.Repository,
                request.Tag,
                request.AssetId,
                request.AssetName,
                request.Size,
                request.Sha256.ToLowerInvariant(),
                [.. tags.Union(loaded, StringComparer.Ordinal)]);
            await using (var db = await contexts.CreateDbContextAsync(cancellationToken))
            {
                var json = Write(image);
                await db.StackRevisions
                    .Where(r => r.StackId == stackId && r.Number == number)
                    .ExecuteUpdateAsync(u => u.SetProperty(r => r.ReleaseImage, json), cancellationToken);
            }

            var parameters = Describe(via);
            parameters["images"] = string.Join(",", image.Images);
            await AuditAsync("stack.release-image", AuditResult.Success, caller, stack.Name, parameters, cancellationToken);
        }
        finally
        {
            if (File.Exists(download))
            {
                File.Delete(download);
            }
        }

        return await ValidateAsync(stack, number, caller, cancellationToken);
    }

    /// <summary>
    /// What the pull step fetches for a revision: every service (null) for one that brought no
    /// release image, else the services whose image did not come from the release.
    /// </summary>
    private async Task<string[]?> ServicesToPullAsync(StackRevisionRecord row, ComposeProject project, CancellationToken cancellationToken)
    {
        if (row.ReleaseImage is null)
        {
            return null;
        }

        var release = Read<StackReleaseImage>(row.ReleaseImage);
        using var config = await ConfigAsync(project, cancellationToken);
        return [.. config.Services
            .Where(service => service.Image is not { Length: > 0 } image || !release.Images.Any(loaded => ReleaseNames.SameImage(loaded, image)))
            .Select(service => service.Name)];
    }
}
