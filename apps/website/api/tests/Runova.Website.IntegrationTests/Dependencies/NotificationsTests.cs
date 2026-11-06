using System.Net;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.Data;
using Runova.Website.Data.Dependencies;
using Runova.Website.IntegrationTests.Infrastructure;
using static Runova.Website.IntegrationTests.Infrastructure.TestDependencies;

namespace Runova.Website.IntegrationTests.Dependencies;

/// <summary>An account's messages: newest first, its own only, marked read one by one or all at once.</summary>
public sealed class NotificationsTests : IDisposable
{
    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 11, 6, 9, 0, 0, TimeSpan.Zero));
    private readonly WebsiteApiFactory _factory;

    public NotificationsTests(PostgresFixture postgres) => _factory = new(postgres.ConnectionString, time: _time);

    public void Dispose() => _factory.Dispose();

    private async Task<long> AddAsync(long userId, string title)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var notification = new UserNotification { UserId = userId, Kind = "dependency-updates", Title = title, Body = "lodash 4.17.20 to 4.17.21: patch update", CreatedAt = _time.GetUtcNow() };
        db.UserNotifications.Add(notification);
        await db.SaveChangesAsync(TestContext.Current.CancellationToken);
        _time.Advance(TimeSpan.FromMinutes(1));
        return notification.Id;
    }

    [Fact]
    public async Task The_list_is_newest_first_counts_unread_and_shows_only_the_accounts_own()
    {
        var (sam, client) = await AccountAsync(_factory);
        var (kim, _) = await AccountAsync(_factory, "Kim");
        await AddAsync(sam.Id, "First");
        await AddAsync(sam.Id, "Second");
        await AddAsync(kim.Id, "Not Sam's");

        var page = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/notifications"), HttpStatusCode.OK);

        Assert.Equal(["Second", "First"], page.GetProperty("items").EnumerateArray().Select(n => n.GetProperty("title").GetString()));
        Assert.Equal(2, page.GetProperty("unread").GetInt32());
        Assert.Equal(2, page.GetProperty("totalItems").GetInt32());
    }

    [Fact]
    public async Task One_is_marked_read_and_unread_and_another_account_can_not_touch_it()
    {
        var (sam, client) = await AccountAsync(_factory);
        var (_, kimClient) = await AccountAsync(_factory, "Kim");
        var id = await AddAsync(sam.Id, "First");

        var read = await ApiClient.ReadJsonAsync(await client.SendAsync(HttpMethod.Patch, $"/api/v1/notifications/{id}", new { read = true }), HttpStatusCode.OK);
        var unread = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/notifications?unread=true"), HttpStatusCode.OK);
        var byKim = await kimClient.SendAsync(HttpMethod.Patch, $"/api/v1/notifications/{id}", new { read = true });
        var bad = await client.SendAsync(HttpMethod.Patch, $"/api/v1/notifications/{id}", new { title = "x" });

        Assert.NotNull(read.GetProperty("readAt").GetString());
        Assert.Empty(unread.GetProperty("items").EnumerateArray());
        await ProblemAssert.IsAsync(byKim, HttpStatusCode.NotFound, "not-found");
        await ProblemAssert.IsAsync(bad, HttpStatusCode.BadRequest, "validation-failed");
        var back = await ApiClient.ReadJsonAsync(await client.SendAsync(HttpMethod.Patch, $"/api/v1/notifications/{id}", new { read = false }), HttpStatusCode.OK);
        Assert.Null(back.GetProperty("readAt").GetString());
    }

    [Fact]
    public async Task A_read_marker_marks_everything_before_it()
    {
        var (sam, client) = await AccountAsync(_factory);
        await AddAsync(sam.Id, "First");
        await AddAsync(sam.Id, "Second");
        var before = _time.GetUtcNow().AddSeconds(-1);
        await AddAsync(sam.Id, "Came in meanwhile");

        var marked = await ApiClient.ReadJsonAsync(await client.SendAsync(HttpMethod.Post, "/api/v1/notification-read-markers", new { before }), HttpStatusCode.Created);

        Assert.Equal(2, marked.GetProperty("marked").GetInt32());
        var page = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/notifications"), HttpStatusCode.OK);
        Assert.Equal(1, page.GetProperty("unread").GetInt32());
    }

    [Fact]
    public async Task The_settings_take_only_known_fields_and_need_if_match()
    {
        var (_, client) = await AccountAsync(_factory);
        var current = await client.GetAsync("/api/v1/accounts/me/dependency-alert-settings");
        var body = await ApiClient.ReadJsonAsync(current, HttpStatusCode.OK);
        var etag = current.Headers.ETag!.Tag;

        Assert.True(body.GetProperty("enabled").GetBoolean());
        Assert.Equal("high", body.GetProperty("securityMinSeverity").GetString());
        Assert.False(body.GetProperty("minor").GetBoolean());
        await ProblemAssert.IsAsync(await client.SendAsync(HttpMethod.Patch, "/api/v1/accounts/me/dependency-alert-settings", new { minor = true }), HttpStatusCode.PreconditionRequired, "precondition-required");
        await ProblemAssert.IsAsync(await client.SendAsync(HttpMethod.Patch, "/api/v1/accounts/me/dependency-alert-settings", new { colour = "red" }, ifMatch: etag), HttpStatusCode.BadRequest, "validation-failed");
        await ProblemAssert.IsAsync(await client.SendAsync(HttpMethod.Patch, "/api/v1/accounts/me/dependency-alert-settings", new { securityMinSeverity = "severe" }, ifMatch: etag), HttpStatusCode.BadRequest, "validation-failed");
        var changed = await client.SendAsync(HttpMethod.Patch, "/api/v1/accounts/me/dependency-alert-settings", new { minor = true, securityMinSeverity = "low" }, ifMatch: etag);
        var after = await ApiClient.ReadJsonAsync(changed, HttpStatusCode.OK);
        Assert.True(after.GetProperty("minor").GetBoolean());
        Assert.Equal("low", after.GetProperty("securityMinSeverity").GetString());
        await ProblemAssert.IsAsync(await client.SendAsync(HttpMethod.Patch, "/api/v1/accounts/me/dependency-alert-settings", new { patch = true }, ifMatch: etag), HttpStatusCode.PreconditionFailed, "precondition-failed");
    }
}
