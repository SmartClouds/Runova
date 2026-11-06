using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Runova.Website.Api.Dependencies;
using Runova.Website.Data.Identity;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>Accounts, teams and package inventories for the dependency alert tests (E51).</summary>
internal static class TestDependencies
{
    public static object Package(string name, string version, string ecosystem = "npm", bool dev = false) =>
        new { ecosystem, name, version, dev };

    public static object Inventory(string projectName, params object[] packages) => new { projectName, packages };

    public static async Task<(AppUser User, ApiClient Client)> AccountAsync(WebsiteApiFactory factory, string name = "Sam")
    {
        var user = await TestAccounts.CreateAsync(factory.Services, name);
        return (user, await TestAccounts.SignedInClientAsync(factory, user));
    }

    public static async Task<long> PersonalScopeAsync(ApiClient client)
    {
        var scopes = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/sync-scopes"), HttpStatusCode.OK);
        return scopes.GetProperty("items").EnumerateArray().Single(s => s.GetProperty("kind").GetString() == "personal").GetProperty("id").GetInt64();
    }

    public static async Task<long> CreateTeamAsync(ApiClient owner, string name = "Platform")
    {
        var team = await ApiClient.ReadJsonAsync(await owner.SendAsync(HttpMethod.Post, "/api/v1/teams", new { name }), HttpStatusCode.Created);
        return team.GetProperty("id").GetInt64();
    }

    /// <summary>Invites the account to the team and accepts as it.</summary>
    public static async Task JoinAsync(ApiClient owner, long teamId, AppUser member, ApiClient memberClient, string role = "member")
    {
        var invited = await owner.SendAsync(HttpMethod.Post, $"/api/v1/teams/{teamId}/invitations", new { email = member.Email, role });
        Assert.Equal(HttpStatusCode.Created, invited.StatusCode);
        var pending = await ApiClient.ReadJsonAsync(await memberClient.GetAsync("/api/v1/invitations"), HttpStatusCode.OK);
        var invitation = pending.GetProperty("items").EnumerateArray().Single(i => i.GetProperty("teamId").GetInt64() == teamId);
        var accepted = await memberClient.SendAsync(HttpMethod.Post, $"/api/v1/invitations/{invitation.GetProperty("id").GetInt64()}/acceptances");
        Assert.Equal(HttpStatusCode.Created, accepted.StatusCode);
    }

    public static async Task<long> TeamScopeAsync(ApiClient client, long teamId)
    {
        var scopes = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/sync-scopes"), HttpStatusCode.OK);
        return scopes.GetProperty("items").EnumerateArray()
            .Single(s => s.GetProperty("teamId").ValueKind == JsonValueKind.Number && s.GetProperty("teamId").GetInt64() == teamId)
            .GetProperty("id").GetInt64();
    }

    public static Task<HttpResponseMessage> UploadAsync(ApiClient client, long scopeId, string itemId, object inventory) =>
        client.SendAsync(HttpMethod.Put, $"/api/v1/sync-scopes/{scopeId}/package-inventories/{itemId}", inventory);

    /// <summary>Uploads and returns the inventory's id.</summary>
    public static async Task<long> UploadedAsync(ApiClient client, long scopeId, string itemId, object inventory)
    {
        var response = await UploadAsync(client, scopeId, itemId, inventory);
        Assert.True(response.StatusCode is HttpStatusCode.Created or HttpStatusCode.OK, await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
        var body = await ApiClient.ReadJsonAsync(response, response.StatusCode);
        return body.GetProperty("id").GetInt64();
    }

    /// <summary>Runs the daily check once, as Hangfire would.</summary>
    public static async Task RunChecksAsync(WebsiteApiFactory factory)
    {
        using var scope = factory.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<DependencyCheckJob>().RunAsync(TestContext.Current.CancellationToken);
    }

    /// <summary>Signs the desktop app in for the account, as the browser approval and code trade do, and returns its access token.</summary>
    public static async Task<string> DeviceTokenAsync(WebsiteApiFactory factory, ApiClient browser)
    {
        static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        const string redirect = "http://127.0.0.1:53111/callback";
        var verifier = Base64Url(RandomNumberGenerator.GetBytes(32));
        var challenge = Base64Url(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
        var approval = await ApiClient.ReadJsonAsync(
            await browser.SendAsync(HttpMethod.Post, "/api/v1/device-authorizations", new
            {
                clientId = "runova-desktop",
                redirectUri = redirect,
                codeChallenge = challenge,
                codeChallengeMethod = "S256",
                state = "state-1234567890",
                deviceName = "Sam's laptop",
                platform = "windows",
                appVersion = "3.4.0",
                deviceId = Guid.NewGuid(),
            }),
            HttpStatusCode.Created);
        var code = System.Web.HttpUtility.ParseQueryString(new Uri(approval.GetProperty("redirectUrl").GetString()!).Query)["code"]!;
        var tokens = await factory.CreateClient().PostAsJsonAsync(
            "/api/v1/device-tokens",
            new { grantType = "authorization_code", code, codeVerifier = verifier, redirectUri = redirect, refreshToken = (string?)null },
            TestContext.Current.CancellationToken);
        return (await ApiClient.ReadJsonAsync(tokens, HttpStatusCode.OK)).GetProperty("accessToken").GetString()!;
    }
}
