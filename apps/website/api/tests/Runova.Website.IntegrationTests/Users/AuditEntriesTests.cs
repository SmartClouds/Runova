using System.Net;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Runova.Website.Core.Identity;
using Runova.Website.Data;
using Runova.Website.Data.Audit;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Users;

/// <summary>Reading the audit trail. Each test has a database of its own, so it knows every entry.</summary>
public sealed class AuditEntriesTests(PostgresFixture postgres) : IAsyncLifetime
{
    private const string AuditEntries = "/api/v1/audit-entries";

    private static readonly DateTimeOffset _start = new(2026, 10, 1, 8, 0, 0, TimeSpan.Zero);

    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync() => _factory = new(await postgres.CreateDatabaseAsync());

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    [Fact]
    public async Task An_admin_reads_the_entries_newest_first_with_no_changes_and_no_caching()
    {
        var admin = await AdminAsync();
        await AddAsync(
            Entry(0, "user", 1, "user.invite", "user", "7", ip: "203.0.113.9", changes: """{"email":"a@b.c"}"""),
            Entry(1, "api-client", 3, "news.create", "news", "42"),
            Entry(2, "system", null, "news.publish", "news", "42"));

        var response = await admin.GetAsync($"{AuditEntries}?pageSize=2");
        var page = await ApiClient.ReadJsonAsync(response, HttpStatusCode.OK);

        var items = page.GetProperty("items").EnumerateArray().ToList();
        Assert.Equal(["news.publish", "news.create"], items.Select(e => e.GetProperty("action").GetString()));
        Assert.Equal(["id", "at", "actorKind", "actorId", "action", "targetType", "targetId", "ip"], items[0].EnumerateObject().Select(p => p.Name));
        Assert.Equal(JsonValueKind.Null, items[0].GetProperty("actorId").ValueKind);
        Assert.Equal(JsonValueKind.Null, items[0].GetProperty("ip").ValueKind);
        Assert.Equal("2026-10-01T08:02:00.000Z", items[0].GetProperty("at").GetString());
        Assert.Equal("system", items[0].GetProperty("actorKind").GetString());
        Assert.Equal(3, items[1].GetProperty("actorId").GetInt64());
        Assert.Equal("42", items[1].GetProperty("targetId").GetString());
        Assert.Equal(3, page.GetProperty("totalItems").GetInt32());
        Assert.Equal(2, page.GetProperty("totalPages").GetInt32());
        Assert.Contains("rel=\"next\"", response.Headers.GetValues("Link").Single(), StringComparison.Ordinal);
        Assert.Equal("private, no-store", response.Headers.NonValidated["Cache-Control"].ToString());

        var last = await ApiClient.ReadJsonAsync(await admin.GetAsync($"{AuditEntries}?pageSize=2&page=2"), HttpStatusCode.OK);
        var first = Assert.Single(last.GetProperty("items").EnumerateArray());
        Assert.Equal("203.0.113.9", first.GetProperty("ip").GetString());
    }

    [Theory]
    [InlineData("actorId=1", new[] { "user.invite" })]
    [InlineData("actorKind=api-client", new[] { "news.create" })]
    [InlineData("action=news.publish", new[] { "news.publish" })]
    [InlineData("targetType=news", new[] { "news.publish", "news.create" })]
    [InlineData("since=2026-10-01T08:01:00.000Z", new[] { "news.publish", "news.create" })]
    [InlineData("targetType=news&actorKind=system", new[] { "news.publish" })]
    [InlineData("targetType=post", new string[0])]
    public async Task Filters_combine_with_and(string query, string[] actions)
    {
        var admin = await AdminAsync();
        await AddAsync(
            Entry(0, "user", 1, "user.invite", "user", "7"),
            Entry(1, "api-client", 3, "news.create", "news", "42"),
            Entry(2, "system", null, "news.publish", "news", "42"));

        var page = await ApiClient.ReadJsonAsync(await admin.GetAsync($"{AuditEntries}?{query}"), HttpStatusCode.OK);

        Assert.Equal(actions, page.GetProperty("items").EnumerateArray().Select(e => e.GetProperty("action").GetString()));
    }

    [Theory]
    [InlineData("pageSize=101", "pageSize")]
    [InlineData("page=0", "page")]
    [InlineData("actorKind=robot", "actorKind")]
    [InlineData("action=user.fly", "action")]
    [InlineData("targetType=planet", "targetType")]
    [InlineData("since=yesterday", "since")]
    public async Task A_bad_query_value_gets_400(string query, string field)
    {
        var admin = await AdminAsync();

        var response = await admin.GetAsync($"{AuditEntries}?{query}");

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), AuditEntries);
        Assert.Equal([field], problem.GetProperty("errors").EnumerateObject().Select(p => p.Name));
    }

    [Fact]
    public async Task An_actor_id_that_is_not_a_number_gets_400()
    {
        var admin = await AdminAsync();

        var response = await admin.GetAsync($"{AuditEntries}?actorId=abc");

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), AuditEntries);
    }

    [Fact]
    public async Task An_editor_gets_403_and_no_session_gets_401()
    {
        var editor = await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services, Roles.Editor));

        await ProblemAssert.IsProblemAsync(await editor.GetAsync(AuditEntries), HttpStatusCode.Forbidden, ProblemAssert.Type("forbidden"), AuditEntries);
        await ProblemAssert.IsProblemAsync(await _factory.CreateApiClient().GetAsync(AuditEntries), HttpStatusCode.Unauthorized, ProblemAssert.Type("unauthorized"), AuditEntries);
    }

    [Fact]
    public async Task A_change_made_through_the_api_shows_in_the_list()
    {
        var actor = await TestUsers.CreateAsync(_factory.Services, Roles.Admin);
        var admin = await TestUsers.SignedInClientAsync(_factory, actor);
        var invited = await ApiClient.ReadJsonAsync(
            await admin.SendAsync(HttpMethod.Post, "/api/v1/users", new { email = $"{Guid.NewGuid():N}@audit.runovahq.com", displayName = "Listed", roles = new[] { "Editor" } }),
            HttpStatusCode.Created);

        var page = await ApiClient.ReadJsonAsync(await admin.GetAsync($"{AuditEntries}?action=user.invite"), HttpStatusCode.OK);

        var entry = Assert.Single(page.GetProperty("items").EnumerateArray());
        Assert.Equal("user", entry.GetProperty("actorKind").GetString());
        Assert.Equal(actor.Id, entry.GetProperty("actorId").GetInt64());
        Assert.Equal(invited.GetProperty("user").GetProperty("id").GetInt64().ToString(System.Globalization.CultureInfo.InvariantCulture), entry.GetProperty("targetId").GetString());
        var token = invited.GetProperty("setupLink").GetProperty("url").GetString()!.Split("#token=")[1];
        Assert.DoesNotContain(token, page.ToString(), StringComparison.Ordinal);
    }

    private static AuditEntry Entry(
        int minutes, string actorKind, long? actorId, string action, string targetType, string targetId, string? ip = null, string? changes = null) => new()
        {
            At = _start.AddMinutes(minutes),
            ActorKind = actorKind,
            ActorId = actorId,
            Action = action,
            TargetType = targetType,
            TargetId = targetId,
            Ip = ip,
            Changes = changes,
        };

    private async Task AddAsync(params AuditEntry[] entries)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        db.AuditEntries.AddRange(entries);
        await db.SaveChangesAsync(TestContext.Current.CancellationToken);
    }

    /// <summary>An Admin made straight through Identity, so signing in adds no entry.</summary>
    private async Task<ApiClient> AdminAsync() =>
        await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services, Roles.Admin));
}
