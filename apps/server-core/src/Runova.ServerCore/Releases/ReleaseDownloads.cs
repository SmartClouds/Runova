using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Releases;

/// <summary>How a release asset reached the server, for the audit trail.</summary>
internal enum ReleaseVia
{
    /// <summary>A signed link the app made with its own GitHub sign-in.</summary>
    SignedLink,

    /// <summary>The token stored on the server for the repository.</summary>
    StoredToken,

    /// <summary>A public repository, without any token.</summary>
    Public,
}

/// <summary>
/// Downloads a GitHub Release asset to a file (E105), checking it against what GitHub reports.
/// A signed link from the app is used once, as it is, and only when it leads to GitHub's asset
/// hosts. Without one the core asks GitHub's API about the asset (with the stored token, or none
/// for a public repository), refuses it when GitHub describes it differently, and follows the
/// API's redirect to the asset host without the token. The bytes are counted and hashed as they
/// arrive: more than the size GitHub reports stops the download, and a size or SHA-256 that
/// differs at the end refuses the asset. No link, token or URL goes into a message, a log line or
/// a file: the HTTP client has no loggers, and the messages are the core's own words.
/// </summary>
internal sealed class ReleaseDownloads(IHttpClientFactory http, ReleaseTokens tokens)
{
    public const string HttpClientName = "runova-release-images";

    public const string ApiBase = "https://api.github.com";

    private const int MaxApiAnswerBytes = 1024 * 1024;

    private const UnixFileMode PrivateFile = UnixFileMode.UserRead | UnixFileMode.UserWrite;

    /// <summary>Why a request cannot be served, or null when its fields are acceptable.</summary>
    public static string? Problem(StackReleaseImageRequest? request)
    {
        if (request is null || !ReleaseNames.IsRepository(request.Repository))
        {
            return "Name the repository as owner/name.";
        }

        if (!ReleaseNames.IsTag(request.Tag) || !ReleaseNames.IsAssetName(request.AssetName) || request.AssetId <= 0)
        {
            return "Name the release and its asset as GitHub lists them.";
        }

        if (request.Size <= 0 || request.Size > ReleaseNames.MaxImageBytes)
        {
            return $"A release image is at most {ReleaseNames.MaxImageBytes / (1024 * 1024 * 1024)} GB.";
        }

        if (!ReleaseNames.IsSha256(request.Sha256))
        {
            return "Send the asset's SHA-256 as GitHub reports it, in hex.";
        }

        return request.DownloadUrl is { } link && (!Uri.TryCreate(link, UriKind.Absolute, out var uri) || !ReleaseNames.IsAssetHost(uri))
            ? "The download link does not lead to GitHub's release asset hosts, so the server did not follow it."
            : null;
    }

    /// <summary>Downloads the asset into <paramref name="destination"/>; throws <see cref="ReleaseRefusedException"/> with the words to show.</summary>
    public async Task<ReleaseVia> DownloadAsync(StackReleaseImageRequest request, string destination, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (Problem(request) is { } problem)
        {
            throw new ReleaseRefusedException(problem);
        }

        var client = http.CreateClient(HttpClientName);
        Uri source;
        ReleaseVia via;
        if (request.DownloadUrl is { } link)
        {
            source = new Uri(link);
            via = ReleaseVia.SignedLink;
        }
        else
        {
            var token = await tokens.UnsealAsync(request.Repository, cancellationToken);
            via = token is null ? ReleaseVia.Public : ReleaseVia.StoredToken;
            await CheckAssetAsync(client, request, token, cancellationToken);
            source = await AssetLinkAsync(client, request, token, cancellationToken);
        }

        await FetchAsync(client, source, request, destination, cancellationToken);
        return via;
    }

    /// <summary>What the server can read of a repository's releases on its own: public, with the stored token, or nothing.</summary>
    public async Task<ReleaseAccess> AccessAsync(string repository, string? token, CancellationToken cancellationToken)
    {
        var client = http.CreateClient(HttpClientName);
        using var request = Api(HttpMethod.Get, $"{ApiBase}/repos/{repository}/releases?per_page=1", "application/vnd.github+json", token);
        try
        {
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            return response.IsSuccessStatusCode ? token is null ? ReleaseAccess.Public : ReleaseAccess.StoredToken : ReleaseAccess.None;
        }
        catch (HttpRequestException)
        {
            throw new ReleaseRefusedException("The server could not reach GitHub to check.");
        }
    }

    private static async Task CheckAssetAsync(HttpClient client, StackReleaseImageRequest request, string? token, CancellationToken cancellationToken)
    {
        using var ask = Api(HttpMethod.Get, AssetApi(request), "application/vnd.github+json", token);
        using var answer = await SendAsync(client, ask, cancellationToken);
        Refuse(answer, request, token);
        JsonElement asset;
        try
        {
            var bytes = await answer.Content.ReadAsByteArrayAsync(cancellationToken);
            if (bytes.Length > MaxApiAnswerBytes)
            {
                throw new ReleaseRefusedException("GitHub's description of the asset is larger than any it sends.");
            }

            using var document = JsonDocument.Parse(bytes);
            asset = document.RootElement.Clone();
        }
        catch (JsonException)
        {
            throw new ReleaseRefusedException("GitHub's description of the asset could not be read.");
        }

        var name = asset.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() : null;
        var size = asset.TryGetProperty("size", out var s) && s.ValueKind == JsonValueKind.Number ? s.GetInt64() : -1;
        var state = asset.TryGetProperty("state", out var st) && st.ValueKind == JsonValueKind.String ? st.GetString() : null;
        var digest = asset.TryGetProperty("digest", out var d) && d.ValueKind == JsonValueKind.String ? d.GetString() : null;
        if (state is not null && state != "uploaded")
        {
            throw new ReleaseRefusedException($"{request.AssetName} has not finished uploading to the release yet.");
        }

        if (digest is null || !digest.StartsWith("sha256:", StringComparison.Ordinal))
        {
            throw new ReleaseRefusedException($"GitHub reports no SHA-256 for {request.AssetName} (assets uploaded before June 2025 have none), so it cannot be checked. Upload it to the release again.");
        }

        if (name != request.AssetName || size != request.Size || !string.Equals(digest["sha256:".Length..], request.Sha256, StringComparison.OrdinalIgnoreCase))
        {
            throw new ReleaseRefusedException($"GitHub describes asset {request.AssetId} of {request.Repository} differently from the request (name, size or SHA-256). Pick the release again.");
        }
    }

    /// <summary>The API answers a download with a redirect to the asset host; the link it gives is followed without the token.</summary>
    private static async Task<Uri> AssetLinkAsync(HttpClient client, StackReleaseImageRequest request, string? token, CancellationToken cancellationToken)
    {
        using var ask = Api(HttpMethod.Get, AssetApi(request), "application/octet-stream", token);
        using var answer = await SendAsync(client, ask, cancellationToken);
        if (answer.StatusCode is HttpStatusCode.Found or HttpStatusCode.MovedPermanently or HttpStatusCode.SeeOther or HttpStatusCode.TemporaryRedirect or HttpStatusCode.PermanentRedirect)
        {
            var location = answer.Headers.Location;
            if (location is not null && !location.IsAbsoluteUri)
            {
                location = new Uri(new Uri(ApiBase), location);
            }

            return ReleaseNames.IsAssetHost(location)
                ? location!
                : throw new ReleaseRefusedException("GitHub sent the download somewhere other than its release asset hosts, so the server did not follow it.");
        }

        Refuse(answer, request, token);
        throw new ReleaseRefusedException("GitHub did not hand out a download for the asset.");
    }

    private static async Task FetchAsync(HttpClient client, Uri source, StackReleaseImageRequest request, string destination, CancellationToken cancellationToken)
    {
        using var ask = new HttpRequestMessage(HttpMethod.Get, source);
        using var answer = await SendAsync(client, ask, cancellationToken);
        if (!answer.IsSuccessStatusCode)
        {
            throw new ReleaseRefusedException(
                $"GitHub's file host answered {(int)answer.StatusCode} for {request.AssetName}. A signed link lasts a few minutes: deploy again for a new one.");
        }

        if (answer.Content.Headers.ContentLength is { } length && length != request.Size)
        {
            throw SizeRefusal(request, length);
        }

        var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Options = FileOptions.Asynchronous, BufferSize = 81920 };
        if (!OperatingSystem.IsWindows())
        {
            options.UnixCreateMode = PrivateFile;
        }

        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        long received = 0;
        try
        {
            await using var input = await answer.Content.ReadAsStreamAsync(cancellationToken);
            await using var output = new FileStream(destination, options);
            var buffer = new byte[81920];
            int read;
            while ((read = await input.ReadAsync(buffer, cancellationToken)) > 0)
            {
                received += read;
                if (received > request.Size)
                {
                    throw SizeRefusal(request, received);
                }

                hash.AppendData(buffer, 0, read);
                await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            }
        }
        catch (Exception error) when (error is HttpRequestException or IOException && error is not ReleaseRefusedException)
        {
            throw new ReleaseRefusedException($"The download of {request.AssetName} broke off after {received} bytes. Deploy again.");
        }

        if (received != request.Size)
        {
            throw SizeRefusal(request, received);
        }

        var sha = Convert.ToHexStringLower(hash.GetHashAndReset());
        if (!string.Equals(sha, request.Sha256, StringComparison.OrdinalIgnoreCase))
        {
            throw new ReleaseRefusedException($"{request.AssetName} arrived with SHA-256 {sha}, not the {request.Sha256.ToLowerInvariant()} GitHub reports. Nothing was loaded.");
        }
    }

    private static ReleaseRefusedException SizeRefusal(StackReleaseImageRequest request, long size) =>
        new($"{request.AssetName} is {size} bytes, not the {request.Size} bytes GitHub reports (its size differs). Nothing was loaded.");

    private static string AssetApi(StackReleaseImageRequest request) =>
        $"{ApiBase}/repos/{request.Repository}/releases/assets/{request.AssetId.ToString(System.Globalization.CultureInfo.InvariantCulture)}";

    private static HttpRequestMessage Api(HttpMethod method, string url, string accept, string? token)
    {
        var message = new HttpRequestMessage(method, url);
        message.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue(accept));
        message.Headers.Add("X-GitHub-Api-Version", "2022-11-28");
        if (token is not null)
        {
            message.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        }

        return message;
    }

    private static async Task<HttpResponseMessage> SendAsync(HttpClient client, HttpRequestMessage request, CancellationToken cancellationToken)
    {
        try
        {
            return await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        }
        catch (HttpRequestException)
        {
            throw new ReleaseRefusedException("The server could not reach GitHub. Check that it can open HTTPS connections to github.com.");
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new ReleaseRefusedException("GitHub did not answer in time.");
        }
    }

    private static void Refuse(HttpResponseMessage answer, StackReleaseImageRequest request, string? token)
    {
        if (answer.IsSuccessStatusCode)
        {
            return;
        }

        if (answer.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            throw new ReleaseRefusedException(token is null
                ? $"The server has no access to the releases of {request.Repository}. Give it access: sign in to GitHub on this computer, or store a read-only token for the repository on the server."
                : $"The token stored on the server for {request.Repository} cannot read its releases any more. Give it access again with a new token.");
        }

        throw new ReleaseRefusedException($"GitHub answered {(int)answer.StatusCode} about {request.AssetName}. Try again in a moment.");
    }
}
