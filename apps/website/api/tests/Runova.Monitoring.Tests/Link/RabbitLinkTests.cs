using Microsoft.Extensions.DependencyInjection;
using RabbitMQ.Client;
using Runova.Monitoring.Contracts;
using Runova.Monitoring.Gateway;
using Testcontainers.RabbitMq;

namespace Runova.Monitoring.Tests.Link;

/// <summary>
/// The gateway's real link (E54): Wolverine on RabbitMQ. A batch is asked, not just published, and
/// only the API's answer lets the gateway ack it: with no API, or no broker, there is no answer.
/// </summary>
public sealed class RabbitLinkTests : IAsyncLifetime
{
    private readonly RabbitMqContainer _rabbit = new RabbitMqBuilder("rabbitmq:4-alpine").Build();

    public async ValueTask InitializeAsync() => await _rabbit.StartAsync(TestContext.Current.CancellationToken);

    public async ValueTask DisposeAsync() => await _rabbit.DisposeAsync();

    [Fact]
    public async Task A_batch_reaches_the_api_queue_but_is_not_taken_without_the_api_s_answer()
    {
        using var pki = new TestPki();
        var uri = _rabbit.GetConnectionString();
        await using var gateway = await GatewayHarness.StartAsync(pki, waitForTrust: false, rabbitMq: uri);
        var link = gateway.App.Services.GetRequiredService<IApiLink>();
        var batch = new CheckResultBatch(42, Guid.NewGuid().ToString(), []);

        var asking = link.InvokeAsync<BatchStored>(batch, TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        await Task.Delay(500, TestContext.Current.CancellationToken);

        // While the gateway waits, the request sits in the API's queue (it expires with the wait).
        var factory = new ConnectionFactory { Uri = new Uri(uri) };
        await using (var connection = await factory.CreateConnectionAsync(TestContext.Current.CancellationToken))
        await using (var channel = await connection.CreateChannelAsync(cancellationToken: TestContext.Current.CancellationToken))
        {
            // The gateway's own trust requests are in the queue too.
            var bodies = new List<string>();
            while (await channel.BasicGetAsync(MonitoringQueues.ToApi, autoAck: true, TestContext.Current.CancellationToken) is { } message)
            {
                bodies.Add(System.Text.Encoding.UTF8.GetString(message.Body.Span));
            }

            Assert.Contains(bodies, body => body.Contains(batch.BatchId, StringComparison.Ordinal));
        }

        Assert.NotNull(await Record.ExceptionAsync(() => asking));

        await _rabbit.StopAsync(TestContext.Current.CancellationToken);
        var down = await Record.ExceptionAsync(() =>
            link.InvokeAsync<BatchStored>(batch with { BatchId = Guid.NewGuid().ToString() }, TimeSpan.FromSeconds(2), TestContext.Current.CancellationToken)
                .WaitAsync(TimeSpan.FromSeconds(15), TestContext.Current.CancellationToken));

        Assert.NotNull(down);
    }

    [Fact]
    public async Task The_gateway_loads_its_trust_list_and_hears_of_a_revoke_through_rabbitmq()
    {
        using var pki = new TestPki();
        var uri = _rabbit.GetConnectionString();
        using var api = await StartApiLikeAsync(uri, pki);
        await using var gateway = await GatewayHarness.StartAsync(pki, waitForTrust: true, rabbitMq: uri);
        using var certificate = pki.Node(42);
        Assert.True(gateway.Trust.Accepts(certificate, out _, out _));

        await api.Services.GetRequiredService<Wolverine.IMessageBus>().PublishAsync(new NodeRevoked(42, [certificate.SerialNumber]));

        await Eventually.TrueAsync(() => !gateway.Trust.Accepts(certificate, out _, out _), TimeSpan.FromSeconds(20));
    }

    private static async Task<Microsoft.Extensions.Hosting.IHost> StartApiLikeAsync(string rabbit, TestPki pki)
    {
        var builder = Microsoft.Extensions.Hosting.Host.CreateApplicationBuilder();
        builder.Services.AddSingleton(new ApiLikeState(pki));
        Wolverine.HostBuilderExtensions.UseWolverine(builder, options =>
        {
            options.ServiceName = "test-api";
            options.ApplicationAssembly = typeof(RabbitLinkTests).Assembly;
            options.Discovery.DisableConventionalDiscovery().IncludeType(typeof(ApiLikeHandler));
            Wolverine.RabbitMQ.RabbitMqTransportExtensions.UseRabbitMq(options, new Uri(rabbit)).AutoProvision()
                .DeclareExchange(MonitoringQueues.ToGateways, exchange =>
                {
                    exchange.ExchangeType = Wolverine.RabbitMQ.ExchangeType.Fanout;
                    exchange.IsDurable = true;
                });
            Wolverine.RabbitMQ.RabbitMqTransportExtensions.ListenToRabbitQueue(options, MonitoringQueues.ToApi);
            Wolverine.RabbitMQ.RabbitMqTransportExtensions.ToRabbitExchange(options.PublishMessage<NodeRevoked>(), MonitoringQueues.ToGateways);
        });
        var host = builder.Build();
        await host.StartAsync(TestContext.Current.CancellationToken);
        return host;
    }
}

/// <summary>Answers the gateway the way the API does, for the tests that need the incoming side.</summary>
public static class ApiLikeHandler
{
    public static NodeTrust Handle(GetNodeTrust message, Runova.Monitoring.Tests.Link.ApiLikeState state) => state.Pki.Trust();
}

public sealed record ApiLikeState(TestPki Pki);
