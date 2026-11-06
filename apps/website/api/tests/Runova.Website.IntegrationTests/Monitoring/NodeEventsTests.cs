using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Runova.Monitoring.Contracts;
using Runova.Monitoring.Contracts.Grpc;
using Runova.Website.Api.Monitoring;
using Runova.Website.Core.Identity;
using Runova.Website.Data;
using Runova.Website.Data.Monitoring;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Monitoring;

/// <summary>What the API does with what the gateways tell it (E54), and the liveness job.</summary>
public sealed class NodeEventsTests(PostgresFixture postgres) : IAsyncLifetime
{
    private readonly FakeTimeProvider _clock = new(new DateTimeOffset(2026, 11, 6, 12, 0, 0, TimeSpan.Zero));
    private readonly FakeNodeBus _bus = new();
    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync() => _factory = new(
        await postgres.CreateDatabaseAsync(),
        time: _clock,
        settings: new Dictionary<string, string> { ["Monitoring:GatewayAddress"] = "https://nodes.runovahq.test" },
        services: _bus.Register);

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    /// <summary>An enrolled node: its id, key and certificate.</summary>
    private async Task<(long Id, ECDsa Key, X509Certificate2 Certificate)> EnrolledNodeAsync(string name = "eu-1", string[]? allowed = null)
    {
        var admin = await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services, Roles.Admin));
        var created = await ApiClient.ReadJsonAsync(
            await admin.SendAsync(HttpMethod.Post, "/api/v1/monitoring-nodes", new { name, region = "eu-central", allowedAddresses = allowed ?? [] }),
            HttpStatusCode.Created);
        var (key, csr) = TestNodeKeys.NewCsr();
        var enrolled = await ApiClient.ReadJsonAsync(
            await _factory.CreateApiClient().SendAsync(HttpMethod.Post, "/api/v1/monitoring-node-enrollments", new
            {
                token = created.GetProperty("enrollment").GetProperty("token").GetString(),
                csr = Convert.ToBase64String(csr),
            }),
            HttpStatusCode.Created);
        var certificate = X509CertificateLoader.LoadCertificate(Convert.FromBase64String(enrolled.GetProperty("certificate").GetString()!));
        return (enrolled.GetProperty("nodeId").GetInt64(), key, certificate);
    }

    private async Task<T> WithAsync<T>(Func<NodeEvents, AppDbContext, Task<T>> run)
    {
        using var scope = _factory.Services.CreateScope();
        return await run(scope.ServiceProvider.GetRequiredService<NodeEvents>(), scope.ServiceProvider.GetRequiredService<AppDbContext>());
    }

    private Task<MonitoringNode> NodeAsync(long id) => WithAsync((_, db) => db.MonitoringNodes.AsNoTracking().SingleAsync(n => n.Id == id));

    private NodeConnected Connected(long id, X509Certificate2 certificate, string gateway = "gw-1", string address = "203.0.113.7") =>
        new(id, gateway, "1.0.0", 0, 64, address, certificate.SerialNumber, _clock.GetUtcNow());

    [Fact]
    public async Task A_good_node_goes_online_and_gets_its_snapshot()
    {
        var (id, _, certificate) = await EnrolledNodeAsync();

        await WithAsync(async (events, _) => { await events.ConnectedAsync(Connected(id, certificate)); return 0; });

        var node = await NodeAsync(id);
        Assert.Equal(NodeStatuses.Online, node.Status);
        Assert.Equal("gw-1", node.GatewayId);
        Assert.Equal("203.0.113.7", node.RemoteAddress);
        Assert.Equal("1.0.0", node.SoftwareVersion);
        var (nodeId, message) = Assert.Single(_bus.Sent);
        Assert.Equal(id, nodeId);
        Assert.Equal(1, message.Snapshot.AssignmentVersion);
        Assert.Equal(1, node.AssignmentVersion);
    }

    [Fact]
    public async Task A_certificate_the_database_does_not_know_or_revoked_is_closed()
    {
        var (id, _, certificate) = await EnrolledNodeAsync();
        var unknown = Connected(id, certificate) with { CertificateSerial = "00AB" };

        await WithAsync(async (events, _) => { await events.ConnectedAsync(unknown); return 0; });

        var (nodeId, serials) = Assert.Single(_bus.Revoked);
        Assert.Equal(id, nodeId);
        Assert.Equal(["00AB"], serials);
        Assert.Equal(NodeStatuses.Offline, (await NodeAsync(id)).Status);
        Assert.Empty(_bus.Sent);
    }

    [Fact]
    public async Task A_node_on_an_address_its_list_does_not_hold_is_closed()
    {
        var (id, _, certificate) = await EnrolledNodeAsync(allowed: ["198.51.100.0/24"]);

        await WithAsync(async (events, _) => { await events.ConnectedAsync(Connected(id, certificate, address: "203.0.113.7")); return 0; });
        await WithAsync(async (events, _) => { await events.ConnectedAsync(Connected(id, certificate, address: "198.51.100.20")); return 0; });

        Assert.Single(_bus.Closed);
        Assert.Equal(NodeStatuses.Online, (await NodeAsync(id)).Status);
    }

    [Fact]
    public async Task Heartbeats_keep_the_numbers_and_only_its_own_gateway_takes_it_offline()
    {
        var (id, _, certificate) = await EnrolledNodeAsync();
        await WithAsync(async (events, _) => { await events.ConnectedAsync(Connected(id, certificate, gateway: "gw-2")); return 0; });

        _clock.Advance(TimeSpan.FromSeconds(10));
        await WithAsync(async (events, _) => { await events.HeartbeatAsync(new NodeHeartbeat(id, 12, 240, 3, 150, _clock.GetUtcNow())); return 0; });
        await WithAsync(async (events, _) => { await events.DisconnectedAsync(new NodeDisconnected(id, "gw-1", _clock.GetUtcNow())); return 0; });

        var node = await NodeAsync(id);
        Assert.Equal(NodeStatuses.Online, node.Status);
        Assert.Equal((12, 240, 3, 150), (node.Monitors, node.ChecksLastMinute, node.QueuedResults, node.LagMs));
        Assert.Equal(_clock.GetUtcNow(), node.LastSeenAt);

        await WithAsync(async (events, _) => { await events.DisconnectedAsync(new NodeDisconnected(id, "gw-2", _clock.GetUtcNow())); return 0; });
        Assert.Equal(NodeStatuses.Offline, (await NodeAsync(id)).Status);
    }

    [Fact]
    public async Task The_liveness_job_takes_a_silent_node_offline()
    {
        var (quiet, _, quietCertificate) = await EnrolledNodeAsync("quiet");
        var (busy, _, busyCertificate) = await EnrolledNodeAsync("busy");
        await WithAsync(async (events, _) =>
        {
            await events.ConnectedAsync(Connected(quiet, quietCertificate));
            await events.ConnectedAsync(Connected(busy, busyCertificate));
            return 0;
        });

        _clock.Advance(TimeSpan.FromSeconds(30));
        await WithAsync(async (events, _) => { await events.HeartbeatAsync(new NodeHeartbeat(busy, 0, 0, 0, 0, _clock.GetUtcNow())); return 0; });
        _clock.Advance(TimeSpan.FromSeconds(20));
        using (var scope = _factory.Services.CreateScope())
        {
            await scope.ServiceProvider.GetRequiredService<NodeLivenessJob>().RunAsync(TestContext.Current.CancellationToken);
        }

        Assert.Equal(NodeStatuses.Offline, (await NodeAsync(quiet)).Status);
        Assert.Null((await NodeAsync(quiet)).GatewayId);
        Assert.Equal(NodeStatuses.Online, (await NodeAsync(busy)).Status);
    }

    [Fact]
    public async Task A_node_renews_for_the_same_key_only()
    {
        var (id, key, certificate) = await EnrolledNodeAsync();
        using var other = ECDsa.Create(ECCurve.NamedCurves.nistP256);

        var renewed = await WithAsync((events, _) => events.RenewAsync(new RenewNodeCertificate(id, certificate.SerialNumber, TestNodeKeys.CsrFor(key))));
        var swapped = await WithAsync((events, _) => events.RenewAsync(new RenewNodeCertificate(id, certificate.SerialNumber, TestNodeKeys.CsrFor(other))));

        Assert.Null(renewed.Refused);
        using var fresh = X509CertificateLoader.LoadCertificate(renewed.Certificate);
        Assert.NotEqual(certificate.SerialNumber, fresh.SerialNumber);
        Assert.Equal(id, NodeCertificates.NodeIdOf(fresh));
        Assert.Contains("keep the key", swapped.Refused, StringComparison.Ordinal);
        Assert.Equal(2, await WithAsync((_, db) => db.NodeCertificates.CountAsync()));
    }

    [Fact]
    public async Task A_revoked_node_can_not_renew_and_its_serials_are_in_the_trust_list()
    {
        var (id, key, certificate) = await EnrolledNodeAsync();
        var admin = await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services, Roles.Admin));
        await admin.SendAsync(HttpMethod.Post, $"/api/v1/monitoring-nodes/{id}/revocations");

        var renewed = await WithAsync((events, _) => events.RenewAsync(new RenewNodeCertificate(id, certificate.SerialNumber, TestNodeKeys.CsrFor(key))));
        var trust = await WithAsync((events, _) => events.TrustAsync());

        Assert.NotNull(renewed.Refused);
        Assert.Empty(renewed.Certificate);
        Assert.Equal([certificate.SerialNumber], trust.RevokedSerials);
        Assert.Equal([id], trust.RevokedNodeIds);
        using var ca = X509CertificateLoader.LoadCertificate(trust.CaCertificate);
        Assert.Equal("CN=Runova Node CA, O=Runova", ca.Subject);
    }

    [Fact]
    public async Task Results_from_a_node_that_is_not_enrolled_are_dropped()
    {
        var ingested = new List<CheckResultBatch>();
        _factory.Dispose();
        _factory = new(
            await postgres.CreateDatabaseAsync(),
            time: _clock,
            settings: new Dictionary<string, string> { ["Monitoring:GatewayAddress"] = "https://nodes.runovahq.test" },
            services: services =>
            {
                _bus.Register(services);
                services.AddSingleton<IResultIngestor>(new RecordingIngestor(ingested));
            });
        var (id, _, _) = await EnrolledNodeAsync();

        await WithAsync(async (events, _) =>
        {
            await events.ResultsAsync(new CheckResultBatch(id, "b1", []));
            await events.ResultsAsync(new CheckResultBatch(id + 1000, "b2", []));
            return 0;
        });

        Assert.Equal(["b1"], ingested.Select(b => b.BatchId));
    }

    [Fact]
    public async Task The_ca_is_made_once_and_kept_sealed()
    {
        await EnrolledNodeAsync("one");
        await EnrolledNodeAsync("two");

        var authority = await WithAsync((_, db) => db.NodeAuthorities.SingleAsync());
        Assert.DoesNotContain("PRIVATE KEY", authority.SealedPrivateKey, StringComparison.Ordinal);
        Assert.Equal(2, await WithAsync((_, db) => db.NodeCertificates.CountAsync()));
    }

    [Theory]
    [InlineData(new string[0], "203.0.113.7", true)]
    [InlineData(new[] { "203.0.113.0/24" }, "203.0.113.7", true)]
    [InlineData(new[] { "203.0.113.7/32" }, "::ffff:203.0.113.7", true)]
    [InlineData(new[] { "203.0.113.0/24" }, "198.51.100.1", false)]
    [InlineData(new[] { "203.0.113.0/24" }, null, false)]
    public void The_allow_list_holds_addresses_and_ranges(string[] allowed, string? remote, bool expected) =>
        Assert.Equal(expected, NodeEvents.AddressAllowed(allowed, remote));

    private sealed class RecordingIngestor(List<CheckResultBatch> into) : IResultIngestor
    {
        public Task IngestAsync(CheckResultBatch batch, CancellationToken ct = default)
        {
            into.Add(batch);
            return Task.CompletedTask;
        }
    }
}
