using System.Net;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.Website.Core.Identity;
using Runova.Website.Data;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Billing;

/// <summary>Account types (E53): offered to anyone, made and changed by Admins.</summary>
public sealed class AccountTypesTests(PostgresFixture postgres) : IAsyncLifetime
{
    private const string Path = "/api/v1/account-types";

    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync() => _factory = new(await postgres.CreateDatabaseAsync());

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    private async Task<ApiClient> AdminAsync() => await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services, Roles.Admin));

    [Fact]
    public async Task Anyone_sees_the_four_seeded_types_in_order_with_their_limits()
    {
        var response = await _factory.CreateApiClient().GetAsync(Path);
        var body = await ApiClient.ReadJsonAsync(response, HttpStatusCode.OK);

        var types = body.EnumerateArray().ToList();
        Assert.Equal(["free", "go", "pro", "ultra"], types.Select(t => t.GetProperty("key").GetString()));
        Assert.Equal(1, types[0].GetProperty("maxCloudMonitors").GetInt32());
        Assert.Equal(300, types[0].GetProperty("minIntervalSec").GetInt32());
        Assert.Equal(10, types[1].GetProperty("maxCloudMonitors").GetInt32());
        Assert.Equal(300, types[1].GetProperty("minIntervalSec").GetInt32());
        Assert.Equal(50, types[2].GetProperty("maxCloudMonitors").GetInt32());
        Assert.Equal(60, types[2].GetProperty("minIntervalSec").GetInt32());
        Assert.Equal(JsonValueKind.Null, types[3].GetProperty("maxCloudMonitors").ValueKind);
        Assert.Equal(30, types[3].GetProperty("minIntervalSec").GetInt32());
        Assert.True(types[0].GetProperty("isFree").GetBoolean());
        Assert.Equal([false, true, true, true], types.Select(t => t.GetProperty("encryptedItems").GetBoolean()));
        Assert.False(types[0].TryGetProperty("stripeProductId", out _));
        Assert.Equal("public, max-age=60, stale-while-revalidate=300", response.Headers.NonValidated["Cache-Control"].ToString());
    }

    [Fact]
    public async Task Archived_types_are_only_for_admins()
    {
        var account = await TestAccounts.SignedInClientAsync(_factory, await TestAccounts.CreateAsync(_factory.Services));

        var forbidden = await account.GetAsync(Path + "?includeInactive=true");

        await ProblemAssert.IsProblemAsync(forbidden, HttpStatusCode.Forbidden, ProblemAssert.Type("forbidden"), Path);
    }

    [Fact]
    public async Task An_admin_makes_a_type_and_it_is_offered()
    {
        var admin = await AdminAsync();

        var response = await admin.SendAsync(HttpMethod.Post, Path, new
        {
            key = "team",
            name = "Team",
            description = "For agencies.",
            features = new[] { "200 online monitors" },
            sortOrder = 5,
            maxCloudMonitors = 200,
            minIntervalSec = 60,
            historyDays = 120,
            monthlyPriceCents = 9900,
        });
        var created = await ApiClient.ReadJsonAsync(response, HttpStatusCode.Created);

        Assert.True(created.GetProperty("id").GetInt64() >= 100);
        Assert.Equal("team", created.GetProperty("key").GetString());
        Assert.NotNull(response.Headers.ETag);
        var offered = await ApiClient.ReadJsonAsync(await _factory.CreateApiClient().GetAsync(Path), HttpStatusCode.OK);
        Assert.Contains(offered.EnumerateArray(), t => t.GetProperty("key").GetString() == "team");
        Assert.Single(await AuditAsync("account-type.create"));
    }

    [Fact]
    public async Task A_key_is_used_once()
    {
        var admin = await AdminAsync();

        var response = await admin.SendAsync(HttpMethod.Post, Path, new { key = "pro", name = "Another Pro", minIntervalSec = 60 });

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Conflict, ProblemAssert.Type("conflict"), Path);
    }

    [Fact]
    public async Task Bad_fields_are_named()
    {
        var admin = await AdminAsync();

        var response = await admin.SendAsync(HttpMethod.Post, Path, new { key = "Bad Key", name = "", minIntervalSec = 10, historyDays = 0, monthlyPriceCents = -1, currency = "dollars" });

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Path);
        var errors = problem.GetProperty("errors");
        foreach (var field in new[] { "key", "name", "minIntervalSec", "historyDays", "monthlyPriceCents", "currency" })
        {
            Assert.True(errors.TryGetProperty(field, out _), field);
        }
    }

    [Fact]
    public async Task An_admin_changes_a_type_with_its_version()
    {
        var admin = await AdminAsync();
        var etag = (await admin.GetAsync($"{Path}/3")).Headers.ETag!.Tag;

        var response = await admin.SendAsync(HttpMethod.Patch, $"{Path}/3", new { maxCloudMonitors = 75, monthlyPriceCents = 1900, encryptedItems = false }, ifMatch: etag);
        var stale = await admin.SendAsync(HttpMethod.Patch, $"{Path}/3", new { maxCloudMonitors = 80 }, ifMatch: etag);

        var body = await ApiClient.ReadJsonAsync(response, HttpStatusCode.OK);
        Assert.Equal(75, body.GetProperty("maxCloudMonitors").GetInt32());
        Assert.Equal(1900, body.GetProperty("monthlyPriceCents").GetInt32());
        Assert.False(body.GetProperty("encryptedItems").GetBoolean());
        await ProblemAssert.IsProblemAsync(stale, HttpStatusCode.PreconditionFailed, ProblemAssert.Type("precondition-failed"), $"{Path}/3");
    }

    [Fact]
    public async Task Free_stays_free_and_on_offer()
    {
        var admin = await AdminAsync();
        var etag = (await admin.GetAsync($"{Path}/1")).Headers.ETag!.Tag;

        var priced = await admin.SendAsync(HttpMethod.Patch, $"{Path}/1", new { monthlyPriceCents = 100 }, ifMatch: etag);
        var archived = await admin.SendAsync(HttpMethod.Patch, $"{Path}/1", new { isActive = false }, ifMatch: etag);
        var deleted = await admin.SendAsync(HttpMethod.Delete, $"{Path}/1", ifMatch: etag);

        await ProblemAssert.IsProblemAsync(priced, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), $"{Path}/1");
        await ProblemAssert.IsProblemAsync(archived, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), $"{Path}/1");
        await ProblemAssert.IsProblemAsync(deleted, HttpStatusCode.Conflict, ProblemAssert.Type("conflict"), $"{Path}/1");
    }

    [Fact]
    public async Task A_type_nobody_had_is_removed_and_one_that_was_used_is_kept()
    {
        var admin = await AdminAsync();
        var created = await ApiClient.ReadJsonAsync(await admin.SendAsync(HttpMethod.Post, Path, new { key = "spare", name = "Spare", minIntervalSec = 60 }), HttpStatusCode.Created);
        var id = created.GetProperty("id").GetInt64();
        var account = await TestAccounts.CreateAsync(_factory.Services);
        await ApiClient.ReadJsonAsync(await admin.SendAsync(HttpMethod.Put, $"/api/v1/users/{account.Id}/subscriptions/current", new { accountTypeId = 2 }), HttpStatusCode.OK);

        var removed = await admin.SendAsync(HttpMethod.Delete, $"{Path}/{id}", ifMatch: created.GetProperty("version").GetString() is { } v ? $"\"{v}\"" : null);
        var used = await admin.SendAsync(HttpMethod.Delete, $"{Path}/2", ifMatch: (await admin.GetAsync($"{Path}/2")).Headers.ETag!.Tag);

        Assert.Equal(HttpStatusCode.NoContent, removed.StatusCode);
        await ProblemAssert.IsProblemAsync(used, HttpStatusCode.Conflict, ProblemAssert.Type("conflict"), $"{Path}/2");
    }

    [Theory]
    [InlineData(Roles.Editor)]
    [InlineData(null)]
    public async Task Only_an_admin_may_change_types(string? role)
    {
        var user = role is null ? await TestAccounts.CreateAsync(_factory.Services) : await TestUsers.CreateAsync(_factory.Services, role);
        var client = role is null ? await TestAccounts.SignedInClientAsync(_factory, user) : await TestUsers.SignedInClientAsync(_factory, user);

        Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(HttpMethod.Post, Path, new { key = "x1", name = "X" })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync($"{Path}/2")).StatusCode);
    }

    private async Task<List<string>> AuditAsync(string action)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        return await db.AuditEntries.Where(e => e.Action == action).Select(e => e.TargetId).ToListAsync(TestContext.Current.CancellationToken);
    }
}
