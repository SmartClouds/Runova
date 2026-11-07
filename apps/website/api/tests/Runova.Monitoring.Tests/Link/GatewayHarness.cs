using System.Collections.Concurrent;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
using Grpc.Net.Client;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Runova.Monitoring.Contracts;
using Runova.Monitoring.Contracts.Grpc;
using Runova.Monitoring.Gateway;

namespace Runova.Monitoring.Tests.Link;

/// <summary>Stands in for the API: records what the gateway publishes, and can be made to fail like a broker that is down.</summary>
public sealed class FakeApiLink(Func<NodeTrust> trust) : IApiLink
{
    public ConcurrentQueue<object> Published { get; } = new();

    /// <summary>While true, every publish throws, as a RabbitMQ that is down would.</summary>
    public bool Down { get; set; }

    public IEnumerable<T> Of<T>() => Published.OfType<T>();

    public Task PublishAsync<T>(T message, CancellationToken ct = default)
        where T : class
    {
        if (Down)
        {
            throw new InvalidOperationException("The broker is down.");
        }

        Published.Enqueue(message);
        return Task.CompletedTask;
    }

    /// <summary>What the fake API answers a NodeConnected with.</summary>
    public NodeAccepted Acceptance { get; set; } = new(true, null);

    public Task<TReply> InvokeAsync<TReply>(object request, TimeSpan timeout, CancellationToken ct = default)
        where TReply : class
    {
        if (request is GetNodeTrust)
        {
            return Task.FromResult((TReply)(object)trust());
        }

        if (Down)
        {
            throw new TimeoutException("No answer: the broker is down.");
        }

        Published.Enqueue(request);
        object reply = request switch
        {
            NodeConnected => Acceptance,
            CheckResultBatch batch => new BatchStored(batch.BatchId),
            _ => throw new InvalidOperationException($"No reply for {request.GetType().Name}."),
        };
        return Task.FromResult((TReply)reply);
    }
}

/// <summary>The real gateway app on free ports, with the test PKI and a fake API link.</summary>
public sealed class GatewayHarness : IAsyncDisposable
{
    private GatewayHarness(WebApplication app, FakeApiLink link, Uri nodeAddress, Uri healthAddress)
    {
        App = app;
        Link = link;
        NodeAddress = nodeAddress;
        HealthAddress = healthAddress;
    }

    public WebApplication App { get; }

    public FakeApiLink Link { get; }

    public Uri NodeAddress { get; }

    public Uri HealthAddress { get; }

    public NodeSessions Sessions => App.Services.GetRequiredService<NodeSessions>();

    public GatewayTrust Trust => App.Services.GetRequiredService<GatewayTrust>();

    /// <param name="rabbitMq">The broker to use through Wolverine instead of the fake link.</param>
    public static async Task<GatewayHarness> StartAsync(
        TestPki pki, Func<NodeTrust>? trust = null, int nodePort = 0, bool waitForTrust = true, string? rabbitMq = null)
    {
        var link = new FakeApiLink(trust ?? (() => pki.Trust()));
        string[] args =
        [
            "--environment", "Development", "--Gateway:Id", "gw-test", "--Gateway:NodePort", nodePort.ToString(System.Globalization.CultureInfo.InvariantCulture),
            "--Gateway:HealthPort", "0", "--Gateway:TrustRefresh", "00:00:01", "--Logging:LogLevel:Default", "Warning",
        ];
        var app = GatewayApp.Build(
            rabbitMq is null ? args : [.. args, "--RabbitMq:Uri", rabbitMq],
            builder =>
            {
                builder.Services.AddSingleton(new GatewayServerCertificate(pki.Server));
                if (rabbitMq is null)
                {
                    builder.Services.AddSingleton<IApiLink>(link);
                }
            });
        await app.StartAsync(TestContext.Current.CancellationToken);
        var addresses = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Select(a => new Uri(a)).ToList();
        var node = addresses.Single(a => a.Scheme == "https");
        var health = addresses.Single(a => a.Scheme == "http");
        var harness = new GatewayHarness(app, link, new Uri($"https://localhost:{node.Port}"), new Uri($"http://localhost:{health.Port}"));
        if (waitForTrust)
        {
            await Eventually.TrueAsync(() => harness.Trust.Ready);
        }

        return harness;
    }

    /// <summary>A gRPC client for a node, with the given client certificate (or none), trusting the gateway's CA.</summary>
    public NodeLink.NodeLinkClient Client(X509Certificate2? certificate, TestPki pki, out GrpcChannel channel)
    {
        var gatewayCa = pki.GatewayCa;
        channel = GrpcChannel.ForAddress(NodeAddress, new GrpcChannelOptions
        {
            HttpHandler = new SocketsHttpHandler
            {
                SslOptions = new SslClientAuthenticationOptions
                {
                    ClientCertificates = certificate is null ? [] : [certificate],
                    RemoteCertificateValidationCallback = (_, server, _, _) =>
                    {
                        using var chain = new X509Chain();
                        chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
                        chain.ChainPolicy.CustomTrustStore.Add(gatewayCa);
                        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
                        return server is X509Certificate2 cert && chain.Build(cert);
                    },
                },
            },
        });
        return new NodeLink.NodeLinkClient(channel);
    }

    public async ValueTask DisposeAsync()
    {
        await App.StopAsync(CancellationToken.None);
        await App.DisposeAsync();
    }
}

/// <summary>Waits for something that happens on another thread.</summary>
public static class Eventually
{
    public static Task TrueAsync(Func<bool> condition, TimeSpan? within = null) =>
        TrueAsync(() => Task.FromResult(condition()), within);

    public static async Task TrueAsync(Func<Task<bool>> condition, TimeSpan? within = null)
    {
        var deadline = DateTime.UtcNow + (within ?? TimeSpan.FromSeconds(10));
        while (!await condition())
        {
            if (DateTime.UtcNow > deadline)
            {
                Assert.Fail("The condition did not become true in time.");
            }

            await Task.Delay(20, TestContext.Current.CancellationToken);
        }
    }
}
