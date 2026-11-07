using System.Diagnostics;
using System.Net;
using Google.Protobuf;
using Google.Protobuf.WellKnownTypes;
using Grpc.Core;
using Runova.Monitoring.Contracts;
using Runova.Monitoring.Contracts.Grpc;
using Runova.Monitoring.Gateway;

namespace Runova.Monitoring.Tests.Link;

/// <summary>The gateway over real TLS (E54): who gets in, and what it passes on.</summary>
public sealed class GatewayTests : IAsyncLifetime
{
    private readonly TestPki _pki = new();
    private readonly List<string> _revoked = [];
    private GatewayHarness _gateway = null!;

    public async ValueTask InitializeAsync() => _gateway = await GatewayHarness.StartAsync(_pki, () => _pki.Trust(_revoked.ToList()));

    public async ValueTask DisposeAsync()
    {
        await _gateway.DisposeAsync();
        _pki.Dispose();
    }

    private static NodeMessage Hello() => new() { Hello = new Hello { Version = "1.2.3", Concurrency = 8 } };

    private static CheckResult Result(long monitorId) => new()
    {
        Id = Guid.CreateVersion7().ToString(),
        MonitorId = monitorId,
        MonitorVersion = 1,
        CheckedAt = Timestamp.FromDateTimeOffset(DateTimeOffset.UtcNow),
        State = "pass",
        HttpStatus = 200,
        LatencyMs = 12,
    };

    /// <summary>Opens a stream and says Hello; the call fails when the gateway refuses the node.</summary>
    private async Task<AsyncDuplexStreamingCall<NodeMessage, ServerMessage>> ConnectAsync(System.Security.Cryptography.X509Certificates.X509Certificate2? certificate)
    {
        var client = _gateway.Client(certificate, _pki, out _);
        var call = client.Connect(cancellationToken: TestContext.Current.CancellationToken);
        await call.RequestStream.WriteAsync(Hello(), TestContext.Current.CancellationToken);
        return call;
    }

    /// <summary>
    /// Reads until the stream fails, which is what a refused node sees: the handshake fails, or the
    /// call does, and nothing reaches the API.
    /// </summary>
    private async Task RefusedAsync(System.Security.Cryptography.X509Certificates.X509Certificate2? certificate)
    {
        var before = _gateway.Link.Of<NodeConnected>().Count();
        var refused = await Record.ExceptionAsync(async () =>
        {
            using var call = await ConnectAsync(certificate);
            await call.ResponseStream.MoveNext(TestContext.Current.CancellationToken);
        });

        Assert.True(refused is RpcException or HttpRequestException or HttpIOException or IOException, $"Not refused: {refused}");
        Assert.Equal(before, _gateway.Link.Of<NodeConnected>().Count());
    }

    [Fact]
    public async Task A_node_without_a_client_certificate_is_refused()
    {
        await RefusedAsync(null);

        Assert.Empty(_gateway.Link.Of<NodeConnected>());
    }

    [Fact]
    public async Task A_certificate_from_another_ca_is_refused()
    {
        using var stranger = TestPki.Stranger(7);

        await RefusedAsync(stranger);

        Assert.Empty(_gateway.Link.Of<NodeConnected>());
    }

    [Fact]
    public async Task An_expired_certificate_is_refused()
    {
        using var expired = _pki.Node(7, DateTimeOffset.UtcNow.AddDays(-8), DateTimeOffset.UtcNow.AddMinutes(-1));

        await RefusedAsync(expired);

        Assert.Empty(_gateway.Link.Of<NodeConnected>());
    }

    [Fact]
    public async Task A_certificate_that_names_no_node_is_refused()
    {
        using var nameless = _pki.Node(7, withSan: false);

        await RefusedAsync(nameless);
    }

    [Fact]
    public async Task A_revoked_certificate_is_refused()
    {
        using var certificate = _pki.Node(7);
        _gateway.Trust.Revoke([certificate.SerialNumber]);

        await RefusedAsync(certificate);
    }

    [Fact]
    public async Task A_gateway_that_has_no_trust_list_yet_refuses_everyone()
    {
        await using var cold = await GatewayHarness.StartAsync(_pki, () => throw new InvalidOperationException("The API is away."), waitForTrust: false);
        using var certificate = _pki.Node(7);
        var client = cold.Client(certificate, _pki, out _);

        // The refusal comes in the TLS handshake, so like the other refusals it shows either as a
        // failed call or as a connection the server closed before HTTP/2 began.
        var refused = await Record.ExceptionAsync(async () =>
        {
            using var call = client.Connect(cancellationToken: TestContext.Current.CancellationToken);
            await call.RequestStream.WriteAsync(Hello(), TestContext.Current.CancellationToken);
            await call.ResponseStream.MoveNext(TestContext.Current.CancellationToken);
        });

        Assert.True(refused is RpcException or HttpRequestException or HttpIOException or IOException, $"Not refused: {refused}");
        Assert.Empty(cold.Link.Of<NodeConnected>());
        Assert.False(cold.Trust.Ready);
    }

    [Fact]
    public async Task A_good_node_is_named_by_its_certificate()
    {
        using var certificate = _pki.Node(42);

        using var call = await ConnectAsync(certificate);
        await Eventually.TrueAsync(() => _gateway.Link.Of<NodeConnected>().Any());

        var connected = Assert.Single(_gateway.Link.Of<NodeConnected>());
        Assert.Equal(42, connected.NodeId);
        Assert.Equal("gw-test", connected.GatewayId);
        Assert.Equal("1.2.3", connected.Version);
        Assert.Equal(certificate.SerialNumber, connected.CertificateSerial);
    }

    [Fact]
    public async Task A_batch_is_acked_once_it_is_passed_on_stamped_with_the_certificate_node()
    {
        using var certificate = _pki.Node(42);
        using var call = await ConnectAsync(certificate);
        var batch = new ResultBatch { BatchId = Guid.NewGuid().ToString() };
        batch.Results.Add(Result(5));

        await call.RequestStream.WriteAsync(new NodeMessage { Results = batch }, TestContext.Current.CancellationToken);
        Assert.True(await call.ResponseStream.MoveNext(TestContext.Current.CancellationToken));

        Assert.Equal(batch.BatchId, call.ResponseStream.Current.Ack.BatchId);
        var forwarded = Assert.Single(_gateway.Link.Of<CheckResultBatch>());
        Assert.Equal(42, forwarded.NodeId);
        Assert.Equal(5, Assert.Single(forwarded.Results).MonitorId);
    }

    [Fact]
    public async Task No_ack_while_the_broker_is_down()
    {
        using var certificate = _pki.Node(42);
        using var call = await ConnectAsync(certificate);
        await Eventually.TrueAsync(() => _gateway.Link.Of<NodeConnected>().Any());
        _gateway.Link.Down = true;
        var batch = new ResultBatch { BatchId = Guid.NewGuid().ToString() };
        batch.Results.Add(Result(5));

        await call.RequestStream.WriteAsync(new NodeMessage { Results = batch }, TestContext.Current.CancellationToken);
        using var wait = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        wait.CancelAfter(TimeSpan.FromSeconds(1));
        var answered = await Record.ExceptionAsync(() => call.ResponseStream.MoveNext(wait.Token));

        Assert.NotNull(answered);
        Assert.Empty(_gateway.Link.Of<CheckResultBatch>());
    }

    [Fact]
    public async Task The_api_reaches_the_node_through_its_stream()
    {
        using var certificate = _pki.Node(42);
        using var call = await ConnectAsync(certificate);
        await Eventually.TrueAsync(() => _gateway.Sessions.TryGet(42, out _));
        var snapshot = new AssignmentSnapshot { AssignmentVersion = 3 };
        snapshot.Monitors.Add(new MonitorDefinition { Id = 9, Version = 1, Url = "https://example.com/health", IntervalSec = 60, TimeoutSec = 10 });

        await GatewayInboundHandler.Handle(new NodeOutbound(42, new ServerMessage { Snapshot = snapshot }.ToByteArray()), _gateway.Sessions, CancellationToken.None);
        await GatewayInboundHandler.Handle(new NodeOutbound(43, new ServerMessage { Drain = new Drain() }.ToByteArray()), _gateway.Sessions, CancellationToken.None);
        Assert.True(await call.ResponseStream.MoveNext(TestContext.Current.CancellationToken));

        Assert.Equal(3, call.ResponseStream.Current.Snapshot.AssignmentVersion);
        Assert.Equal(9, Assert.Single(call.ResponseStream.Current.Snapshot.Monitors).Id);
    }

    [Fact]
    public async Task Revoking_closes_the_stream_within_a_second_and_it_can_not_connect_again()
    {
        using var certificate = _pki.Node(42);
        using var call = await ConnectAsync(certificate);
        await Eventually.TrueAsync(() => _gateway.Sessions.TryGet(42, out _));

        var watch = Stopwatch.StartNew();
        GatewayInboundHandler.Handle(new NodeRevoked(42, [certificate.SerialNumber]), _gateway.Sessions, _gateway.Trust);
        var ended = await Record.ExceptionAsync(async () =>
        {
            while (await call.ResponseStream.MoveNext(TestContext.Current.CancellationToken))
            {
            }
        });
        watch.Stop();

        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(1), $"The stream took {watch.Elapsed} to close.");
        _ = ended;
        await RefusedAsync(certificate);
        await Eventually.TrueAsync(() => _gateway.Link.Of<NodeDisconnected>().Any());
    }

    [Fact]
    public async Task A_second_stream_from_the_same_node_replaces_the_first()
    {
        using var certificate = _pki.Node(42);
        using var first = await ConnectAsync(certificate);
        await Eventually.TrueAsync(() => _gateway.Link.Of<NodeConnected>().Count() == 1);

        using var second = await ConnectAsync(certificate);
        await Eventually.TrueAsync(() => _gateway.Link.Of<NodeConnected>().Count() == 2);
        var firstEnded = await Record.ExceptionAsync(async () =>
        {
            while (await first.ResponseStream.MoveNext(TestContext.Current.CancellationToken))
            {
            }
        });

        _ = firstEnded;
        Assert.True(_gateway.Sessions.TryGet(42, out _));
        Assert.Equal(1, _gateway.Sessions.Count);
    }

    [Fact]
    public async Task The_health_port_answers_healthz_and_not_grpc()
    {
        using var http = new HttpClient();

        var health = await http.GetAsync(new Uri(_gateway.HealthAddress, "/healthz"), TestContext.Current.CancellationToken);
        var grpc = await http.PostAsync(new Uri(_gateway.HealthAddress, "/runova.monitoring.v1.NodeLink/Connect"), null, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, health.StatusCode);
        Assert.NotEqual(HttpStatusCode.OK, grpc.StatusCode);
    }

    [Fact]
    public async Task A_batch_that_is_too_big_ends_the_stream()
    {
        using var certificate = _pki.Node(42);
        using var call = await ConnectAsync(certificate);
        var batch = new ResultBatch { BatchId = Guid.NewGuid().ToString() };
        for (var i = 0; i < 501; i++)
        {
            batch.Results.Add(Result(i + 1));
        }

        await call.RequestStream.WriteAsync(new NodeMessage { Results = batch }, TestContext.Current.CancellationToken);
        var refused = await Assert.ThrowsAsync<RpcException>(() => call.ResponseStream.MoveNext(TestContext.Current.CancellationToken));

        Assert.Equal(StatusCode.InvalidArgument, refused.StatusCode);
        Assert.Empty(_gateway.Link.Of<CheckResultBatch>());
    }
}
