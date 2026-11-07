using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.Monitoring.Contracts;
using Runova.Monitoring.Node;
using Runova.Monitoring.Tests.Link;
using Runova.Monitoring.Tests.Net;
using Runova.Website.Core.Identity;
using Runova.Website.Data.Monitoring;
using Runova.Website.IntegrationTests.Infrastructure;
using Testcontainers.RabbitMq;
using static Runova.Website.IntegrationTests.Infrastructure.TestCloudMonitors;
using static Runova.Website.IntegrationTests.Infrastructure.TestDependencies;

namespace Runova.Website.IntegrationTests.Monitoring;

/// <summary>
/// Online monitoring end to end (E55): the API on Wolverine with PostgreSQL and a real RabbitMQ,
/// the real gateway over mutual TLS, and a real node that enrolls, gets its monitor through all of
/// them, checks a health endpoint on this machine and sends its results back the same way.
/// </summary>
public sealed class OnlineMonitoringEndToEndTests(PostgresFixture postgres) : IAsyncLifetime
{
    private readonly RabbitMqContainer _rabbit = new RabbitMqBuilder("rabbitmq:4-alpine").Build();
    private readonly TestPki _pki = new();
    private readonly string _data = Path.Combine(Path.GetTempPath(), "runova-e2e-node-" + Guid.NewGuid().ToString("N"));
    private int _healthStatus = 503;
    private string _healthBody = """{ "status": "fail", "checks": { "db:connection": [{ "status": "fail", "output": "connection refused" }] } }""";
    private TestHttpServer _health = null!;
    private GatewayHarness _gateway = null!;
    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync()
    {
        await _rabbit.StartAsync(TestContext.Current.CancellationToken);
        _health = new TestHttpServer((_, stream, ct) => TestHttpServer.WriteAsync(stream, Volatile.Read(ref _healthStatus), Volatile.Read(ref _healthBody), ct: ct));
        // The gateway first, for its address; it waits for the API to tell it what to trust.
        _gateway = await GatewayHarness.StartAsync(_pki, waitForTrust: false, rabbitMq: _rabbit.GetConnectionString());
        _factory = new(
            await postgres.CreateDatabaseAsync(),
            settings: new Dictionary<string, string>
            {
                ["Monitoring:GatewayAddress"] = _gateway.NodeAddress.ToString(),
                ["RabbitMq:Uri"] = _rabbit.GetConnectionString(),
            });
        _ = _factory.Services;
        await Eventually.TrueAsync(() => _gateway.Trust.Ready, TimeSpan.FromSeconds(60));
    }

    public async ValueTask DisposeAsync()
    {
        await _gateway.DisposeAsync();
        _factory.Dispose();
        await _health.DisposeAsync();
        await _rabbit.DisposeAsync();
        _pki.Dispose();
        try
        {
            Directory.Delete(_data, recursive: true);
        }
        catch (IOException)
        {
            // SQLite may still hold the file for a moment; the temp folder is cleaned up anyway.
        }
    }

    [Fact]
    public async Task A_node_checks_an_online_monitor_and_its_outage_and_recovery_reach_the_account()
    {
        var admin = await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services, Roles.Admin));
        var created = await ApiClient.ReadJsonAsync(
            await admin.SendAsync(HttpMethod.Post, "/api/v1/monitoring-nodes", new { name = "eu-1", region = "eu-central" }), HttpStatusCode.Created);
        var nodeId = created.GetProperty("node").GetProperty("id").GetInt64();
        var token = created.GetProperty("enrollment").GetProperty("token").GetString()!;

        using var node = NodeHost.Build(
            ["--environment", "Development", "--Logging:LogLevel:Default", "Warning"],
            builder =>
            {
                // The API runs in memory here; the node reaches it through the test server.
                builder.Services.AddHttpClient(NodeIdentityStore.EnrollmentClient).ConfigurePrimaryHttpMessageHandler(() => _factory.Server.CreateHandler());
                builder.Services.Configure<NodeOptions>(o =>
                {
                    o.ApiUrl = "https://localhost/";
                    o.AllowInsecureApi = true;
                    o.EnrollmentToken = token;
                    o.DataPath = _data;
                    o.AllowPrivateAddresses = true;
                    o.GatewayCaPem = _pki.GatewayCaPem;
                    o.HeartbeatEvery = TimeSpan.FromMilliseconds(500);
                    o.BatchEvery = TimeSpan.FromMilliseconds(100);
                    o.StartSpread = TimeSpan.Zero;
                });
            });
        await node.StartAsync(TestContext.Current.CancellationToken);
        try
        {
            await Eventually.TrueAsync(() => NodeStatus(nodeId) == NodeStatuses.Online, TimeSpan.FromSeconds(60));

            // Made as the API makes one, but for an address on this machine, which only a test may check.
            var (user, client) = await AccountAsync(_factory);
            var scope = await PersonalScopeAsync(client);
            var monitorId = await WithDbAsync(_factory, async db =>
            {
                var monitor = new CloudMonitor
                {
                    ScopeId = scope,
                    ItemId = "t-api",
                    Name = "API",
                    ProjectName = "Storefront",
                    Url = _health.Url().ToString(),
                    // The node's floor, so the test sees a recovery in seconds; the API would hold a type's own.
                    IntervalSec = 15,
                    TimeoutSec = 5,
                    AllowInsecure = true,
                    CreatedAt = DateTimeOffset.UtcNow,
                    UpdatedAt = DateTimeOffset.UtcNow,
                    CreatedBy = user.Id,
                };
                db.CloudMonitors.Add(monitor);
                await db.SaveChangesAsync();
                db.CloudMonitorStatuses.Add(new CloudMonitorStatus { MonitorId = monitor.Id });
                await db.SaveChangesAsync();
                return monitor.Id;
            });
            await RebalanceAsync(_factory);

            // Down: the first check fails at once, the quick recheck confirms it, and with one node its word is enough.
            await Eventually.TrueAsync(() => Incidents(monitorId).Count == 1, TimeSpan.FromSeconds(60));
            var down = Assert.Single(await NotificationsAsync(client));
            Assert.Equal("monitor-down", down.GetProperty("kind").GetString());
            Assert.Equal("API in Storefront is down", down.GetProperty("title").GetString());
            var (body, _) = await ReadAsync(client, monitorId);
            Assert.Equal("down", body.GetProperty("status").GetProperty("verdict").GetString());
            Assert.Equal("eu-central", body.GetProperty("status").GetProperty("region").GetString());
            Assert.Equal(503, body.GetProperty("status").GetProperty("httpStatus").GetInt32());

            // Up again.
            Volatile.Write(ref _healthBody, """{ "status": "pass" }""");
            Volatile.Write(ref _healthStatus, 200);
            await Eventually.TrueAsync(() => Incidents(monitorId).Single().ResolvedAt is not null, TimeSpan.FromSeconds(90));
            Assert.Contains(await NotificationsAsync(client), n => n.GetProperty("kind").GetString() == "monitor-recovered");

            var samples = await ApiClient.ReadJsonAsync(await client.GetAsync($"/api/v1/cloud-monitors/{monitorId}/samples"), HttpStatusCode.OK);
            var states = samples.GetProperty("items").EnumerateArray().Select(s => s.GetProperty("state").GetString()).ToList();
            Assert.Equal(["fail", "fail", "pass", "pass"], states.Take(4));
            Assert.All(samples.GetProperty("items").EnumerateArray(), s => Assert.Equal("eu-central", s.GetProperty("region").GetString()));
        }
        finally
        {
            await node.StopAsync(CancellationToken.None);
        }
    }

    private string? NodeStatus(long id) =>
        WithDbAsync(_factory, db => db.MonitoringNodes.AsNoTracking().Where(n => n.Id == id).Select(n => n.Status).SingleAsync()).GetAwaiter().GetResult();

    private List<CloudMonitorIncident> Incidents(long monitorId) =>
        WithDbAsync(_factory, db => db.CloudMonitorIncidents.AsNoTracking().Where(i => i.MonitorId == monitorId).ToListAsync()).GetAwaiter().GetResult();
}
