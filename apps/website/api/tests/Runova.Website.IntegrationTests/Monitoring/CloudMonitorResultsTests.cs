using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Runova.Monitoring.Contracts.Grpc;
using Runova.Website.Api.CloudMonitoring;
using Runova.Website.Api.Monitoring;
using Runova.Website.Api.Telegram;
using Runova.Website.Data.Monitoring;
using Runova.Website.IntegrationTests.Infrastructure;
using static Runova.Website.IntegrationTests.Infrastructure.TestCloudMonitors;
using static Runova.Website.IntegrationTests.Infrastructure.TestDependencies;

namespace Runova.Website.IntegrationTests.Monitoring;

/// <summary>What the API makes of the nodes' results (E55): samples, hours, incidents, the second opinion and who hears.</summary>
public sealed class CloudMonitorResultsTests(PostgresFixture postgres) : IAsyncLifetime
{
    private readonly FakeTimeProvider _clock = new(new DateTimeOffset(2026, 11, 7, 9, 0, 0, TimeSpan.Zero));
    private readonly FakeNodeBus _bus = new();
    private readonly FakeTelegram _telegram = new();
    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync() => _factory = new(
        await postgres.CreateDatabaseAsync(),
        time: _clock,
        settings: FakeTelegram.Settings,
        services: services =>
        {
            _bus.Register(services);
            _telegram.Register(services);
        });

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    private DateTimeOffset Now => _clock.GetUtcNow();

    private IEnumerable<ConfirmCheck> ConfirmsTo(long nodeId) =>
        _bus.Sent.Where(s => s.NodeId == nodeId && s.Message.BodyCase == ServerMessage.BodyOneofCase.Confirm).Select(s => s.Message.Confirm);

    private async Task SendTelegramAsync()
    {
        using var scope = _factory.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<TelegramOutboxJob>().RunAsync(TestContext.Current.CancellationToken);
    }

    private Task<List<CloudMonitorIncident>> IncidentsAsync(long id) =>
        WithDbAsync(_factory, db => db.CloudMonitorIncidents.AsNoTracking().Where(i => i.MonitorId == id).OrderBy(i => i.Id).ToListAsync());

    private Task<int> SampleCountAsync(long id) => WithDbAsync(_factory, db => db.CloudMonitorSamples.CountAsync(s => s.MonitorId == id));

    [Fact]
    public async Task A_batch_sent_twice_is_stored_once()
    {
        var node = await OnlineNodeAsync(_factory, "eu-1", "eu-central", Now);
        var (_, client) = await AccountAsync(_factory);
        var id = await CreatedAsync(client, Monitor(await PersonalScopeAsync(client)));
        var results = new[] { Result(id, "pass", Now), Result(id, "pass", Now.AddMinutes(5)) };

        await IngestAsync(_factory, node, results);
        var again = await IngestAsync(_factory, node, results);

        Assert.NotNull(again);
        Assert.Equal(2, await SampleCountAsync(id));
        var hour = await WithDbAsync(_factory, db => db.CloudMonitorHours.AsNoTracking().SingleAsync(h => h.MonitorId == id));
        Assert.Equal(2, hour.Checks);
        Assert.Equal(240, hour.LatencySumMs);
        var (body, _) = await ReadAsync(client, id);
        Assert.Equal("up", body.GetProperty("status").GetProperty("verdict").GetString());
        Assert.Equal("eu-central", body.GetProperty("status").GetProperty("region").GetString());
    }

    [Fact]
    public async Task Two_failures_on_one_node_and_one_on_another_open_one_incident_and_tell_each_member_once()
    {
        var eu = await OnlineNodeAsync(_factory, "eu-1", "eu-central", Now);
        var (owner, ownerClient) = await AccountAsync(_factory);
        var (kim, kimClient) = await AccountAsync(_factory, "Kim");
        var (lee, leeClient) = await AccountAsync(_factory, "Lee");
        var team = await CreateTeamAsync(ownerClient);
        await JoinAsync(ownerClient, team, kim, kimClient);
        await JoinAsync(ownerClient, team, lee, leeClient, "viewer");
        var id = await CreatedAsync(ownerClient, Monitor(await TeamScopeAsync(ownerClient, team), notifyTelegram: true));
        var us = await OnlineNodeAsync(_factory, "us-1", "us-east", Now);
        await LinkTelegramAsync(_factory, owner.Id, 1001);
        await LinkTelegramAsync(_factory, kim.Id, 1002);

        await IngestAsync(_factory, eu, Result(id, "pass", Now), Result(id, "unreachable", Now.AddMinutes(5)), Result(id, "unreachable", Now.AddMinutes(5.25)));

        // The first node's word is not enough with another region to ask.
        Assert.Empty(await IncidentsAsync(id));
        var confirm = Assert.Single(ConfirmsTo(us));
        Assert.Equal(id, confirm.Monitor.Id);
        Assert.Equal("s3cret-bearer-key", confirm.Monitor.Secret);
        Assert.Empty(await NotificationsAsync(ownerClient));

        await IngestAsync(_factory, us, Result(id, "unreachable", Now.AddMinutes(5.5), confirmId: confirm.ConfirmId));
        // The first node's next failure changes nothing more.
        await IngestAsync(_factory, eu, Result(id, "unreachable", Now.AddMinutes(10)));

        var incident = Assert.Single(await IncidentsAsync(id));
        Assert.Equal(Now.AddMinutes(5.25), incident.OpenedAt);
        Assert.Equal(us, incident.ConfirmedByNodeId);
        foreach (var member in new[] { ownerClient, kimClient, leeClient })
        {
            var notification = Assert.Single(await NotificationsAsync(member));
            Assert.Equal("monitor-down", notification.GetProperty("kind").GetString());
            Assert.Equal("API in Storefront (Production) is down", notification.GetProperty("title").GetString());
            Assert.Equal("t-api", notification.GetProperty("itemId").GetString());
        }

        await SendTelegramAsync();
        Assert.StartsWith("🔴 API in Storefront (Production) is down", Assert.Single(_telegram.SentTo(1001)), StringComparison.Ordinal);
        Assert.Single(_telegram.SentTo(1002));
        var (body, _) = await ReadAsync(ownerClient, id);
        Assert.Equal("down", body.GetProperty("status").GetProperty("verdict").GetString());
        Assert.Equal(incident.Id, body.GetProperty("status").GetProperty("openIncident").GetProperty("id").GetInt64());
    }

    [Fact]
    public async Task A_second_opinion_that_passes_opens_nothing()
    {
        var eu = await OnlineNodeAsync(_factory, "eu-1", "eu-central", Now);
        var (_, client) = await AccountAsync(_factory);
        var id = await CreatedAsync(client, Monitor(await PersonalScopeAsync(client)));
        var us = await OnlineNodeAsync(_factory, "us-1", "us-east", Now);

        await IngestAsync(_factory, eu, Result(id, "pass", Now), Result(id, "fail", Now.AddMinutes(5)), Result(id, "fail", Now.AddMinutes(5.25)));
        var confirm = Assert.Single(ConfirmsTo(us));
        await IngestAsync(_factory, us, Result(id, "pass", Now.AddMinutes(5.5), confirmId: confirm.ConfirmId));

        Assert.Empty(await IncidentsAsync(id));
        Assert.Empty(await NotificationsAsync(client));
        var (body, _) = await ReadAsync(client, id);
        Assert.False(body.GetProperty("status").GetProperty("confirming").GetBoolean());
    }

    [Fact]
    public async Task With_one_node_its_word_is_enough_and_recovery_is_told_too()
    {
        var eu = await OnlineNodeAsync(_factory, "eu-1", "eu-central", Now);
        var (_, client) = await AccountAsync(_factory);
        var id = await CreatedAsync(client, Monitor(await PersonalScopeAsync(client)));

        await IngestAsync(_factory, eu, Result(id, "pass", Now), Result(id, "fail", Now.AddMinutes(5)), Result(id, "fail", Now.AddMinutes(5.25)));
        Assert.Single(await IncidentsAsync(id));
        await IngestAsync(_factory, eu, Result(id, "pass", Now.AddMinutes(30)), Result(id, "pass", Now.AddMinutes(30.25)));

        var incident = Assert.Single(await IncidentsAsync(id));
        Assert.Equal(Now.AddMinutes(30.25), incident.ResolvedAt);
        var notifications = await NotificationsAsync(client);
        Assert.Equal(["monitor-recovered", "monitor-down"], notifications.Select(n => n.GetProperty("kind").GetString()));
        Assert.Equal("It was down for 25 minutes.", notifications[0].GetProperty("body").GetString());
        Assert.DoesNotContain(_bus.Sent, s => s.Message.BodyCase == ServerMessage.BodyOneofCase.Confirm);
    }

    [Fact]
    public async Task A_second_opinion_that_never_comes_leaves_the_first_nodes_word()
    {
        var eu = await OnlineNodeAsync(_factory, "eu-1", "eu-central", Now);
        var (_, client) = await AccountAsync(_factory);
        var id = await CreatedAsync(client, Monitor(await PersonalScopeAsync(client)));
        await OnlineNodeAsync(_factory, "us-1", "us-east", Now);

        await IngestAsync(_factory, eu, Result(id, "fail", Now), Result(id, "fail", Now.AddMinutes(0.25)));
        Assert.Empty(await IncidentsAsync(id));
        _clock.Advance(TimeSpan.FromMinutes(5));
        await IngestAsync(_factory, eu, Result(id, "fail", Now));

        var incident = Assert.Single(await IncidentsAsync(id));
        Assert.Null(incident.ConfirmedByNodeId);
    }

    [Fact]
    public async Task Muted_members_and_monitors_with_alerts_off_hear_nothing()
    {
        var eu = await OnlineNodeAsync(_factory, "eu-1", "eu-central", Now);
        var (owner, ownerClient) = await AccountAsync(_factory);
        var (kim, kimClient) = await AccountAsync(_factory, "Kim");
        var team = await CreateTeamAsync(ownerClient);
        await JoinAsync(ownerClient, team, kim, kimClient);
        var scope = await TeamScopeAsync(ownerClient, team);
        await GrantAsync(_factory, owner.Id, Go);
        var muted = await CreatedAsync(ownerClient, Monitor(scope, "t-1"));
        var quiet = await CreatedAsync(ownerClient, Monitor(scope, "t-2", name: "Worker"));
        await PatchAsync(ownerClient, quiet, new { notifyInApp = false });
        await kimClient.SendAsync(HttpMethod.Put, $"/api/v1/cloud-monitors/{muted}/mutes/me");
        await LinkTelegramAsync(_factory, owner.Id, 1001);

        await IngestAsync(_factory, eu, Result(muted, "fail", Now), Result(muted, "fail", Now.AddSeconds(15)), Result(quiet, "fail", Now), Result(quiet, "fail", Now.AddSeconds(15)));

        Assert.Single(await IncidentsAsync(muted));
        Assert.Single(await IncidentsAsync(quiet));
        // The owner's other message is billing's, about the plan.
        var down = Assert.Single(await NotificationsAsync(ownerClient), n => n.GetProperty("kind").GetString() == "monitor-down");
        Assert.Equal("API in Storefront (Production) is down", down.GetProperty("title").GetString());
        Assert.Empty(await NotificationsAsync(kimClient));
        // Telegram is off for both monitors.
        await SendTelegramAsync();
        Assert.Empty(_telegram.SentTo(1001));
    }

    [Fact]
    public async Task Results_for_a_monitor_on_another_node_or_an_old_version_are_dropped()
    {
        var eu = await OnlineNodeAsync(_factory, "eu-1", "eu-central", Now);
        var (_, client) = await AccountAsync(_factory);
        var id = await CreatedAsync(client, Monitor(await PersonalScopeAsync(client)));
        var other = await OnlineNodeAsync(_factory, "us-1", "us-east", Now);
        await PatchAsync(client, id, new { url = "https://edge.example.com/health" });

        await IngestAsync(_factory, other, Result(id, "pass", Now, version: 2));
        await IngestAsync(_factory, eu, Result(id, "pass", Now, version: 1));
        await IngestAsync(_factory, eu, Result(id, "fail", Now, version: 2, confirmId: Guid.NewGuid().ToString()));
        Assert.Equal(0, await SampleCountAsync(id));

        await IngestAsync(_factory, eu, Result(id, "pass", Now, version: 2));
        Assert.Equal(1, await SampleCountAsync(id));
    }

    [Fact]
    public async Task Samples_past_the_types_history_go_and_hours_and_incidents_stay()
    {
        var eu = await OnlineNodeAsync(_factory, "eu-1", "eu-central", Now);
        var (user, client) = await AccountAsync(_factory);
        var id = await CreatedAsync(client, Monitor(await PersonalScopeAsync(client)));
        var start = Now;
        await IngestAsync(_factory, eu, Result(id, "fail", start), Result(id, "fail", start.AddSeconds(15)), Result(id, "pass", start.AddMinutes(5)), Result(id, "pass", start.AddMinutes(5.25)));
        _clock.Advance(TimeSpan.FromDays(6));
        await IngestAsync(_factory, eu, Result(id, "pass", Now));
        _clock.Advance(TimeSpan.FromDays(2));

        using (var scope = _factory.Services.CreateScope())
        {
            await scope.ServiceProvider.GetRequiredService<SampleRetentionJob>().RunAsync(TestContext.Current.CancellationToken);
        }

        // Free keeps 7 days: the first four samples went, the one from day 6 stayed.
        Assert.Equal(1, await SampleCountAsync(id));
        Assert.Equal(2, await WithDbAsync(_factory, db => db.CloudMonitorHours.CountAsync(h => h.MonitorId == id)));
        Assert.Single(await IncidentsAsync(id));
        // Eight days on, the session has run out; sign in again.
        client = await TestAccounts.SignedInClientAsync(_factory, user);
        var hours = await ApiClient.ReadJsonAsync(
            await client.GetAsync($"/api/v1/cloud-monitors/{id}/hours?from={Uri.EscapeDataString(start.AddDays(-1).ToString("O"))}"),
            HttpStatusCode.OK);
        var first = hours.GetProperty("items")[0];
        Assert.Equal(4, first.GetProperty("checks").GetInt32());
        Assert.Equal(2, first.GetProperty("failures").GetInt32());
        var incidents = await ApiClient.ReadJsonAsync(await client.GetAsync($"/api/v1/cloud-monitors/{id}/incidents"), HttpStatusCode.OK);
        Assert.Single(incidents.GetProperty("items").EnumerateArray());
    }

    [Fact]
    public async Task Samples_come_back_newest_last_for_the_time_asked()
    {
        var eu = await OnlineNodeAsync(_factory, "eu-1", "eu-central", Now);
        var (_, client) = await AccountAsync(_factory);
        var id = await CreatedAsync(client, Monitor(await PersonalScopeAsync(client)));
        await IngestAsync(_factory, eu, Result(id, "pass", Now.AddMinutes(-10), latencyMs: 90), Result(id, "warn", Now.AddMinutes(-5)), Result(id, "pass", Now));

        var samples = await ApiClient.ReadJsonAsync(await client.GetAsync($"/api/v1/cloud-monitors/{id}/samples"), HttpStatusCode.OK);

        var items = samples.GetProperty("items").EnumerateArray().ToList();
        Assert.Equal(["pass", "warn", "pass"], items.Select(i => i.GetProperty("state").GetString()));
        Assert.Equal(90, items[0].GetProperty("latencyMs").GetInt32());
        Assert.Equal("eu-central", items[0].GetProperty("region").GetString());
        var (body, _) = await ReadAsync(client, id);
        Assert.Equal("up", body.GetProperty("status").GetProperty("verdict").GetString());

        await ProblemAssert.IsAsync(await client.GetAsync($"/api/v1/cloud-monitors/{id}/samples?from=yesterday"), HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task When_the_owners_type_goes_down_the_team_is_brought_within_it_and_told()
    {
        var (owner, ownerClient) = await AccountAsync(_factory);
        var (kim, kimClient) = await AccountAsync(_factory, "Kim");
        var team = await CreateTeamAsync(ownerClient);
        await JoinAsync(ownerClient, team, kim, kimClient);
        var scope = await TeamScopeAsync(ownerClient, team);
        await GrantAsync(_factory, owner.Id, Pro);
        var ids = new List<long>();
        for (var i = 0; i < 3; i++)
        {
            ids.Add(await CreatedAsync(kimClient, Monitor(scope, $"t-{i}", intervalSec: 60)));
            _clock.Advance(TimeSpan.FromMinutes(1));
        }

        await GrantAsync(_factory, owner.Id, null);

        var rows = await WithDbAsync(_factory, db => db.CloudMonitors.AsNoTracking().Where(m => ids.Contains(m.Id)).OrderBy(m => m.Id).ToListAsync());
        Assert.Equal([false, true, true], rows.Select(m => m.Paused));
        Assert.Equal([null, SuspendedReasons.OverLimit, SuspendedReasons.OverLimit], rows.Select(m => m.SuspendedReason));
        Assert.All(rows, m => Assert.Equal(300, m.IntervalSec));
        foreach (var member in new[] { ownerClient, kimClient })
        {
            // The owner also hears from billing that the plan changed.
            var notice = Assert.Single(await NotificationsAsync(member), n => n.GetProperty("kind").GetString() == "monitor-plan");
            Assert.Equal("monitor-plan", notice.GetProperty("kind").GetString());
            Assert.Equal("Online monitors in Platform changed", notice.GetProperty("title").GetString());
        }

        // Resuming one Runova paused still has to fit.
        await ProblemAssert.IsAsync(await PatchAsync(kimClient, ids[1], new { paused = false }), HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task A_node_that_goes_quiet_hands_its_monitors_to_the_others()
    {
        var eu = await OnlineNodeAsync(_factory, "eu-1", "eu-central", Now);
        var (user, client) = await AccountAsync(_factory);
        await GrantAsync(_factory, user.Id, Go);
        var scope = await PersonalScopeAsync(client);
        var ids = new List<long>();
        for (var i = 0; i < 4; i++)
        {
            ids.Add(await CreatedAsync(client, Monitor(scope, $"t-{i}")));
        }

        var us = await OnlineNodeAsync(_factory, "us-1", "us-east", Now);
        await RebalanceAsync(_factory);
        var spread = await WithDbAsync(_factory, db => db.CloudMonitorStatuses.AsNoTracking().Where(m => ids.Contains(m.MonitorId)).Select(m => m.NodeId).ToListAsync());
        Assert.Equal(2, spread.Count(n => n == eu));
        Assert.Equal(2, spread.Count(n => n == us));

        _clock.Advance(TimeSpan.FromMinutes(2));
        await WithDbAsync(_factory, db => db.MonitoringNodes.Where(n => n.Id == us).ExecuteUpdateAsync(n => n.SetProperty(x => x.LastSeenAt, _clock.GetUtcNow())));
        using (var job = _factory.Services.CreateScope())
        {
            await job.ServiceProvider.GetRequiredService<NodeLivenessJob>().RunAsync(TestContext.Current.CancellationToken);
        }

        var after = await WithDbAsync(_factory, db => db.CloudMonitorStatuses.AsNoTracking().Where(m => ids.Contains(m.MonitorId)).Select(m => m.NodeId).ToListAsync());
        Assert.All(after, n => Assert.Equal(us, n));
        var snapshot = await WithDbAsync(_factory, async db =>
        {
            using var scope2 = _factory.Services.CreateScope();
            return await scope2.ServiceProvider.GetRequiredService<IAssignmentSource>().ForNodeAsync(us, TestContext.Current.CancellationToken);
        });
        Assert.Equal(ids.Order(), snapshot.Select(m => m.Id).Order());
        Assert.All(snapshot, m => Assert.Equal("s3cret-bearer-key", m.Secret));
    }
}
