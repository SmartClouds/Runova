using System.Collections.Concurrent;
using System.Net.Http.Json;
using Google.Protobuf.WellKnownTypes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using Runova.Monitoring.Contracts;
using Runova.Monitoring.Contracts.Grpc;
using Runova.Monitoring.Core.Health;
using Runova.Monitoring.Node;
using Runova.Monitoring.Tests.Net;

namespace Runova.Monitoring.Tests.Link;

/// <summary>The node (E54): its outbox, its scheduler, and a whole run against the real gateway.</summary>
public sealed class NodeTests : IDisposable
{
    private readonly string _data = Path.Combine(Path.GetTempPath(), "runova-node-" + Guid.NewGuid().ToString("N"));
    private readonly List<IDisposable> _owned = [];

    public void Dispose()
    {
        foreach (var owned in _owned)
        {
            owned.Dispose();
        }

        try
        {
            Directory.Delete(_data, recursive: true);
        }
        catch (IOException)
        {
            // SQLite may hold the file a moment longer on Windows.
        }
    }

    private (ResultOutbox Outbox, FakeTimeProvider Clock) Outbox(int max = 1000)
    {
        Directory.CreateDirectory(_data);
        var services = new ServiceCollection();
        services.AddDbContextFactory<NodeDb>(db => db.UseSqlite($"Data Source={Path.Combine(_data, "node.db")};Pooling=False"));
        var provider = services.BuildServiceProvider();
        _owned.Add(provider);
        var factory = provider.GetRequiredService<IDbContextFactory<NodeDb>>();
        using (var db = factory.CreateDbContext())
        {
            db.Database.EnsureCreated();
        }

        var clock = new FakeTimeProvider(DateTimeOffset.UtcNow);
        return (new ResultOutbox(factory, Options.Create(new NodeOptions { MaxOutbox = max, AckTimeout = TimeSpan.FromSeconds(30) }), clock), clock);
    }

    private static CheckResult Result(long monitorId = 1) => new()
    {
        Id = Guid.CreateVersion7().ToString(),
        MonitorId = monitorId,
        MonitorVersion = 1,
        CheckedAt = Timestamp.FromDateTimeOffset(DateTimeOffset.UtcNow),
        State = "pass",
    };

    [Fact]
    public async Task The_outbox_keeps_results_until_their_batch_is_acked()
    {
        var (outbox, _) = Outbox();
        await outbox.AddAsync(Result(), TestContext.Current.CancellationToken);
        await outbox.AddAsync(Result(), TestContext.Current.CancellationToken);

        var batch = await outbox.TakeBatchAsync(10, TestContext.Current.CancellationToken);
        var nothingMore = await outbox.TakeBatchAsync(10, TestContext.Current.CancellationToken);
        await outbox.AckAsync(batch!.BatchId, TestContext.Current.CancellationToken);

        Assert.Equal(2, batch.Results.Count);
        Assert.Null(nothingMore);
        Assert.Equal(0, await outbox.CountAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task A_batch_with_no_ack_is_sent_again_after_the_timeout_or_a_reconnect()
    {
        var (outbox, clock) = Outbox();
        var result = Result();
        await outbox.AddAsync(result, TestContext.Current.CancellationToken);
        var first = await outbox.TakeBatchAsync(10, TestContext.Current.CancellationToken);

        clock.Advance(TimeSpan.FromSeconds(31));
        var again = await outbox.TakeBatchAsync(10, TestContext.Current.CancellationToken);
        await outbox.ResetInFlightAsync(TestContext.Current.CancellationToken);
        var afterReconnect = await outbox.TakeBatchAsync(10, TestContext.Current.CancellationToken);

        Assert.Equal(result.Id, Assert.Single(again!.Results).Id);
        Assert.NotEqual(first!.BatchId, again.BatchId);
        Assert.Equal(result.Id, Assert.Single(afterReconnect!.Results).Id);
    }

    [Fact]
    public async Task Past_its_cap_the_outbox_drops_the_oldest()
    {
        var (outbox, clock) = Outbox(max: 3);
        var ids = new List<string>();
        for (var i = 0; i < 5; i++)
        {
            var result = Result();
            ids.Add(result.Id);
            await outbox.AddAsync(result, TestContext.Current.CancellationToken);
            clock.Advance(TimeSpan.FromSeconds(1));
        }

        var batch = await outbox.TakeBatchAsync(10, TestContext.Current.CancellationToken);

        Assert.Equal(ids.Skip(2), batch!.Results.Select(r => r.Id));
    }

    [Fact]
    public async Task The_scheduler_checks_each_monitor_on_its_interval_and_never_more_at_once_than_allowed()
    {
        var (outbox, _) = Outbox();
        var clock = new FakeTimeProvider(DateTimeOffset.UtcNow);
        var probe = new GatedProbe(clock);
        var scheduler = new CheckScheduler(
            probe, outbox, Options.Create(new NodeOptions { Concurrency = 2, StartSpread = TimeSpan.Zero }), clock,
            Microsoft.Extensions.Logging.Abstractions.NullLogger<CheckScheduler>.Instance);
        var snapshot = new AssignmentSnapshot { AssignmentVersion = 4 };
        for (var i = 1; i <= 5; i++)
        {
            snapshot.Monitors.Add(new MonitorDefinition { Id = i, Version = 1, Url = "https://example.com/health", IntervalSec = 60, TimeoutSec = 5 });
        }

        scheduler.Apply(snapshot);
        await scheduler.StartAsync(TestContext.Current.CancellationToken);
        try
        {
            await Eventually.TrueAsync(() =>
            {
                clock.Advance(TimeSpan.FromMilliseconds(250));
                return probe.Running == 2;
            });
            for (var i = 0; i < 4; i++)
            {
                clock.Advance(TimeSpan.FromMilliseconds(250));
                await Task.Delay(25, TestContext.Current.CancellationToken);
            }

            Assert.Equal(2, probe.Running);

            // The clock moves at most 10 seconds here, far from the next round, and the wait is on
            // real time, so a slow machine only takes longer.
            probe.Open();
            var opened = TimeSpan.Zero;
            await Eventually.TrueAsync(() =>
            {
                if (opened < TimeSpan.FromSeconds(10))
                {
                    clock.Advance(TimeSpan.FromMilliseconds(250));
                    opened += TimeSpan.FromMilliseconds(250);
                }

                return probe.Calls.Count >= 5;
            });

            Assert.Equal(5, probe.Calls.Distinct().Count());
            Assert.Equal(2, probe.MostAtOnce);
            Assert.Equal(4, scheduler.AssignmentVersion);

            // A check gets its next time once its result is stored, so the clock waits for that.
            await Eventually.TrueAsync(async () => scheduler.InFlight == 0 && await outbox.CountAsync(TestContext.Current.CancellationToken) == 5);

            // Nothing again until the interval (plus at most 5 percent) has passed.
            var before = probe.Calls.Count;
            clock.Advance(TimeSpan.FromSeconds(30));
            await Task.Delay(100, TestContext.Current.CancellationToken);
            Assert.Equal(before, probe.Calls.Count);
            // The first checks ran within 11 seconds of each other and of now, so each is due again
            // by 63 seconds from now (the interval plus 5 percent) and none a third time before 109.
            var later = TimeSpan.FromSeconds(30);
            await Eventually.TrueAsync(() =>
            {
                if (later < TimeSpan.FromSeconds(75))
                {
                    clock.Advance(TimeSpan.FromSeconds(3));
                    later += TimeSpan.FromSeconds(3);
                }

                return probe.Calls.Count >= before + 5;
            });

            await Eventually.TrueAsync(async () => scheduler.InFlight == 0 && await outbox.CountAsync(TestContext.Current.CancellationToken) >= 10);
            Assert.Equal(before + 5, probe.Calls.Count);
            Assert.Equal(10, await outbox.CountAsync(TestContext.Current.CancellationToken));
        }
        finally
        {
            await scheduler.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task A_delta_adds_and_removes_and_a_drain_stops_everything()
    {
        var (outbox, _) = Outbox();
        var scheduler = new CheckScheduler(
            new GatedProbe(TimeProvider.System), outbox, Options.Create(new NodeOptions()), TimeProvider.System,
            Microsoft.Extensions.Logging.Abstractions.NullLogger<CheckScheduler>.Instance);
        var snapshot = new AssignmentSnapshot { AssignmentVersion = 1 };
        snapshot.Monitors.Add(new MonitorDefinition { Id = 1, IntervalSec = 60 });
        snapshot.Monitors.Add(new MonitorDefinition { Id = 2, IntervalSec = 60 });
        scheduler.Apply(snapshot);

        var delta = new AssignmentDelta { AssignmentVersion = 2 };
        delta.Removed.Add(1);
        delta.Upserts.Add(new MonitorDefinition { Id = 3, IntervalSec = 60 });
        scheduler.Apply(delta);

        Assert.Equal(2, scheduler.Count);
        Assert.Equal(2, scheduler.AssignmentVersion);
        scheduler.Clear();
        Assert.Equal(0, scheduler.Count);
    }

    [Fact]
    public void A_result_carries_the_failing_services_but_not_the_passing_ones()
    {
        var report = HealthParser.Parse(new HealthResponseInput(
            200, "application/health+json",
            """{ "status": "fail", "checks": { "db:connection": [{ "status": "fail", "output": "refused" }], "cache": [{ "status": "pass" }] } }""",
            42, DateTimeOffset.UtcNow));

        var result = CheckScheduler.ToResult(new MonitorDefinition { Id = 9, Version = 3 }, report, "c-1");

        Assert.Equal("fail", result.State);
        Assert.Equal(42, result.LatencyMs);
        Assert.Equal("c-1", result.ConfirmId);
        var service = Assert.Single(result.Services);
        Assert.Equal(("db:connection", "fail", "refused"), (service.Key, service.Status, service.Message));
        Assert.Equal(7, Guid.Parse(result.Id).Version);
    }

    [Fact]
    public void The_healthcheck_is_healthy_only_while_the_loop_touches_its_file()
    {
        Assert.Equal(1, Healthz.Check(_data));

        Healthz.Touch(_data);

        Assert.Equal(0, Healthz.Check(_data));
    }

    [Fact]
    public async Task A_node_enrolls_connects_checks_and_sends_what_it_kept_while_the_gateway_was_away()
    {
        using var pki = new TestPki();
        await using var health = TestHttpServer.Answering(200, """{ "status": "pass" }""");
        var gateway = await GatewayHarness.StartAsync(pki);
        await using var api = await FakeEnrollmentApi.StartAsync(pki, 77, gateway.NodeAddress);
        using var node = NodeHost.Build(
            ["--environment", "Development", "--Logging:LogLevel:Default", "Warning"],
            builder => builder.Services.Configure<NodeOptions>(o =>
            {
                o.ApiUrl = api.Address.ToString();
                o.AllowInsecureApi = true;
                o.EnrollmentToken = "rnn_test";
                o.DataPath = _data;
                o.AllowPrivateAddresses = true;
                o.GatewayCaPem = pki.GatewayCaPem;
                o.HeartbeatEvery = TimeSpan.FromMilliseconds(500);
                o.BatchEvery = TimeSpan.FromMilliseconds(100);
                o.StartSpread = TimeSpan.Zero;
            }));
        await node.StartAsync(TestContext.Current.CancellationToken);
        try
        {
            await Eventually.TrueAsync(() => gateway.Link.Of<NodeConnected>().Any(c => c.NodeId == 77));
            Assert.Equal("rnn_test", Assert.Single(api.Tokens));

            // The API gives it a monitor; the first check runs at once and its result comes back.
            var snapshot = new AssignmentSnapshot { AssignmentVersion = 1 };
            snapshot.Monitors.Add(new MonitorDefinition { Id = 5, Version = 1, Url = health.Url().ToString(), IntervalSec = 60, TimeoutSec = 5, AllowInsecure = true });
            await gateway.Sessions.DeliverAsync(77, new ServerMessage { Snapshot = snapshot }, TestContext.Current.CancellationToken);
            await Eventually.TrueAsync(() => gateway.Link.Of<CheckResultBatch>().SelectMany(b => b.Results).Any(r => r.MonitorId == 5));
            var first = gateway.Link.Of<CheckResultBatch>().SelectMany(b => b.Results).First(r => r.MonitorId == 5);
            Assert.Equal("pass", first.State);
            Assert.Equal(200, first.HttpStatus);
            Assert.All(gateway.Link.Of<CheckResultBatch>(), b => Assert.Equal(77, b.NodeId));
            await Eventually.TrueAsync(() => gateway.Link.Of<NodeHeartbeat>().Any(h => h.Monitors == 1));

            // The gateway goes away; checks go on and wait in the outbox.
            var port = gateway.NodeAddress.Port;
            await gateway.DisposeAsync();
            var scheduler = node.Services.GetRequiredService<CheckScheduler>();
            var outbox = node.Services.GetRequiredService<ResultOutbox>();
            for (var i = 0; i < 3; i++)
            {
                await scheduler.ConfirmAsync(new ConfirmCheck { ConfirmId = $"away-{i}", Monitor = snapshot.Monitors[0] }, TestContext.Current.CancellationToken);
            }

            Assert.Equal(3, await outbox.CountAsync(TestContext.Current.CancellationToken));

            // It comes back on the same address: the node reconnects and sends them, and they leave the outbox.
            gateway = await GatewayHarness.StartAsync(pki, nodePort: port);
            await Eventually.TrueAsync(
                () => gateway.Link.Of<CheckResultBatch>().SelectMany(b => b.Results).Count(r => r.ConfirmId?.StartsWith("away-", StringComparison.Ordinal) == true) >= 3,
                TimeSpan.FromSeconds(30));
            await Eventually.TrueAsync(() => outbox.CountAsync().Result == 0);
            var away = gateway.Link.Of<CheckResultBatch>().SelectMany(b => b.Results).Where(r => r.ConfirmId?.StartsWith("away-", StringComparison.Ordinal) == true).ToList();
            Assert.Equal(3, away.Select(r => r.Id).Distinct().Count());
            Assert.Equal(["away-0", "away-1", "away-2"], away.Select(r => r.ConfirmId).Distinct().Order());
        }
        finally
        {
            await node.StopAsync(CancellationToken.None);
            await gateway.DisposeAsync();
        }
    }

    [Fact]
    public async Task A_node_without_a_token_or_with_a_refused_one_does_not_connect()
    {
        using var pki = new TestPki();
        await using var gateway = await GatewayHarness.StartAsync(pki);
        await using var api = await FakeEnrollmentApi.StartAsync(pki, 77, gateway.NodeAddress, refuse: true);
        using var node = NodeHost.Build(
            ["--environment", "Development", "--Logging:LogLevel:Default", "None"],
            builder => builder.Services.Configure<NodeOptions>(o =>
            {
                o.ApiUrl = api.Address.ToString();
                o.AllowInsecureApi = true;
                o.EnrollmentToken = "rnn_used";
                o.DataPath = _data;
            }));

        await node.StartAsync(TestContext.Current.CancellationToken);
        await Eventually.TrueAsync(() => !api.Tokens.IsEmpty);
        await Task.Delay(500, TestContext.Current.CancellationToken);
        await node.StopAsync(CancellationToken.None);

        Assert.Empty(gateway.Link.Of<NodeConnected>());
        Assert.False(File.Exists(Path.Combine(_data, "node.key")));
    }

    [Fact]
    public void A_production_node_can_not_be_allowed_private_addresses()
    {
        using var node = NodeHost.Build(
            ["--environment", "Production"],
            builder => builder.Services.Configure<NodeOptions>(o =>
            {
                o.DataPath = _data;
                o.AllowPrivateAddresses = true;
            }));

        var refused = Assert.Throws<OptionsValidationException>(() => node.Services.GetRequiredService<IOptions<NodeOptions>>().Value);
        Assert.Contains("Development", refused.Message, StringComparison.Ordinal);
    }

    /// <summary>Answers each probe once the test opens the gate, and counts how many ran at once.</summary>
    private sealed class GatedProbe(TimeProvider clock) : IMonitorProbe
    {
        private readonly TaskCompletionSource _gate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _running;
        private int _most;

        public ConcurrentQueue<long> Calls { get; } = new();

        public int Running => Volatile.Read(ref _running);

        public int MostAtOnce => Volatile.Read(ref _most);

        public void Open() => _gate.TrySetResult();

        public async Task<HealthReport> ProbeAsync(MonitorDefinition monitor, CancellationToken ct)
        {
            var now = Interlocked.Increment(ref _running);
            int seen;
            while (now > (seen = Volatile.Read(ref _most)) && Interlocked.CompareExchange(ref _most, now, seen) != seen)
            {
            }

            Calls.Enqueue(monitor.Id);
            try
            {
                await _gate.Task.WaitAsync(ct);
                return HealthParser.Parse(new HealthResponseInput(200, "application/health+json", """{ "status": "pass" }""", 5, clock.GetUtcNow()));
            }
            finally
            {
                Interlocked.Decrement(ref _running);
            }
        }
    }
}

/// <summary>The API's enrollment endpoint, signing with the test CA.</summary>
internal sealed class FakeEnrollmentApi : IAsyncDisposable
{
    private readonly WebApplication _app;

    private FakeEnrollmentApi(WebApplication app, Uri address)
    {
        _app = app;
        Address = address;
    }

    public Uri Address { get; }

    public ConcurrentQueue<string> Tokens { get; } = new();

    public static async Task<FakeEnrollmentApi> StartAsync(TestPki pki, long nodeId, Uri gateway, bool refuse = false)
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        var app = builder.Build();
        FakeEnrollmentApi? self = null;
        app.MapPost("/api/v1/monitoring-node-enrollments", async (HttpContext http) =>
        {
            var body = await http.Request.ReadFromJsonAsync<Request>();
            self!.Tokens.Enqueue(body!.Token);
            if (refuse)
            {
                return Results.Problem(statusCode: 401);
            }

            using var certificate = pki.SignCsr(nodeId, Convert.FromBase64String(body.Csr));
            return Results.Json(new
            {
                nodeId,
                certificate = Convert.ToBase64String(certificate.RawData),
                caCertificates = new[] { Convert.ToBase64String(pki.Ca.RawData) },
                gatewayAddress = gateway.ToString(),
                expiresAt = certificate.NotAfter,
            }, statusCode: 201);
        });
        await app.StartAsync();
        var address = new Uri(app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single());
        self = new FakeEnrollmentApi(app, address);
        return self;
    }

    public async ValueTask DisposeAsync()
    {
        await _app.StopAsync();
        await _app.DisposeAsync();
    }

    private sealed record Request(string Token, string Csr);
}
