using System.Collections.Concurrent;
using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Runova.Monitoring.Contracts;
using Runova.Monitoring.Contracts.Grpc;
using Runova.Website.Core.Identity;
using Runova.Website.Data;
using Runova.Website.Data.Monitoring;
using Runova.Website.IntegrationTests.Infrastructure;
using Testcontainers.RabbitMq;
using Wolverine;
using Wolverine.RabbitMQ;

namespace Runova.Website.IntegrationTests.Monitoring;

/// <summary>
/// The API's side of the internal RabbitMQ (E54), for real: Wolverine with its Postgres inbox and
/// outbox. A small Wolverine host in the test talks to it the way the gateway does.
/// </summary>
public sealed class NodeMessagingTests(PostgresFixture postgres) : IAsyncLifetime
{
    private readonly RabbitMqContainer _rabbit = new RabbitMqBuilder("rabbitmq:4-alpine").Build();
    private WebsiteApiFactory _factory = null!;
    private IHost _gateway = null!;

    public async ValueTask InitializeAsync()
    {
        await _rabbit.StartAsync(TestContext.Current.CancellationToken);
        _factory = new(
            await postgres.CreateDatabaseAsync(),
            settings: new Dictionary<string, string>
            {
                ["Monitoring:GatewayAddress"] = "https://nodes.runovahq.test",
                ["RabbitMq:Uri"] = _rabbit.GetConnectionString(),
            });
        _ = _factory.Services;
        _gateway = await GatewayLikeHost.StartAsync(_rabbit.GetConnectionString());
    }

    public async ValueTask DisposeAsync()
    {
        await _gateway.StopAsync(CancellationToken.None);
        _gateway.Dispose();
        _factory.Dispose();
        await _rabbit.DisposeAsync();
    }

    private IMessageBus Bus => _gateway.Services.GetRequiredService<IMessageBus>();

    private static GatewayInbox Inbox(IHost host) => host.Services.GetRequiredService<GatewayInbox>();

    [Fact]
    public async Task A_gateway_connects_a_node_sends_results_and_hears_of_its_revoke_through_rabbitmq()
    {
        var admin = await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services, Roles.Admin));
        var created = await ApiClient.ReadJsonAsync(
            await admin.SendAsync(HttpMethod.Post, "/api/v1/monitoring-nodes", new { name = "eu-1", region = "eu-central" }), HttpStatusCode.Created);
        var id = created.GetProperty("node").GetProperty("id").GetInt64();
        var enrolled = await ApiClient.ReadJsonAsync(
            await _factory.CreateApiClient().SendAsync(HttpMethod.Post, "/api/v1/monitoring-node-enrollments", new
            {
                token = created.GetProperty("enrollment").GetProperty("token").GetString(),
                csr = Convert.ToBase64String(TestNodeKeys.NewCsr().Csr),
            }), HttpStatusCode.Created);
        using var certificate = System.Security.Cryptography.X509Certificates.X509CertificateLoader.LoadCertificate(
            Convert.FromBase64String(enrolled.GetProperty("certificate").GetString()!));
        var timeout = TimeSpan.FromSeconds(30);

        var trust = await Bus.InvokeAsync<NodeTrust>(new GetNodeTrust("gw-test"), TestContext.Current.CancellationToken, timeout);
        var accepted = await Bus.InvokeAsync<NodeAccepted>(
            new NodeConnected(id, "gw-test", "1.0.0", 0, 16, "203.0.113.9", certificate.SerialNumber, DateTimeOffset.UtcNow),
            TestContext.Current.CancellationToken, timeout);
        var stored = await Bus.InvokeAsync<BatchStored>(new CheckResultBatch(id, "batch-1", []), TestContext.Current.CancellationToken, timeout);

        Assert.NotEmpty(trust.CaCertificate);
        Assert.True(accepted.Accepted);
        Assert.Equal("batch-1", stored.BatchId);
        using (var scope = _factory.Services.CreateScope())
        {
            var node = await scope.ServiceProvider.GetRequiredService<AppDbContext>().MonitoringNodes.SingleAsync(n => n.Id == id, TestContext.Current.CancellationToken);
            Assert.Equal(NodeStatuses.Online, node.Status);
            Assert.Equal("gw-test", node.GatewayId);
        }

        // The snapshot comes back on the gateways' fanout exchange, from the API's outbox.
        await WaitAsync(() => Inbox(_gateway).Outbound.Any(o => o.NodeId == id));
        var snapshot = ServerMessage.Parser.ParseFrom(Inbox(_gateway).Outbound.First(o => o.NodeId == id).ServerMessage);
        Assert.Equal(ServerMessage.BodyOneofCase.Snapshot, snapshot.BodyCase);

        var refused = await Bus.InvokeAsync<NodeAccepted>(
            new NodeConnected(id, "gw-test", "1.0.0", 0, 16, "203.0.113.9", "00DEAD", DateTimeOffset.UtcNow),
            TestContext.Current.CancellationToken, timeout);
        Assert.False(refused.Accepted);

        await admin.SendAsync(HttpMethod.Post, $"/api/v1/monitoring-nodes/{id}/revocations");
        await WaitAsync(() => Inbox(_gateway).Revoked.Any(r => r.NodeId == id && r.Serials.Contains(certificate.SerialNumber)));
    }

    private static async Task WaitAsync(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (!condition())
        {
            Assert.True(DateTime.UtcNow < deadline, "Nothing arrived in time.");
            await Task.Delay(50, TestContext.Current.CancellationToken);
        }
    }

    /// <summary>What reached the stand-in gateway from the API.</summary>
    public sealed class GatewayInbox
    {
        public ConcurrentQueue<NodeOutbound> Outbound { get; } = new();

        public ConcurrentQueue<NodeRevoked> Revoked { get; } = new();
    }

    public static class GatewayInboxHandler
    {
        public static void Handle(NodeOutbound message, GatewayInbox inbox) => inbox.Outbound.Enqueue(message);

        public static void Handle(NodeRevoked message, GatewayInbox inbox) => inbox.Revoked.Enqueue(message);

        public static void Handle(CloseNodeConnection message)
        {
        }
    }

    /// <summary>The gateway's Wolverine routing, without the gRPC side.</summary>
    private static class GatewayLikeHost
    {
        public static async Task<IHost> StartAsync(string rabbit)
        {
            var builder = Host.CreateApplicationBuilder();
            builder.Services.AddSingleton<GatewayInbox>();
            builder.UseWolverine(options =>
            {
                options.ServiceName = "test-gateway";
                options.ApplicationAssembly = typeof(NodeMessagingTests).Assembly;
                options.Discovery.DisableConventionalDiscovery().IncludeType(typeof(GatewayInboxHandler));
                var queue = $"{MonitoringQueues.ToGateways}-test";
                var transport = options.UseRabbitMq(new Uri(rabbit)).AutoProvision();
                transport.DeclareExchange(MonitoringQueues.ToGateways, exchange =>
                {
                    exchange.ExchangeType = ExchangeType.Fanout;
                    exchange.IsDurable = true;
                });
                transport.BindExchange(MonitoringQueues.ToGateways, ExchangeType.Fanout).ToQueue(queue);
                transport.DeclareQueue(MonitoringQueues.ToApi);
                options.ListenToRabbitQueue(queue);
                options.PublishMessage<NodeConnected>().ToRabbitQueue(MonitoringQueues.ToApi).SendInline();
                options.PublishMessage<CheckResultBatch>().ToRabbitQueue(MonitoringQueues.ToApi).SendInline();
                options.PublishMessage<GetNodeTrust>().ToRabbitQueue(MonitoringQueues.ToApi).SendInline();
            });
            var host = builder.Build();
            await host.StartAsync(TestContext.Current.CancellationToken);
            return host;
        }
    }
}
