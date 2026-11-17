using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Releases;
using Runova.ServerCore.Security;
using Runova.ServerCore.Tests.CoreUpdates;
using Runova.ServerCore.Tests.Stacks;

namespace Runova.ServerCore.Tests.Releases;

/// <summary>
/// Tokens for GitHub Release images stored on the server (E105 T5): Admins with a recent step-up
/// store one per repository after GitHub confirms it reads the releases, nobody reads it back,
/// and the row is useless without the core's Data Protection keys. Operators can ask how the
/// server reads a repository's releases on its own.
/// </summary>
public sealed class ReleaseTokenTests
{
    private const string Token = "github_pat_11ABCDEFG0123456789_releaseReadOnly";

    private static CancellationToken Cancel => StackKit.Cancel;

    /// <summary>GitHub answering the releases list: public repositories to anyone, private ones to the token.</summary>
    private sealed class FakeGitHubApi : HttpMessageHandler
    {
        public HashSet<string> Public { get; } = new(StringComparer.OrdinalIgnoreCase);

        public List<(string Url, string? Authorization)> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var authorization = request.Headers.Authorization?.ToString();
            lock (Requests)
            {
                Requests.Add((request.RequestUri!.ToString(), authorization));
            }

            var path = request.RequestUri!.AbsolutePath;
            var repository = path.StartsWith("/repos/", StringComparison.Ordinal) ? string.Join('/', path.Split('/')[2..4]) : string.Empty;
            var allowed = Public.Contains(repository) || authorization == $"Bearer {Token}";
            return Task.FromResult(allowed
                ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("[]", Encoding.UTF8, "application/json") }
                : new HttpResponseMessage(HttpStatusCode.NotFound) { Content = new StringContent("{\"message\":\"Not Found\"}") });
        }
    }

    private static async Task<(StackKit Kit, FakeGitHubApi GitHub)> KitAsync(string role)
    {
        var github = new FakeGitHubApi();
        var kit = await StackKit.CreateAsync(role, (services, _) => services.AddSingleton<IHttpClientFactory>(new FakeHttpClients(github)));
        return (kit, github);
    }

    private static Task<StepUpResponse> StepUpAsync(StackKit kit) =>
        kit.Hub.InvokeAsync<StepUpResponse>(nameof(ICoreHub.StepUp), new StepUpRequest(AuthHarness.Password), Cancel);

    private static Task<ReleaseTokenInfo> SaveAsync(StackKit kit, string repository = "Acme/Shop", string token = Token) =>
        kit.Hub.InvokeAsync<ReleaseTokenInfo>(nameof(ICoreHub.SaveReleaseToken), new SaveReleaseTokenRequest(repository, token), Cancel);

    private static Task<ReleaseTokenInfo[]> ListAsync(StackKit kit) =>
        kit.Hub.InvokeAsync<ReleaseTokenInfo[]>(nameof(ICoreHub.ListReleaseTokens), Cancel);

    private static Task<ReleaseAccessCheck> CheckAsync(StackKit kit, string repository = "acme/shop") =>
        kit.Hub.InvokeAsync<ReleaseAccessCheck>(nameof(ICoreHub.CheckReleaseAccess), repository, Cancel);

    [Fact]
    public async Task An_admin_stores_a_token_github_accepts_after_a_step_up_and_never_gets_it_back()
    {
        var (kit, github) = await KitAsync(CoreRoles.Admin);
        await using var _ = kit;

        var withoutStepUp = await Assert.ThrowsAsync<HubException>(() => SaveAsync(kit));
        await StepUpAsync(kit);
        var saved = await SaveAsync(kit);
        var listed = await ListAsync(kit);

        Assert.Contains("unauthorized", withoutStepUp.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(("acme/shop", "maria"), (saved.Repository, saved.CreatedBy));
        Assert.Equal(saved.Id, Assert.Single(listed).Id);
        Assert.Contains(github.Requests, r => r.Url.StartsWith("https://api.github.com/repos/Acme/Shop/releases", StringComparison.OrdinalIgnoreCase) && r.Authorization == $"Bearer {Token}");
        Assert.DoesNotContain(Token, JsonSerializer.Serialize(listed, CoreJson.Options), StringComparison.Ordinal);
        Assert.DoesNotContain(Token, JsonSerializer.Serialize(saved, CoreJson.Options), StringComparison.Ordinal);
        var audit = await kit.AuditAsync();
        Assert.Contains(audit, e => e.Action == "release.token-save" && e.Result == "success" && e.Target == "acme/shop");
        Assert.All(audit, e => Assert.DoesNotContain(Token, e.Parameters ?? string.Empty, StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_token_github_refuses_for_the_repository_is_not_stored()
    {
        var (kit, _) = await KitAsync(CoreRoles.Admin);
        await using var __ = kit;
        await StepUpAsync(kit);

        var refused = await Assert.ThrowsAsync<HubException>(() => SaveAsync(kit, token: "github_pat_wrong_token_for_this_repo"));
        var malformed = await Assert.ThrowsAsync<HubException>(() => SaveAsync(kit, repository: "not a repository"));

        Assert.Contains("Contents", refused.Message, StringComparison.Ordinal);
        Assert.Contains("owner/name", malformed.Message, StringComparison.Ordinal);
        Assert.Empty(await ListAsync(kit));
        Assert.Equal(2, (await kit.AuditAsync()).Count(e => e.Action == "release.token-save" && e.Result == "denied"));
    }

    [Fact]
    public async Task Saving_again_replaces_the_token_and_removing_needs_the_step_up_too()
    {
        var (kit, _) = await KitAsync(CoreRoles.Owner);
        await using var __ = kit;
        await StepUpAsync(kit);

        var first = await SaveAsync(kit);
        var second = await SaveAsync(kit, repository: "acme/shop");
        await kit.Hub.InvokeAsync(nameof(ICoreHub.DeleteReleaseToken), second.Id, Cancel);

        Assert.Equal(first.Id, second.Id);
        Assert.Empty(await ListAsync(kit));
        var missing = await Assert.ThrowsAsync<HubException>(() => kit.Hub.InvokeAsync(nameof(ICoreHub.DeleteReleaseToken), second.Id, Cancel));
        Assert.Contains("no such", missing.Message, StringComparison.Ordinal);
        Assert.Contains(await kit.AuditAsync(), e => e.Action == "release.token-delete" && e.Target == "acme/shop");
    }

    [Fact]
    public async Task Operators_see_the_list_and_check_access_but_cannot_store_or_remove()
    {
        var (kit, github) = await KitAsync(CoreRoles.Operator);
        await using var _ = kit;
        await StepUpAsync(kit);
        github.Public.Add("acme/site");

        var none = await CheckAsync(kit);
        var open = await CheckAsync(kit, "acme/site");

        Assert.Empty(await ListAsync(kit));
        Assert.Equal(ReleaseAccess.None, none.Access);
        Assert.Contains("token", none.Message, StringComparison.Ordinal);
        Assert.Equal(ReleaseAccess.Public, open.Access);
        await Assert.ThrowsAsync<HubException>(() => SaveAsync(kit));
        await Assert.ThrowsAsync<HubException>(() => kit.Hub.InvokeAsync(nameof(ICoreHub.DeleteReleaseToken), Guid.NewGuid(), Cancel));
    }

    [Fact]
    public async Task With_a_stored_token_the_check_says_the_server_reads_the_releases_with_it()
    {
        var (kit, _) = await KitAsync(CoreRoles.Admin);
        await using var __ = kit;
        await StepUpAsync(kit);
        var saved = await SaveAsync(kit);

        var check = await CheckAsync(kit, "ACME/shop");

        Assert.Equal(ReleaseAccess.StoredToken, check.Access);
        Assert.Equal(saved.Id, check.Token!.Id);
        Assert.NotNull(Assert.Single(await ListAsync(kit)).LastUsedAtUnixMs);
    }

    [Fact]
    public async Task Viewers_do_not_even_see_the_list()
    {
        var (kit, _) = await KitAsync(CoreRoles.Viewer);
        await using var __ = kit;

        await Assert.ThrowsAsync<HubException>(() => ListAsync(kit));
        await Assert.ThrowsAsync<HubException>(() => CheckAsync(kit));
    }

    [Fact]
    public async Task The_raw_row_is_sealed_and_unreadable_without_the_cores_keys()
    {
        var (kit, _) = await KitAsync(CoreRoles.Admin);
        await using var __ = kit;
        await StepUpAsync(kit);
        await SaveAsync(kit);

        ReleaseTokenRecord row;
        await using (var scope = kit.Harness.Services.CreateAsyncScope())
        {
            row = await scope.ServiceProvider.GetRequiredService<CoreDbContext>().ReleaseTokens.AsNoTracking().SingleAsync(Cancel);
        }

        var sealedBytes = Convert.FromBase64String(row.SealedToken);
        var elsewhere = DataProtectionProvider.Create(new DirectoryInfo(Path.Combine(kit.DataDirectory, "other-keys"))).CreateProtector(ReleaseTokens.Purpose);
        var ours = kit.Harness.Services.GetRequiredService<IDataProtectionProvider>().CreateProtector(ReleaseTokens.Purpose);

        Assert.DoesNotContain(Token, row.SealedToken, StringComparison.Ordinal);
        Assert.True(sealedBytes.AsSpan().IndexOf(Encoding.UTF8.GetBytes(Token)) < 0);
        Assert.ThrowsAny<System.Security.Cryptography.CryptographicException>(() => elsewhere.Unprotect(sealedBytes));
        Assert.Equal(Token, Encoding.UTF8.GetString(ours.Unprotect(sealedBytes)));
    }

    [Fact]
    public void The_request_never_prints_its_token()
    {
        Assert.DoesNotContain(Token, new SaveReleaseTokenRequest("acme/shop", Token).ToString(), StringComparison.Ordinal);
    }
}
