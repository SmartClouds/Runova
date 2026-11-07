using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Time.Testing;
using Runova.Monitoring.Contracts.Grpc;
using Runova.Website.IntegrationTests.Infrastructure;
using static Runova.Website.IntegrationTests.Infrastructure.TestCloudMonitors;
using static Runova.Website.IntegrationTests.Infrastructure.TestDependencies;

namespace Runova.Website.IntegrationTests.Monitoring;

/// <summary>Online monitors through the API (E55): who sees them, what the types allow, and what reaches the nodes.</summary>
public sealed class CloudMonitorsTests(PostgresFixture postgres) : IAsyncLifetime
{
    private readonly FakeTimeProvider _clock = new(new DateTimeOffset(2026, 11, 7, 9, 0, 0, TimeSpan.Zero));
    private readonly FakeNodeBus _bus = new();
    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync() => _factory = new(await postgres.CreateDatabaseAsync(), time: _clock, services: _bus.Register);

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    private IEnumerable<AssignmentDelta> DeltasFor(long nodeId) =>
        _bus.Sent.Where(s => s.NodeId == nodeId && s.Message.BodyCase == ServerMessage.BodyOneofCase.Delta).Select(s => s.Message.Delta);

    [Fact]
    public async Task A_monitor_is_made_in_the_personal_scope_and_handed_to_a_node_with_its_key()
    {
        var node = await OnlineNodeAsync(_factory, "eu-1", "eu-central", _clock.GetUtcNow());
        var (_, client) = await AccountAsync(_factory);
        var scope = await PersonalScopeAsync(client);

        var response = await CreateAsync(client, Monitor(scope));

        var body = await ApiClient.ReadJsonAsync(response, HttpStatusCode.Created);
        Assert.NotNull(response.Headers.ETag);
        Assert.Equal("API", body.GetProperty("name").GetString());
        Assert.Equal("Storefront", body.GetProperty("projectName").GetString());
        Assert.True(body.GetProperty("hasSecret").GetBoolean());
        Assert.True(body.GetProperty("canWrite").GetBoolean());
        Assert.Equal("unknown", body.GetProperty("status").GetProperty("verdict").GetString());
        Assert.DoesNotContain("s3cret", body.GetRawText(), StringComparison.Ordinal);
        var id = body.GetProperty("id").GetInt64();
        Assert.Equal(node, await AssignedNodeAsync(_factory, id));
        var upsert = Assert.Single(Assert.Single(DeltasFor(node)).Upserts);
        Assert.Equal(id, upsert.Id);
        Assert.Equal(Url, upsert.Url);
        Assert.Equal("bearer", upsert.AuthMode);
        Assert.Equal("s3cret-bearer-key", upsert.Secret);
        Assert.Equal(300, upsert.IntervalSec);

        var list = await ApiClient.ReadJsonAsync(await client.GetAsync($"/api/v1/cloud-monitors?scopeId={scope}"), HttpStatusCode.OK);
        Assert.Equal(id, Assert.Single(list.GetProperty("items").EnumerateArray()).GetProperty("id").GetInt64());
    }

    [Fact]
    public async Task The_same_desktop_monitor_twice_in_one_scope_is_a_conflict()
    {
        var (_, client) = await AccountAsync(_factory);
        var scope = await PersonalScopeAsync(client);
        await CreatedAsync(client, Monitor(scope, paused: true));

        var again = await CreateAsync(client, Monitor(scope, paused: true));

        await ProblemAssert.IsAsync(again, HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task Free_allows_one_active_monitor_and_a_paused_one_does_not_count()
    {
        var (_, client) = await AccountAsync(_factory);
        var scope = await PersonalScopeAsync(client);
        var first = await CreatedAsync(client, Monitor(scope, "t-1"));

        var refused = await CreateAsync(client, Monitor(scope, "t-2"));
        var problem = await ProblemAssert.IsAsync(refused, HttpStatusCode.Conflict);
        Assert.Contains("Free allows 1 online monitor", problem.GetProperty("detail").GetString(), StringComparison.Ordinal);

        var second = await CreatedAsync(client, Monitor(scope, "t-2", paused: true));
        await ProblemAssert.IsAsync(await PatchAsync(client, second, new { paused = false }), HttpStatusCode.Conflict);

        Assert.Equal(HttpStatusCode.OK, (await PatchAsync(client, first, new { paused = true })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await PatchAsync(client, second, new { paused = false })).StatusCode);
    }

    [Fact]
    public async Task Each_type_allows_its_own_count_and_interval()
    {
        var (user, client) = await AccountAsync(_factory);
        var scope = await PersonalScopeAsync(client);

        var tooOften = await CreateAsync(client, Monitor(scope, intervalSec: 60));
        var free = await ProblemAssert.IsAsync(tooOften, HttpStatusCode.BadRequest);
        Assert.Equal(
            "Free checks every 5 minutes or slower. Choose a longer interval, or a type that allows it.",
            free.GetProperty("errors").GetProperty("intervalSec")[0].GetString());

        await GrantAsync(_factory, user.Id, Go);
        for (var i = 0; i < 10; i++)
        {
            await CreatedAsync(client, Monitor(scope, $"go-{i}"));
        }

        await ProblemAssert.IsAsync(await CreateAsync(client, Monitor(scope, "go-10")), HttpStatusCode.Conflict);
        await ProblemAssert.IsAsync(await CreateAsync(client, Monitor(scope, "go-x", intervalSec: 60, paused: true)), HttpStatusCode.BadRequest);

        await GrantAsync(_factory, user.Id, Pro);
        await CreatedAsync(client, Monitor(scope, "pro-1", intervalSec: 60));
        await ProblemAssert.IsAsync(await CreateAsync(client, Monitor(scope, "pro-2", intervalSec: 30)), HttpStatusCode.BadRequest);

        await GrantAsync(_factory, user.Id, Ultra);
        for (var i = 0; i < 45; i++)
        {
            await CreatedAsync(client, Monitor(scope, $"ultra-{i}", intervalSec: 30));
        }

        var usage = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/cloud-monitors/usage"), HttpStatusCode.OK);
        var personal = usage.GetProperty("scopes").EnumerateArray().Single(s => s.GetProperty("scopeId").GetInt64() == scope);
        Assert.Equal(56, personal.GetProperty("active").GetInt32());
        Assert.Equal("ultra", personal.GetProperty("accountTypeKey").GetString());
        Assert.Equal(JsonValueKind.Null, personal.GetProperty("maxMonitors").ValueKind);
        Assert.Equal(30, personal.GetProperty("minIntervalSec").GetInt32());
    }

    [Fact]
    public async Task A_team_viewer_reads_its_monitors_and_can_not_change_them_and_others_get_404()
    {
        var (_, owner) = await AccountAsync(_factory);
        var (viewer, viewerClient) = await AccountAsync(_factory, "Lee");
        var (_, stranger) = await AccountAsync(_factory, "Ray");
        var team = await CreateTeamAsync(owner);
        await JoinAsync(owner, team, viewer, viewerClient, "viewer");
        var scope = await TeamScopeAsync(owner, team);
        var id = await CreatedAsync(owner, Monitor(scope));

        var (seen, etag) = await ReadAsync(viewerClient, id);
        Assert.False(seen.GetProperty("canWrite").GetBoolean());
        var list = await ApiClient.ReadJsonAsync(await viewerClient.GetAsync("/api/v1/cloud-monitors"), HttpStatusCode.OK);
        Assert.Single(list.GetProperty("items").EnumerateArray());
        await ProblemAssert.IsAsync(await viewerClient.SendAsync(HttpMethod.Patch, $"/api/v1/cloud-monitors/{id}", new { paused = true }, ifMatch: etag), HttpStatusCode.Forbidden);
        await ProblemAssert.IsAsync(await viewerClient.SendAsync(HttpMethod.Delete, $"/api/v1/cloud-monitors/{id}", ifMatch: etag), HttpStatusCode.Forbidden);
        await ProblemAssert.IsAsync(await CreateAsync(viewerClient, Monitor(scope, "t-2")), HttpStatusCode.Forbidden);
        await ProblemAssert.IsAsync(await viewerClient.SendAsync(HttpMethod.Put, $"/api/v1/cloud-monitors/{id}/secrets/current", new { secret = "new-key-value" }), HttpStatusCode.Forbidden);
        // A viewer can still mute it for themselves.
        Assert.Equal(HttpStatusCode.NoContent, (await viewerClient.SendAsync(HttpMethod.Put, $"/api/v1/cloud-monitors/{id}/mutes/me")).StatusCode);

        await ProblemAssert.IsAsync(await stranger.GetAsync($"/api/v1/cloud-monitors/{id}"), HttpStatusCode.NotFound);
        await ProblemAssert.IsAsync(await stranger.GetAsync($"/api/v1/cloud-monitors?scopeId={scope}"), HttpStatusCode.NotFound);
        await ProblemAssert.IsAsync(await stranger.GetAsync($"/api/v1/cloud-monitors/{id}/samples"), HttpStatusCode.NotFound);
        await ProblemAssert.IsAsync(await CreateAsync(stranger, Monitor(scope, "t-3")), HttpStatusCode.NotFound);
        var strangers = await ApiClient.ReadJsonAsync(await stranger.GetAsync("/api/v1/cloud-monitors"), HttpStatusCode.OK);
        Assert.Empty(strangers.GetProperty("items").EnumerateArray());
    }

    [Fact]
    public async Task A_team_uses_its_owners_type_whoever_adds_the_monitor()
    {
        var (ownerUser, owner) = await AccountAsync(_factory);
        var (member, memberClient) = await AccountAsync(_factory, "Kim");
        var team = await CreateTeamAsync(owner);
        await JoinAsync(owner, team, member, memberClient);
        var scope = await TeamScopeAsync(owner, team);
        await GrantAsync(_factory, member.Id, Ultra);

        await CreatedAsync(memberClient, Monitor(scope, "t-1"));
        await ProblemAssert.IsAsync(await CreateAsync(memberClient, Monitor(scope, "t-2")), HttpStatusCode.Conflict);

        await GrantAsync(_factory, ownerUser.Id, Go);
        await CreatedAsync(memberClient, Monitor(scope, "t-2"));
    }

    [Theory]
    [InlineData("https://localhost:5000/health")]
    [InlineData("https://10.0.0.5/health")]
    [InlineData("http://api.example.com/health")]
    public async Task An_address_a_node_may_not_check_is_refused(string url)
    {
        var (_, client) = await AccountAsync(_factory);
        var scope = await PersonalScopeAsync(client);

        var response = await CreateAsync(client, Monitor(scope, url: url));

        var problem = await ProblemAssert.IsAsync(response, HttpStatusCode.BadRequest);
        Assert.True(problem.GetProperty("errors").TryGetProperty("url", out _));
    }

    [Fact]
    public async Task A_change_needs_if_match_and_a_new_address_reaches_the_node_with_a_new_version()
    {
        var node = await OnlineNodeAsync(_factory, "eu-1", "eu-central", _clock.GetUtcNow());
        var (_, client) = await AccountAsync(_factory);
        var id = await CreatedAsync(client, Monitor(await PersonalScopeAsync(client)));
        var (_, etag) = await ReadAsync(client, id);

        await ProblemAssert.IsAsync(await client.SendAsync(HttpMethod.Patch, $"/api/v1/cloud-monitors/{id}", new { name = "Edge" }), (HttpStatusCode)428);
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(HttpMethod.Patch, $"/api/v1/cloud-monitors/{id}", new { name = "Edge" }, ifMatch: etag)).StatusCode);
        await ProblemAssert.IsAsync(await client.SendAsync(HttpMethod.Patch, $"/api/v1/cloud-monitors/{id}", new { name = "Again" }, ifMatch: etag), HttpStatusCode.PreconditionFailed);
        // A name is not something the node checks with: it hears nothing about it.
        Assert.Single(DeltasFor(node));

        var changed = await PatchAsync(client, id, new { url = "https://edge.example.com/health" });

        var body = await ApiClient.ReadJsonAsync(changed, HttpStatusCode.OK);
        Assert.Equal("https://edge.example.com/health", body.GetProperty("url").GetString());
        var upsert = Assert.Single(DeltasFor(node).Last().Upserts);
        Assert.Equal("https://edge.example.com/health", upsert.Url);
        Assert.Equal(2, upsert.Version);
    }

    [Fact]
    public async Task Pausing_and_deleting_take_the_monitor_off_its_node()
    {
        var node = await OnlineNodeAsync(_factory, "eu-1", "eu-central", _clock.GetUtcNow());
        var (_, client) = await AccountAsync(_factory);
        var id = await CreatedAsync(client, Monitor(await PersonalScopeAsync(client)));

        await PatchAsync(client, id, new { paused = true });
        Assert.Equal([id], DeltasFor(node).Last().Removed);
        Assert.Null(await AssignedNodeAsync(_factory, id));

        await PatchAsync(client, id, new { paused = false });
        Assert.Equal(id, Assert.Single(DeltasFor(node).Last().Upserts).Id);

        var (_, etag) = await ReadAsync(client, id);
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(HttpMethod.Delete, $"/api/v1/cloud-monitors/{id}", ifMatch: etag)).StatusCode);
        Assert.Equal([id], DeltasFor(node).Last().Removed);
        await ProblemAssert.IsAsync(await client.GetAsync($"/api/v1/cloud-monitors/{id}"), HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task The_key_is_replaced_without_ever_being_shown()
    {
        var node = await OnlineNodeAsync(_factory, "eu-1", "eu-central", _clock.GetUtcNow());
        var (_, client) = await AccountAsync(_factory);
        var id = await CreatedAsync(client, Monitor(await PersonalScopeAsync(client)));

        var replaced = await client.SendAsync(HttpMethod.Put, $"/api/v1/cloud-monitors/{id}/secrets/current", new { secret = "rotated-key-123" });

        Assert.Equal(HttpStatusCode.NoContent, replaced.StatusCode);
        var upsert = Assert.Single(DeltasFor(node).Last().Upserts);
        Assert.Equal("rotated-key-123", upsert.Secret);
        Assert.Equal(2, upsert.Version);
        var (body, _) = await ReadAsync(client, id);
        Assert.DoesNotContain("rotated", body.GetRawText(), StringComparison.Ordinal);
        Assert.Equal(JsonValueKind.String, body.GetProperty("secretChangedAt").ValueKind);
        var row = await MonitorRowAsync(_factory, id);
        Assert.DoesNotContain("rotated", row.SealedSecret!, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Basic_needs_a_user_and_a_password_and_none_needs_no_key()
    {
        var (_, client) = await AccountAsync(_factory);
        var scope = await PersonalScopeAsync(client);

        var bad = await client.SendAsync(HttpMethod.Post, "/api/v1/cloud-monitors", new
        {
            scopeId = scope,
            itemId = "t-1",
            name = "API",
            projectName = "Storefront",
            url = Url,
            intervalSec = 300,
            timeoutSec = 10,
            authMode = "basic",
            secret = "no-colon-here",
        });
        var problem = await ProblemAssert.IsAsync(bad, HttpStatusCode.BadRequest);
        Assert.True(problem.GetProperty("errors").TryGetProperty("secret", out _));

        var open = await client.SendAsync(HttpMethod.Post, "/api/v1/cloud-monitors", new
        {
            scopeId = scope,
            itemId = "t-2",
            name = "API",
            projectName = "Storefront",
            url = Url,
            intervalSec = 300,
            timeoutSec = 10,
            authMode = "none",
        });
        var body = await ApiClient.ReadJsonAsync(open, HttpStatusCode.Created);
        Assert.False(body.GetProperty("hasSecret").GetBoolean());
        Assert.True(body.GetProperty("notifyInApp").GetBoolean());
        Assert.False(body.GetProperty("notifyTelegram").GetBoolean());
    }

    [Fact]
    public async Task A_member_mutes_a_monitor_for_themselves_only()
    {
        var (_, client) = await AccountAsync(_factory);
        var id = await CreatedAsync(client, Monitor(await PersonalScopeAsync(client)));

        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(HttpMethod.Put, $"/api/v1/cloud-monitors/{id}/mutes/me")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(HttpMethod.Put, $"/api/v1/cloud-monitors/{id}/mutes/me")).StatusCode);
        Assert.True((await ReadAsync(client, id)).Body.GetProperty("muted").GetBoolean());

        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(HttpMethod.Delete, $"/api/v1/cloud-monitors/{id}/mutes/me")).StatusCode);
        Assert.False((await ReadAsync(client, id)).Body.GetProperty("muted").GetBoolean());
    }

    [Fact]
    public async Task Without_a_node_the_monitor_waits_and_the_first_node_to_connect_gets_it()
    {
        var (_, client) = await AccountAsync(_factory);
        var id = await CreatedAsync(client, Monitor(await PersonalScopeAsync(client)));
        Assert.Null(await AssignedNodeAsync(_factory, id));

        var node = await OnlineNodeAsync(_factory, "eu-1", "eu-central", _clock.GetUtcNow());
        await RebalanceAsync(_factory);

        Assert.Equal(node, await AssignedNodeAsync(_factory, id));
        Assert.Contains(DeltasFor(node), d => d.Upserts.Any(m => m.Id == id && m.Secret == "s3cret-bearer-key"));
    }
}
