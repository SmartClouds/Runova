using System.Collections.Concurrent;
using System.Formats.Tar;
using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Releases;
using Runova.ServerCore.Security;
using Runova.ServerCore.Tests.CoreUpdates;

namespace Runova.ServerCore.Tests.Stacks;

/// <summary>
/// GitHub Release images (E105): the core downloads the asset itself, from a signed link the app
/// passes once or with a token stored for the repository, checks its size and SHA-256 against
/// what GitHub reports, loads it into Docker and deploys without pulling it. A link that leads
/// anywhere but GitHub's asset hosts, or an asset that arrives different, never reaches Docker,
/// and the signed link is in no answer, log, audit entry or file.
/// </summary>
public sealed class StackReleaseImageTests
{
    private const string Repository = "acme/shop";

    private const long AssetId = 77;

    private const string AssetName = "shop-image.tar.gz";

    private const string Signature = "sig-5f1c0ffee-very-secret";

    private const string StoredToken = "github_pat_stored_release_token_123";

    private const string Compose = """
        services:
          web:
            build: .
            image: acme/shop:1.4.0
            restart: unless-stopped
            ports:
              - "8080:80"
          db:
            image: postgres:17
            restart: unless-stopped
        """;

    private static readonly string _signedLink = $"https://release-assets.githubusercontent.com/github-production-release-asset/1/77?sp=r&sig={Signature}";

    private static CancellationToken Cancel => StackKit.Cancel;

    /// <summary>A docker save archive as GitHub serves it: a gzipped tar with a manifest naming its image.</summary>
    private static byte[] ImageArchive(params string[] tags)
    {
        using var buffer = new MemoryStream();
        using (var gzip = new GZipStream(buffer, CompressionLevel.Fastest, leaveOpen: true))
        using (var writer = new TarWriter(gzip, TarEntryFormat.Pax, leaveOpen: true))
        {
            var manifest = $"[{{\"Config\":\"config.json\",\"RepoTags\":[{string.Join(',', tags.Select(t => $"\"{t}\""))}],\"Layers\":[]}}]";
            writer.WriteEntry(new PaxTarEntry(TarEntryType.RegularFile, "manifest.json") { DataStream = new MemoryStream(Encoding.UTF8.GetBytes(manifest)) });
            writer.WriteEntry(new PaxTarEntry(TarEntryType.RegularFile, "config.json") { DataStream = new MemoryStream("{}"u8.ToArray()) });
        }

        return buffer.ToArray();
    }

    private static string Sha(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    /// <summary>GitHub's API and asset host as the core's download sees them.</summary>
    private sealed class FakeReleases : HttpMessageHandler
    {
        public byte[] Asset { get; set; } = ImageArchive("acme/shop:1.4.0");

        /// <summary>The digest the API reports; null reports the asset's own.</summary>
        public string? Digest { get; set; }

        public bool Private { get; set; } = true;

        public ConcurrentQueue<(string Url, string? Authorization, string? Accept)> Requests { get; } = new();

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var url = request.RequestUri!.ToString();
            var authorization = request.Headers.Authorization?.ToString();
            var accept = string.Join(',', request.Headers.Accept.Select(a => a.MediaType));
            Requests.Enqueue((url, authorization, accept));
            var signedIn = authorization == $"Bearer {StoredToken}";
            if (request.RequestUri.Host == "api.github.com" && request.RequestUri.AbsolutePath == $"/repos/{Repository}/releases/assets/{AssetId}")
            {
                if (Private && !signedIn)
                {
                    return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound) { Content = new StringContent("{\"message\":\"Not Found\"}") });
                }

                if (accept.Contains("application/octet-stream", StringComparison.Ordinal))
                {
                    var redirect = new HttpResponseMessage(HttpStatusCode.Found);
                    redirect.Headers.Location = new Uri(_signedLink);
                    return Task.FromResult(redirect);
                }

                var json = $"{{\"id\":{AssetId},\"name\":\"{AssetName}\",\"size\":{Asset.Length},\"state\":\"uploaded\",\"digest\":\"sha256:{Digest ?? Sha(Asset)}\"}}";
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") });
            }

            if (url == _signedLink)
            {
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Asset) });
            }

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
        }
    }

    private static async Task<(StackKit Kit, FakeReleases GitHub, StackInfo Stack, StackRevisionInfo Revision)> AwaitingAsync()
    {
        var github = new FakeReleases();
        var kit = await StackKit.CreateAsync(CoreRoles.Operator, (services, _) => services.AddSingleton<IHttpClientFactory>(new FakeHttpClients(github)));
        var stack = await kit.CreateStackAsync();
        var revision = await kit.UploadAsync(stack.Id, StackKit.Upload(Compose, proxied: ["web"]) with { ImageSource = StackImageSource.GithubRelease });
        return (kit, github, stack, revision);
    }

    private static StackReleaseImageRequest Request(byte[] asset, string? link = null, long? size = null, string? sha = null) =>
        new(Repository, "v1.4.0", AssetId, AssetName, size ?? asset.LongLength, sha ?? Sha(asset), link);

    private static async Task<string> RefusalOf(HttpResponseMessage response) =>
        (await response.Content.ReadFromJsonAsync<StackUploadError>(CoreJson.Options, Cancel))!.Message;

    private static InMemoryDockerEngine Engine(StackKit kit) => kit.Harness.Services.GetRequiredService<InMemoryDockerEngine>();

    private static async Task<bool> HasImageAsync(StackKit kit, string tag) =>
        (await Engine(kit).ListImagesAsync(Cancel)).Any(image => image.Tags.Contains(tag));

    [Fact]
    public async Task A_signed_link_loads_the_image_and_the_deploy_pulls_only_what_the_release_does_not_bring()
    {
        var (kit, github, stack, revision) = await AwaitingAsync();
        await using var _ = kit;

        using var response = await kit.PostReleaseImageAsync(stack.Id, revision.Number, Request(github.Asset, _signedLink));
        var body = await response.Content.ReadAsStringAsync(Cancel);
        var ready = (await response.Content.ReadFromJsonAsync<StackRevisionInfo>(CoreJson.Options, Cancel))!;
        var (job, log) = await kit.RunAsync(await kit.DeployAsync(stack.Id, revision.Number));

        Assert.Equal(StackRevisionState.AwaitingImage, revision.State);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(StackRevisionState.Ready, ready.State);
        Assert.Equal(StackImageSource.GithubRelease, ready.ImageSource);
        Assert.Equal(["acme/shop:1.4.0"], ready.ReleaseImage!.Images);
        Assert.Equal(Sha(github.Asset), ready.ReleaseImage.Sha256);
        Assert.True(await HasImageAsync(kit, "acme/shop:1.4.0"));
        Assert.Equal(JobState.Succeeded, job.State);
        Assert.Contains("site pull db", kit.Simulated.Calls);
        Assert.DoesNotContain(kit.Simulated.Calls, call => call.StartsWith("site build", StringComparison.Ordinal));
        var request = Assert.Single(github.Requests);
        Assert.Equal(_signedLink, request.Url);
        Assert.Null(request.Authorization);

        // The link was used once and kept nowhere.
        Assert.DoesNotContain(Signature, body, StringComparison.Ordinal);
        Assert.DoesNotContain(log, line => line.Text.Contains(Signature, StringComparison.Ordinal));
        Assert.DoesNotContain(await kit.AuditAsync(), e => (e.Parameters ?? string.Empty).Contains(Signature, StringComparison.Ordinal));
        Assert.Contains(await kit.AuditAsync(), e => e.Action == "stack.release-image" && e.Result == "success");
        foreach (var file in Directory.EnumerateFiles(kit.DataDirectory, "*", SearchOption.AllDirectories))
        {
            using var open = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var bytes = new MemoryStream();
            await open.CopyToAsync(bytes, Cancel);
            Assert.False(bytes.ToArray().AsSpan().IndexOf(Encoding.UTF8.GetBytes(Signature)) >= 0, file);
            Assert.False(file.EndsWith(".download", StringComparison.Ordinal), file);
        }
    }

    [Fact]
    public async Task An_asset_whose_size_or_sha256_differs_from_what_github_reports_never_reaches_docker()
    {
        var (kit, github, stack, revision) = await AwaitingAsync();
        await using var _ = kit;

        using var wrongSize = await kit.PostReleaseImageAsync(stack.Id, revision.Number, Request(github.Asset, _signedLink, size: github.Asset.Length - 1));
        using var wrongSha = await kit.PostReleaseImageAsync(stack.Id, revision.Number, Request(github.Asset, _signedLink, sha: new string('0', 64)));

        Assert.Equal(HttpStatusCode.BadRequest, wrongSize.StatusCode);
        Assert.Contains("size", await RefusalOf(wrongSize), StringComparison.OrdinalIgnoreCase);
        Assert.Equal(HttpStatusCode.BadRequest, wrongSha.StatusCode);
        Assert.Contains("SHA-256", await RefusalOf(wrongSha), StringComparison.Ordinal);
        Assert.False(await HasImageAsync(kit, "acme/shop:1.4.0"));
        Assert.Equal(StackRevisionState.AwaitingImage, (await kit.GetAsync(stack.Id)).Revisions[0].State);
        Assert.Equal(2, (await kit.AuditAsync()).Count(e => e.Action == "stack.release-image" && e.Result == "denied"));
    }

    public static TheoryData<string> Elsewhere() =>
    [
        "http://release-assets.githubusercontent.com/x?sig=1",
        "https://169.254.169.254/latest/meta-data/",
        "https://evil.example.com/asset.tar.gz",
        "https://githubusercontent.com.evil.example.com/a",
        "file:///etc/shadow",
    ];

    [Theory]
    [MemberData(nameof(Elsewhere))]
    public async Task A_link_anywhere_but_githubs_asset_hosts_is_refused_without_a_request(string link)
    {
        var (kit, github, stack, revision) = await AwaitingAsync();
        await using var _ = kit;

        using var response = await kit.PostReleaseImageAsync(stack.Id, revision.Number, Request(github.Asset, link));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.DoesNotContain(link, await response.Content.ReadAsStringAsync(Cancel), StringComparison.Ordinal);
        Assert.Empty(github.Requests);
    }

    [Fact]
    public async Task Without_a_link_the_stored_token_checks_the_asset_with_github_and_never_follows_the_redirect_with_it()
    {
        var (kit, github, stack, revision) = await AwaitingAsync();
        await using var _ = kit;
        await kit.Harness.Services.GetRequiredService<ReleaseTokens>().SaveAsync(Repository, StoredToken, "alice", Cancel);

        using var response = await kit.PostReleaseImageAsync(stack.Id, revision.Number, Request(github.Asset));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True(await HasImageAsync(kit, "acme/shop:1.4.0"));
        var requests = github.Requests.ToList();
        Assert.All(requests.Where(r => r.Url.StartsWith("https://api.github.com/", StringComparison.Ordinal)), r => Assert.Equal($"Bearer {StoredToken}", r.Authorization));
        Assert.Null(requests.Single(r => r.Url == _signedLink).Authorization);
        Assert.DoesNotContain(StoredToken, await response.Content.ReadAsStringAsync(Cancel), StringComparison.Ordinal);
    }

    [Fact]
    public async Task An_asset_github_describes_differently_from_the_request_is_refused_before_the_download()
    {
        var (kit, github, stack, revision) = await AwaitingAsync();
        await using var _ = kit;
        await kit.Harness.Services.GetRequiredService<ReleaseTokens>().SaveAsync(Repository, StoredToken, "alice", Cancel);
        github.Digest = new string('1', 64);

        using var response = await kit.PostReleaseImageAsync(stack.Id, revision.Number, Request(github.Asset));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.DoesNotContain(github.Requests, r => r.Url == _signedLink);
        Assert.False(await HasImageAsync(kit, "acme/shop:1.4.0"));
    }

    [Fact]
    public async Task A_public_release_downloads_without_any_token_and_a_private_one_says_how_to_give_access()
    {
        var (kit, github, stack, revision) = await AwaitingAsync();
        await using var _ = kit;

        using var refused = await kit.PostReleaseImageAsync(stack.Id, revision.Number, Request(github.Asset));
        github.Private = false;
        using var loaded = await kit.PostReleaseImageAsync(stack.Id, revision.Number, Request(github.Asset));

        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
        Assert.Contains("access", await RefusalOf(refused), StringComparison.OrdinalIgnoreCase);
        Assert.Equal(HttpStatusCode.OK, loaded.StatusCode);
        Assert.All(github.Requests, r => Assert.Null(r.Authorization));
    }

    /// <summary>A gzipped tar with exactly these entries, for archives docker save never writes.</summary>
    private static byte[] RawArchive(params (string Name, string Content)[] entries)
    {
        using var buffer = new MemoryStream();
        using (var gzip = new GZipStream(buffer, CompressionLevel.Fastest, leaveOpen: true))
        using (var writer = new TarWriter(gzip, TarEntryFormat.Pax, leaveOpen: true))
        {
            foreach (var (name, content) in entries)
            {
                writer.WriteEntry(new PaxTarEntry(TarEntryType.RegularFile, name) { DataStream = new MemoryStream(Encoding.UTF8.GetBytes(content)) });
            }
        }

        return buffer.ToArray();
    }

    private static string Manifest(params string[] tags) =>
        $"[{{\"Config\":\"config.json\",\"RepoTags\":[{string.Join(',', tags.Select(t => $"\"{t}\""))}],\"Layers\":[]}}]";

    /// <summary>
    /// Docker applies every name an archive carries to the one engine all apps share, moving a tag
    /// another app runs onto this image. So every name has to be one of this app's images, in each
    /// place a loader reads names from, not just one of them.
    /// </summary>
    public static TheoryData<string, string, string> ArchivesNamingAnotherImage => new()
    {
        { "a second tag", "two-tags", "nginx:latest" },
        { "a second manifest.json", "two-manifests", "more than one manifest.json" },
        { "a name in index.json", "index-name", "docker.io/library/nginx:latest" },
    };

    [Theory]
    [MemberData(nameof(ArchivesNamingAnotherImage))]
    public async Task An_archive_that_also_names_an_image_this_app_does_not_use_is_refused(string what, string shape, string said)
    {
        var (kit, github, stack, revision) = await AwaitingAsync();
        await using var _ = kit;
        github.Asset = shape switch
        {
            "two-tags" => ImageArchive("acme/shop:1.4.0", "nginx:latest"),
            "two-manifests" => RawArchive(("manifest.json", Manifest("acme/shop:1.4.0")), ("config.json", "{}"), ("manifest.json", Manifest("nginx:latest"))),
            _ => RawArchive(
                ("manifest.json", Manifest("acme/shop:1.4.0")),
                ("config.json", "{}"),
                ("index.json", """{"schemaVersion":2,"manifests":[{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"sha256:00","size":1,"annotations":{"io.containerd.image.name":"docker.io/library/nginx:latest","org.opencontainers.image.ref.name":"latest"}}]}""")),
        };
        var loads = kit.Simulated.Calls.Count(call => call.Contains("load", StringComparison.Ordinal));

        using var response = await kit.PostReleaseImageAsync(stack.Id, revision.Number, Request(github.Asset, _signedLink));

        Assert.True(response.StatusCode == HttpStatusCode.BadRequest, what);
        Assert.Contains(said, await RefusalOf(response), StringComparison.Ordinal);
        Assert.Equal(loads, kit.Simulated.Calls.Count(call => call.Contains("load", StringComparison.Ordinal)));
    }

    [Fact]
    public async Task A_current_docker_save_archive_with_its_index_json_reads_as_the_one_image()
    {
        // The layout today's docker save writes: index.json first, naming the image in full.
        var archive = RawArchive(
            ("index.json", """{"schemaVersion":2,"manifests":[{"digest":"sha256:00","size":1,"annotations":{"io.containerd.image.name":"docker.io/acme/shop:1.4.0","org.opencontainers.image.ref.name":"1.4.0"}}]}"""),
            ("manifest.json", Manifest("acme/shop:1.4.0")),
            ("config.json", "{}"));

        var names = await Runova.ServerCore.Releases.ReleaseArchive.ReadTagsAsync(new MemoryStream(archive), Cancel);

        Assert.Equal(["docker.io/acme/shop:1.4.0", "acme/shop:1.4.0"], names);
        Assert.All(names, name => Assert.True(Runova.ServerCore.Releases.ReleaseNames.SameImage(name, "acme/shop:1.4.0")));
    }

    [Fact]
    public async Task An_archive_that_names_no_image_the_compose_file_uses_is_refused()
    {
        var (kit, github, stack, revision) = await AwaitingAsync();
        await using var _ = kit;
        github.Asset = ImageArchive("acme/other:2.0.0");

        using var response = await kit.PostReleaseImageAsync(stack.Id, revision.Number, Request(github.Asset, _signedLink));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("acme/other:2.0.0", await RefusalOf(response), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_revision_that_does_not_wait_for_a_release_image_refuses_one()
    {
        var github = new FakeReleases();
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator, (services, _) => services.AddSingleton<IHttpClientFactory>(new FakeHttpClients(github)));
        var stack = await kit.CreateStackAsync();
        var revision = await kit.UploadAsync(stack.Id, StackKit.Upload());

        using var response = await kit.PostReleaseImageAsync(stack.Id, revision.Number, Request(github.Asset, _signedLink));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Empty(github.Requests);
    }

    [Fact]
    public async Task A_revision_copied_on_the_server_or_rolled_back_to_keeps_its_release_image_and_never_builds()
    {
        var (kit, github, stack, revision) = await AwaitingAsync();
        await using var _ = kit;
        using var loaded = await kit.PostReleaseImageAsync(stack.Id, revision.Number, Request(github.Asset, _signedLink));
        await kit.RunAsync(await kit.DeployAsync(stack.Id, revision.Number));

        var revised = await kit.Hub.InvokeAsync<StackRevisionInfo>(nameof(ICoreHub.ReviseStack), new ReviseStackRequest(stack.Id, revision.Number, ["web"]), Cancel);
        var (revisedJob, _revisedLog) = await kit.RunAsync(await kit.DeployAsync(stack.Id, revised.Number));
        var (rollbackJob, _rollbackLog) = await kit.RunAsync(await kit.Hub.InvokeAsync<JobInfo>(nameof(ICoreHub.RollbackStack), new StackRevisionRef(stack.Id, revision.Number), Cancel));
        var revisions = (await kit.GetAsync(stack.Id)).Revisions;

        Assert.Equal(JobState.Succeeded, revisedJob.State);
        Assert.Equal(JobState.Succeeded, rollbackJob.State);
        Assert.Equal(3, revisions.Length);
        Assert.All(revisions, r => Assert.Equal(StackImageSource.GithubRelease, r.ImageSource));
        Assert.All(revisions, r => Assert.Equal(["acme/shop:1.4.0"], r.ReleaseImage!.Images));
        Assert.Equal(3, kit.Simulated.Calls.Count(call => call == "site pull db"));
        Assert.DoesNotContain(kit.Simulated.Calls, call => call.StartsWith("site build", StringComparison.Ordinal));
    }

    [Fact]
    public void The_request_never_prints_its_link()
    {
        var request = Request(ImageArchive("acme/shop:1.4.0"), _signedLink);

        Assert.DoesNotContain(Signature, request.ToString(), StringComparison.Ordinal);
    }
}
