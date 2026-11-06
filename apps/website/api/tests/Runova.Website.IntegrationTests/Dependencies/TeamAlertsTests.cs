using System.Net;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.Api.Dependencies;
using Runova.Website.IntegrationTests.Infrastructure;
using static Runova.Website.IntegrationTests.Infrastructure.TestDependencies;

namespace Runova.Website.IntegrationTests.Dependencies;

/// <summary>A team's project tells every member, each by their own settings.</summary>
public sealed class TeamAlertsTests(PostgresFixture postgres) : IAsyncLifetime
{
    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 11, 6, 9, 0, 0, TimeSpan.Zero));
    private readonly FakePackageRegistries _registries = new();
    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync()
    {
        _factory = new WebsiteApiFactory(await postgres.CreateDatabaseAsync(), time: _time, services: services =>
        {
            _registries.Register(services);
            services.AddSingleton<CheckSchedule>(new FixedSchedule(_time));
        });
        _registries
            .Has("npm", "express", "5.0.0")
            .Advisory("GHSA-rv95-896h-c2vc", "npm", "express", "critical", "Open redirect", "4.19.2", "4.18.0");
    }

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    private static async Task<JsonElement[]> NotificationsAsync(ApiClient client) =>
        [.. (await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/notifications"), HttpStatusCode.OK)).GetProperty("items").EnumerateArray()];

    [Fact]
    public async Task Every_member_and_viewer_is_told_by_their_own_settings()
    {
        var (_, owner) = await AccountAsync(_factory);
        var (kim, kimClient) = await AccountAsync(_factory, "Kim");
        var (lee, leeClient) = await AccountAsync(_factory, "Lee");
        var (_, stranger) = await AccountAsync(_factory, "Ray");
        var team = await CreateTeamAsync(owner);
        await JoinAsync(owner, team, kim, kimClient);
        await JoinAsync(owner, team, lee, leeClient, "viewer");
        var scope = await TeamScopeAsync(owner, team);
        var settings = await kimClient.GetAsync("/api/v1/accounts/me/dependency-alert-settings");
        await kimClient.SendAsync(HttpMethod.Patch, "/api/v1/accounts/me/dependency-alert-settings", new { major = false }, ifMatch: settings.Headers.ETag!.Tag);
        await UploadedAsync(kimClient, scope, "p-api", Inventory("Api", Package("express", "4.18.0")));
        _time.Advance(TimeSpan.FromHours(1));

        await RunChecksAsync(_factory);

        Assert.Equal("2 package updates for Api", Assert.Single(await NotificationsAsync(owner)).GetProperty("title").GetString());
        Assert.Equal("Security fix for express in Api", Assert.Single(await NotificationsAsync(kimClient)).GetProperty("title").GetString());
        Assert.Single(await NotificationsAsync(leeClient));
        Assert.Empty(await NotificationsAsync(stranger));
        var leeSees = await ApiClient.ReadJsonAsync(await leeClient.GetAsync("/api/v1/dependency-findings"), HttpStatusCode.OK);
        Assert.Equal(scope, leeSees.GetProperty("items")[0].GetProperty("scopeId").GetInt64());
    }

    [Fact]
    public async Task A_removed_member_hears_nothing_more()
    {
        var (_, owner) = await AccountAsync(_factory);
        var (kim, kimClient) = await AccountAsync(_factory, "Kim");
        var team = await CreateTeamAsync(owner);
        await JoinAsync(owner, team, kim, kimClient);
        var scope = await TeamScopeAsync(owner, team);
        await UploadedAsync(owner, scope, "p-api", Inventory("Api", Package("express", "4.18.0")));

        var removed = await owner.SendAsync(HttpMethod.Delete, $"/api/v1/teams/{team}/members/{kim.Id}", new { password = TestAccounts.Password, code = (string?)null });
        Assert.Equal(HttpStatusCode.NoContent, removed.StatusCode);
        _time.Advance(TimeSpan.FromHours(1));
        await RunChecksAsync(_factory);

        Assert.Single(await NotificationsAsync(owner));
        Assert.Empty(await NotificationsAsync(kimClient));
        var kimSees = await ApiClient.ReadJsonAsync(await kimClient.GetAsync("/api/v1/dependency-findings"), HttpStatusCode.OK);
        Assert.Empty(kimSees.GetProperty("items").EnumerateArray());
    }

    [Fact]
    public async Task A_team_project_stays_when_one_member_turns_alerts_off()
    {
        var (_, owner) = await AccountAsync(_factory);
        var (kim, kimClient) = await AccountAsync(_factory, "Kim");
        var team = await CreateTeamAsync(owner);
        await JoinAsync(owner, team, kim, kimClient);
        var scope = await TeamScopeAsync(owner, team);
        await UploadedAsync(owner, scope, "p-api", Inventory("Api", Package("express", "4.18.0")));

        var settings = await kimClient.GetAsync("/api/v1/accounts/me/dependency-alert-settings");
        await kimClient.SendAsync(HttpMethod.Patch, "/api/v1/accounts/me/dependency-alert-settings", new { enabled = false }, ifMatch: settings.Headers.ETag!.Tag);
        _time.Advance(TimeSpan.FromHours(1));
        await RunChecksAsync(_factory);

        Assert.Single(await NotificationsAsync(owner));
        Assert.Empty(await NotificationsAsync(kimClient));
    }
}
