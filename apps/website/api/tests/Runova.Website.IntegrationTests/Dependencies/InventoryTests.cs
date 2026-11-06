using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.Data;
using Runova.Website.IntegrationTests.Infrastructure;
using static Runova.Website.IntegrationTests.Infrastructure.TestDependencies;

namespace Runova.Website.IntegrationTests.Dependencies;

/// <summary>The desktop app uploads each project's packages into the scope the project lives in.</summary>
public sealed class InventoryTests : IDisposable
{
    private readonly WebsiteApiFactory _factory;

    public InventoryTests(PostgresFixture postgres) =>
        _factory = new(postgres.ConnectionString, time: new FakeTimeProvider(new DateTimeOffset(2026, 11, 6, 9, 0, 0, TimeSpan.Zero)));

    public void Dispose() => _factory.Dispose();

    [Fact]
    public async Task An_upload_keeps_the_packages_and_plans_a_first_check_within_the_hour()
    {
        var (_, client) = await AccountAsync(_factory);
        var scope = await PersonalScopeAsync(client);

        var response = await UploadAsync(client, scope, "p-shop", Inventory("Shop", Package("lodash", "4.17.20"), Package("Serilog", "3.1.1", "nuget")));

        var body = await ApiClient.ReadJsonAsync(response, HttpStatusCode.Created);
        Assert.Equal("Shop", body.GetProperty("projectName").GetString());
        Assert.Equal(2, body.GetProperty("packageCount").GetInt32());
        Assert.Equal(scope, body.GetProperty("scopeId").GetInt64());
        Assert.Equal("p-shop", body.GetProperty("itemId").GetString());
        using var check = _factory.Services.CreateScope();
        var db = check.ServiceProvider.GetRequiredService<AppDbContext>();
        var inventory = await db.PackageInventories.SingleAsync(i => i.ScopeId == scope, TestContext.Current.CancellationToken);
        Assert.InRange(inventory.NextCheckAt, inventory.UploadedAt, inventory.UploadedAt.AddHours(1));
        Assert.Equal(2, await db.InventoryPackages.CountAsync(p => p.InventoryId == inventory.Id, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task The_same_upload_again_changes_nothing_and_a_new_one_replaces_the_packages()
    {
        var (_, client) = await AccountAsync(_factory);
        var scope = await PersonalScopeAsync(client);
        var id = await UploadedAsync(client, scope, "p-shop", Inventory("Shop", Package("lodash", "4.17.20")));
        DateTimeOffset firstPlan;
        using (var read = _factory.Services.CreateScope())
        {
            firstPlan = (await read.ServiceProvider.GetRequiredService<AppDbContext>().PackageInventories.SingleAsync(i => i.Id == id, TestContext.Current.CancellationToken)).NextCheckAt;
        }

        var same = await UploadAsync(client, scope, "p-shop", Inventory("Shop", Package("lodash", "4.17.20")));
        var changed = await UploadAsync(client, scope, "p-shop", Inventory("Shop", Package("lodash", "4.17.21"), Package("express", "5.0.0")));

        Assert.Equal(HttpStatusCode.OK, same.StatusCode);
        Assert.Equal(2, (await ApiClient.ReadJsonAsync(changed, HttpStatusCode.OK)).GetProperty("packageCount").GetInt32());
        using var check = _factory.Services.CreateScope();
        var db = check.ServiceProvider.GetRequiredService<AppDbContext>();
        var versions = await db.InventoryPackages.Where(p => p.InventoryId == id).OrderBy(p => p.Name).Select(p => p.Name + "@" + p.Version).ToListAsync(TestContext.Current.CancellationToken);
        Assert.Equal(["express@5.0.0", "lodash@4.17.21"], versions);
        Assert.NotEqual(default, firstPlan);
    }

    [Fact]
    public async Task A_team_member_uploads_into_the_team_scope_but_a_viewer_and_a_stranger_can_not()
    {
        var (_, owner) = await AccountAsync(_factory);
        var (member, memberClient) = await AccountAsync(_factory, "Kim");
        var (viewer, viewerClient) = await AccountAsync(_factory, "Lee");
        var (_, stranger) = await AccountAsync(_factory, "Ray");
        var team = await CreateTeamAsync(owner);
        await JoinAsync(owner, team, member, memberClient);
        await JoinAsync(owner, team, viewer, viewerClient, "viewer");
        var scope = await TeamScopeAsync(owner, team);

        var byMember = await UploadAsync(memberClient, scope, "p-api", Inventory("Api", Package("express", "4.0.0")));
        var byViewer = await UploadAsync(viewerClient, scope, "p-api", Inventory("Api", Package("express", "4.0.0")));
        var byStranger = await UploadAsync(stranger, scope, "p-api", Inventory("Api", Package("express", "4.0.0")));

        Assert.Equal(HttpStatusCode.Created, byMember.StatusCode);
        await ProblemAssert.IsAsync(byViewer, HttpStatusCode.Forbidden, "forbidden");
        await ProblemAssert.IsAsync(byStranger, HttpStatusCode.NotFound, "not-found");
    }

    [Theory]
    [InlineData("cargo", "serde", "1.0.0", "packages[0].ecosystem")]
    [InlineData("npm", "", "1.0.0", "packages[0].name")]
    [InlineData("npm", "lodash", "", "packages[0].version")]
    public async Task A_package_that_is_not_valid_is_refused(string ecosystem, string name, string version, string field)
    {
        var (_, client) = await AccountAsync(_factory);
        var scope = await PersonalScopeAsync(client);

        var response = await UploadAsync(client, scope, "p-shop", Inventory("Shop", Package(name, version, ecosystem)));

        var problem = await ProblemAssert.IsAsync(response, HttpStatusCode.BadRequest, "validation-failed");
        Assert.True(problem.GetProperty("errors").TryGetProperty(field, out _), problem.ToString());
    }

    [Fact]
    public async Task A_bad_item_id_or_a_missing_name_is_refused()
    {
        var (_, client) = await AccountAsync(_factory);
        var scope = await PersonalScopeAsync(client);

        await ProblemAssert.IsAsync(await UploadAsync(client, scope, "p shop!", Inventory("Shop")), HttpStatusCode.BadRequest, "validation-failed");
        await ProblemAssert.IsAsync(await UploadAsync(client, scope, "p-shop", Inventory("")), HttpStatusCode.BadRequest, "validation-failed");
    }

    [Fact]
    public async Task Deleting_an_inventory_removes_it_and_its_packages()
    {
        var (_, client) = await AccountAsync(_factory);
        var scope = await PersonalScopeAsync(client);
        var id = await UploadedAsync(client, scope, "p-shop", Inventory("Shop", Package("lodash", "4.17.20")));

        var deleted = await client.SendAsync(HttpMethod.Delete, $"/api/v1/sync-scopes/{scope}/package-inventories/p-shop");
        var again = await client.SendAsync(HttpMethod.Delete, $"/api/v1/sync-scopes/{scope}/package-inventories/p-shop");

        Assert.Equal(HttpStatusCode.NoContent, deleted.StatusCode);
        await ProblemAssert.IsAsync(again, HttpStatusCode.NotFound, "not-found");
        using var check = _factory.Services.CreateScope();
        Assert.False(await check.ServiceProvider.GetRequiredService<AppDbContext>().InventoryPackages.AnyAsync(p => p.InventoryId == id, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Uploads_are_refused_while_alerts_are_turned_off()
    {
        var (_, client) = await AccountAsync(_factory);
        var scope = await PersonalScopeAsync(client);
        var settings = await client.GetAsync("/api/v1/accounts/me/dependency-alert-settings");
        var etag = settings.Headers.ETag!.Tag;
        var off = await client.SendAsync(HttpMethod.Patch, "/api/v1/accounts/me/dependency-alert-settings", new { enabled = false }, ifMatch: etag);
        Assert.Equal(HttpStatusCode.OK, off.StatusCode);

        var response = await UploadAsync(client, scope, "p-shop", Inventory("Shop", Package("lodash", "4.17.20")));

        await ProblemAssert.IsAsync(response, HttpStatusCode.Conflict, "conflict");
    }

    [Fact]
    public async Task Deleting_the_team_deletes_its_inventories()
    {
        var (_, owner) = await AccountAsync(_factory);
        var team = await CreateTeamAsync(owner);
        var scope = await TeamScopeAsync(owner, team);
        var id = await UploadedAsync(owner, scope, "p-api", Inventory("Api", Package("express", "4.0.0")));

        var deleted = await owner.SendAsync(HttpMethod.Delete, $"/api/v1/teams/{team}", new { password = TestAccounts.Password, code = (string?)null });

        Assert.Equal(HttpStatusCode.NoContent, deleted.StatusCode);
        using var check = _factory.Services.CreateScope();
        Assert.False(await check.ServiceProvider.GetRequiredService<AppDbContext>().PackageInventories.AnyAsync(i => i.Id == id, TestContext.Current.CancellationToken));
    }
}
