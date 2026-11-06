using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
using Grpc.Core;
using Grpc.Net.Client;
using Microsoft.Extensions.Options;
using Runova.Monitoring.Contracts.Grpc;

namespace Runova.Monitoring.Node;

/// <summary>
/// The node's one stream to the gateway (E54): Hello, then heartbeats and result batches out,
/// assignments, confirms and acks in. It reconnects with a growing, jittered wait, renews the
/// certificate before it runs out, and touches <c>healthz</c> so Docker knows the loop is alive.
/// </summary>
public sealed partial class GatewayConnection(
    NodeIdentityStore identity,
    CheckScheduler scheduler,
    ResultOutbox outbox,
    IOptions<NodeOptions> options,
    TimeProvider time,
    ILogger<GatewayConnection> logger) : BackgroundService
{
    public static string Version { get; } = typeof(GatewayConnection).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";

    /// <summary>True while a stream is open; for tests.</summary>
    public bool Connected { get; private set; }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var failures = 0;
        while (!stoppingToken.IsCancellationRequested)
        {
            Healthz.Touch(options.Value.DataPath);
            try
            {
                var state = await identity.EnsureEnrolledAsync(stoppingToken);
                failures = await RunAsync(state, stoppingToken) ? 0 : failures + 1;
            }
            catch (EnrollmentException e)
            {
                EnrollmentFailed(logger, e.Message);
                failures++;
            }
            catch (Exception e) when (!stoppingToken.IsCancellationRequested)
            {
                StreamFailed(logger, e.GetType().Name, e.Message);
                failures++;
            }
            finally
            {
                Connected = false;
            }

            if (stoppingToken.IsCancellationRequested)
            {
                break;
            }

            // 1, 2, 4 ... seconds up to a minute, with up to half again at random.
            var wait = Math.Min(60, Math.Pow(2, Math.Min(failures, 6)) / 2);
            await Task.Delay(TimeSpan.FromSeconds(wait * (1 + (Random.Shared.NextDouble() / 2))), time, stoppingToken)
                .ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
        }
    }

    /// <summary>One stream, until it ends. True when it was up long enough to count as a success.</summary>
    private async Task<bool> RunAsync(NodeState state, CancellationToken stoppingToken)
    {
        using var certificate = identity.ClientCertificate(state);
        using var channel = GrpcChannel.ForAddress(state.GatewayAddress, new GrpcChannelOptions
        {
            HttpHandler = Handler(certificate),
            MaxReceiveMessageSize = 4 * 1024 * 1024,
            MaxSendMessageSize = 1024 * 1024,
        });
        var client = new NodeLink.NodeLinkClient(channel);

        if (state.NotAfter - time.GetUtcNow() < options.Value.RenewBefore)
        {
            await RenewAsync(client, stoppingToken);
            return true;
        }

        using var call = client.Connect(cancellationToken: stoppingToken);
        await call.RequestStream.WriteAsync(new NodeMessage
        {
            Hello = new Hello { Version = Version, AssignmentVersion = scheduler.AssignmentVersion, Concurrency = options.Value.Concurrency },
        }, stoppingToken);
        await outbox.ResetInFlightAsync(stoppingToken);
        Connected = true;
        var opened = time.GetUtcNow();
        StreamOpened(logger, state.NodeId);

        using var session = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
        var reader = ReadAsync(call.ResponseStream, session.Token);
        try
        {
            await WriteAsync(call.RequestStream, state, reader, session.Token);
        }
        finally
        {
            await session.CancelAsync();
            await reader.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
        }

        await reader;
        return time.GetUtcNow() - opened > TimeSpan.FromSeconds(30);
    }

    /// <summary>Heartbeats and batches; the one place that writes to the stream, so writes never overlap.</summary>
    private async Task WriteAsync(IClientStreamWriter<NodeMessage> stream, NodeState state, Task reader, CancellationToken ct)
    {
        var settings = options.Value;
        var nextBeat = time.GetUtcNow();
        var nextRenewCheck = time.GetUtcNow().AddHours(1);
        while (!ct.IsCancellationRequested && !reader.IsCompleted)
        {
            var now = time.GetUtcNow();
            if (now >= nextBeat)
            {
                Healthz.Touch(settings.DataPath);
                await stream.WriteAsync(new NodeMessage
                {
                    Heartbeat = new Heartbeat
                    {
                        Monitors = scheduler.Count,
                        ChecksLastMinute = scheduler.ChecksLastMinute,
                        QueuedResults = await outbox.CountAsync(ct),
                        LagMs = scheduler.LagMs,
                    },
                }, ct);
                nextBeat = now + settings.HeartbeatEvery;
            }

            while (await outbox.TakeBatchAsync(settings.BatchSize, ct) is { } batch)
            {
                await stream.WriteAsync(new NodeMessage { Results = batch }, ct);
                if (batch.Results.Count < settings.BatchSize)
                {
                    break;
                }
            }

            if (now >= nextRenewCheck)
            {
                nextRenewCheck = now.AddHours(1);
                if (state.NotAfter - now < settings.RenewBefore)
                {
                    // Reconnect: the next stream renews first and then uses the fresh certificate.
                    return;
                }
            }

            await Task.WhenAny(reader, Task.Delay(settings.BatchEvery, time, ct));
        }
    }

    private async Task ReadAsync(IAsyncStreamReader<ServerMessage> stream, CancellationToken ct)
    {
        while (await stream.MoveNext(ct))
        {
            var message = stream.Current;
            switch (message.BodyCase)
            {
                case ServerMessage.BodyOneofCase.Snapshot:
                    scheduler.Apply(message.Snapshot);
                    break;
                case ServerMessage.BodyOneofCase.Delta:
                    scheduler.Apply(message.Delta);
                    break;
                case ServerMessage.BodyOneofCase.Confirm:
                    _ = scheduler.ConfirmAsync(message.Confirm, ct);
                    break;
                case ServerMessage.BodyOneofCase.Drain:
                    scheduler.Clear();
                    break;
                case ServerMessage.BodyOneofCase.Ack:
                    await outbox.AckAsync(message.Ack.BatchId, ct);
                    break;
            }
        }
    }

    private async Task RenewAsync(NodeLink.NodeLinkClient client, CancellationToken ct)
    {
        var response = await client.RenewCertificateAsync(
            new RenewCertificateRequest { Csr = Google.Protobuf.ByteString.CopyFrom(identity.RenewalRequest()) },
            deadline: time.GetUtcNow().UtcDateTime.AddSeconds(30),
            cancellationToken: ct);
        await identity.SaveRenewedAsync(
            response.Certificate.ToByteArray(),
            response.CaCertificates.Count > 0 ? response.CaCertificates[0].ToByteArray() : null,
            ct);
        Renewed(logger);
    }

    /// <summary>TLS 1.3 with the client certificate. The gateway's own certificate must chain to a system root or the configured extra CA.</summary>
    private SocketsHttpHandler Handler(X509Certificate2 certificate)
    {
        var extra = ExtraGatewayCa();
        return new SocketsHttpHandler
        {
            EnableMultipleHttp2Connections = false,
            KeepAlivePingDelay = TimeSpan.FromSeconds(20),
            KeepAlivePingTimeout = TimeSpan.FromSeconds(20),
            KeepAlivePingPolicy = HttpKeepAlivePingPolicy.Always,
            PooledConnectionIdleTimeout = Timeout.InfiniteTimeSpan,
            ConnectTimeout = TimeSpan.FromSeconds(10),
            SslOptions = new SslClientAuthenticationOptions
            {
                ClientCertificates = [certificate],
                EnabledSslProtocols = System.Security.Authentication.SslProtocols.Tls13,
                CertificateRevocationCheckMode = X509RevocationMode.NoCheck,
                RemoteCertificateValidationCallback = (_, server, _, errors) =>
                    errors == SslPolicyErrors.None || (extra is not null && server is X509Certificate2 cert && ChainsTo(cert, extra, errors)),
            },
        };
    }

    private static bool ChainsTo(X509Certificate2 server, X509Certificate2 ca, SslPolicyErrors errors)
    {
        if (errors.HasFlag(SslPolicyErrors.RemoteCertificateNameMismatch) || errors.HasFlag(SslPolicyErrors.RemoteCertificateNotAvailable))
        {
            return false;
        }

        using var chain = new X509Chain();
        chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
        chain.ChainPolicy.CustomTrustStore.Add(ca);
        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        return chain.Build(server);
    }

    private X509Certificate2? ExtraGatewayCa()
    {
        var settings = options.Value;
        var pem = settings.GatewayCaPem;
        if (string.IsNullOrWhiteSpace(pem) && !string.IsNullOrWhiteSpace(settings.GatewayCaPath) && File.Exists(settings.GatewayCaPath))
        {
            pem = File.ReadAllText(settings.GatewayCaPath);
        }

        return string.IsNullOrWhiteSpace(pem) ? null : X509Certificate2.CreateFromPem(pem);
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Connected to the gateway as node {NodeId}.")]
    private static partial void StreamOpened(ILogger logger, long nodeId);

    [LoggerMessage(Level = LogLevel.Warning, Message = "The gateway stream ended ({Kind}): {Message}")]
    private static partial void StreamFailed(ILogger logger, string kind, string message);

    [LoggerMessage(Level = LogLevel.Error, Message = "{Message}")]
    private static partial void EnrollmentFailed(ILogger logger, string message);

    [LoggerMessage(Level = LogLevel.Information, Message = "The node's certificate was renewed.")]
    private static partial void Renewed(ILogger logger);
}

/// <summary>The file Docker's healthcheck reads: the node loop touched it in the last 90 seconds.</summary>
public static class Healthz
{
    public static readonly TimeSpan FreshFor = TimeSpan.FromSeconds(90);

    public static void Touch(string dataPath)
    {
        try
        {
            Directory.CreateDirectory(dataPath);
            File.WriteAllText(Path.Combine(dataPath, "healthz"), DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(System.Globalization.CultureInfo.InvariantCulture));
        }
        catch (IOException)
        {
            // A read-only or full disk shows up as unhealthy, which is right.
        }
    }

    public static int Check(string dataPath)
    {
        var file = Path.Combine(dataPath, "healthz");
        return File.Exists(file) && DateTime.UtcNow - File.GetLastWriteTimeUtc(file) < FreshFor ? 0 : 1;
    }
}
