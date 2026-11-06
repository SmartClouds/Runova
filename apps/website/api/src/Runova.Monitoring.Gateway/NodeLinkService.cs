using System.Threading.RateLimiting;
using Grpc.Core;
using Microsoft.Extensions.Options;
using Runova.Monitoring.Contracts;
using Runova.Monitoring.Contracts.Grpc;

namespace Runova.Monitoring.Gateway;

/// <summary>
/// The gRPC side nodes talk to (E54). Who a node is comes only from its verified client
/// certificate; that id is stamped on everything passed on to the API.
/// </summary>
internal sealed partial class NodeLinkService(
    GatewayTrust trust,
    NodeSessions sessions,
    IApiLink api,
    GatewayIdentity identity,
    IOptions<GatewayOptions> options,
    TimeProvider time,
    ILogger<NodeLinkService> logger) : NodeLink.NodeLinkBase
{
    private const int MaxText = 2_000;
    private const int MaxKey = 200;
    private const int MaxServices = 50;

    /// <summary>How long the API has to answer before the gateway takes it as not done.</summary>
    private static readonly TimeSpan _answerTimeout = TimeSpan.FromSeconds(10);

    public override async Task Connect(IAsyncStreamReader<NodeMessage> requestStream, IServerStreamWriter<ServerMessage> responseStream, ServerCallContext context)
    {
        var http = context.GetHttpContext();
        var certificate = http.Connection.ClientCertificate;
        if (!trust.Accepts(certificate, out var nodeId, out var reason))
        {
            throw new RpcException(new Status(StatusCode.PermissionDenied, reason));
        }

        using var hello = CancellationTokenSource.CreateLinkedTokenSource(context.CancellationToken);
        hello.CancelAfter(options.Value.HelloTimeout);
        Hello first;
        try
        {
            if (!await requestStream.MoveNext(hello.Token) || requestStream.Current.BodyCase != NodeMessage.BodyOneofCase.Hello)
            {
                throw new RpcException(new Status(StatusCode.InvalidArgument, "The first message must be Hello."));
            }

            first = requestStream.Current.Hello;
        }
        catch (OperationCanceledException) when (!context.CancellationToken.IsCancellationRequested)
        {
            throw new RpcException(new Status(StatusCode.DeadlineExceeded, "No Hello in time."));
        }

        using var session = sessions.Open(nodeId, certificate!.SerialNumber);
        using var link = CancellationTokenSource.CreateLinkedTokenSource(context.CancellationToken, session.Closed);
        using var limiter = new TokenBucketRateLimiter(new TokenBucketRateLimiterOptions
        {
            TokenLimit = 40,
            TokensPerPeriod = 10,
            ReplenishmentPeriod = TimeSpan.FromSeconds(1),
            QueueLimit = 0,
            AutoReplenishment = true,
        });
        var remote = http.Connection.RemoteIpAddress?.ToString();
        Connected(logger, nodeId, remote);

        var writer = WriteAsync(session, responseStream, link.Token);
        try
        {
            var accepted = await api.InvokeAsync<NodeAccepted>(new NodeConnected(
                nodeId, identity.Id, Clip(first.Version, 40), first.AssignmentVersion, first.Concurrency,
                remote, certificate.SerialNumber, time.GetUtcNow()), _answerTimeout, link.Token);
            if (!accepted.Accepted)
            {
                session.Close(accepted.Reason ?? "The API refused this node.");
                throw new RpcException(new Status(StatusCode.PermissionDenied, accepted.Reason ?? "Refused."));
            }

            while (await requestStream.MoveNext(link.Token))
            {
                using var lease = limiter.AttemptAcquire();
                if (!lease.IsAcquired)
                {
                    session.Close("The node sent too many messages.");
                    throw new RpcException(new Status(StatusCode.ResourceExhausted, "Too many messages."));
                }

                var message = requestStream.Current;
                switch (message.BodyCase)
                {
                    case NodeMessage.BodyOneofCase.Heartbeat:
                        var beat = message.Heartbeat;
                        await api.PublishAsync(new NodeHeartbeat(nodeId, beat.Monitors, beat.ChecksLastMinute, beat.QueuedResults, beat.LagMs, time.GetUtcNow()), link.Token);
                        break;
                    case NodeMessage.BodyOneofCase.Results:
                        await ForwardAsync(nodeId, session, message.Results, link.Token);
                        break;
                    default:
                        throw new RpcException(new Status(StatusCode.InvalidArgument, "Hello comes once."));
                }
            }
        }
        catch (OperationCanceledException) when (session.Closed.IsCancellationRequested)
        {
            Closed(logger, nodeId, session.CloseReason ?? "closed");
            http.Abort();
        }
        finally
        {
            session.Outbound.Writer.TryComplete();
            await writer.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
            if (sessions.Remove(session))
            {
                try
                {
                    await api.PublishAsync(new NodeDisconnected(nodeId, identity.Id, time.GetUtcNow()), CancellationToken.None);
                }
                catch (Exception e)
                {
                    DisconnectNotSent(logger, nodeId, e);
                }
            }
        }
    }

    public override async Task<RenewCertificateResponse> RenewCertificate(RenewCertificateRequest request, ServerCallContext context)
    {
        var certificate = context.GetHttpContext().Connection.ClientCertificate;
        if (!trust.Accepts(certificate, out var nodeId, out var reason))
        {
            throw new RpcException(new Status(StatusCode.PermissionDenied, reason));
        }

        if (request.Csr.Length is 0 or > 8 * 1024)
        {
            throw new RpcException(new Status(StatusCode.InvalidArgument, "The certificate request must be 8 KB at most."));
        }

        var renewed = await api.InvokeAsync<CertificateRenewed>(
            new RenewNodeCertificate(nodeId, certificate!.SerialNumber, request.Csr.ToByteArray()), TimeSpan.FromSeconds(20), context.CancellationToken);
        if (renewed.Refused is { } refused)
        {
            throw new RpcException(new Status(StatusCode.PermissionDenied, refused));
        }

        var response = new RenewCertificateResponse { Certificate = Google.Protobuf.ByteString.CopyFrom(renewed.Certificate) };
        response.CaCertificates.AddRange(renewed.CaCertificates.Select(Google.Protobuf.ByteString.CopyFrom));
        return response;
    }

    /// <summary>Passes a batch on and acks it only once the API answers that it took it.</summary>
    private async Task ForwardAsync(long nodeId, NodeSession session, ResultBatch batch, CancellationToken ct)
    {
        if (batch.Results.Count > options.Value.MaxBatchResults || !Guid.TryParse(batch.BatchId, out _))
        {
            throw new RpcException(new Status(StatusCode.InvalidArgument, $"A batch has a UUID id and {options.Value.MaxBatchResults} results at most."));
        }

        var results = new List<CheckResultRecord>(batch.Results.Count);
        foreach (var result in batch.Results)
        {
            if (!Guid.TryParse(result.Id, out var id) || result.MonitorId <= 0 || result.CheckedAt is null)
            {
                continue;
            }

            results.Add(new CheckResultRecord(
                id,
                result.MonitorId,
                result.MonitorVersion,
                result.CheckedAt.ToDateTimeOffset(),
                Clip(result.State, 16),
                result.HttpStatus is > 0 and < 1000 ? result.HttpStatus : null,
                result.LatencyMs >= 0 ? result.LatencyMs : null,
                string.IsNullOrEmpty(result.Problem) ? null : Clip(result.Problem, MaxText),
                [.. result.Services.Take(MaxServices).Select(s => new ServiceProblemRecord(Clip(s.Key, MaxKey), Clip(s.Status, 8), Clip(s.Message, MaxText)))],
                string.IsNullOrEmpty(result.ConfirmId) ? null : Clip(result.ConfirmId, 64)));
        }

        try
        {
            await api.InvokeAsync<BatchStored>(new CheckResultBatch(nodeId, batch.BatchId, results), _answerTimeout, ct);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            // No ack: the node keeps the batch and sends it again.
            BatchNotForwarded(logger, nodeId, e);
            return;
        }

        await session.Outbound.Writer.WriteAsync(new ServerMessage { Ack = new BatchAck { BatchId = batch.BatchId } }, ct);
    }

    private static async Task WriteAsync(NodeSession session, IServerStreamWriter<ServerMessage> stream, CancellationToken ct)
    {
        await foreach (var message in session.Outbound.Reader.ReadAllAsync(ct))
        {
            await stream.WriteAsync(message, ct);
        }
    }

    private static string Clip(string? value, int max) => value is null ? "" : value.Length <= max ? value : value[..max];

    [LoggerMessage(Level = LogLevel.Information, Message = "Node {NodeId} connected from {Address}.")]
    private static partial void Connected(ILogger logger, long nodeId, string? address);

    [LoggerMessage(Level = LogLevel.Information, Message = "Node {NodeId}'s stream was closed: {Reason}")]
    private static partial void Closed(ILogger logger, long nodeId, string reason);

    [LoggerMessage(Level = LogLevel.Warning, Message = "A batch from node {NodeId} could not be passed on; it was not acked.")]
    private static partial void BatchNotForwarded(ILogger logger, long nodeId, Exception exception);

    [LoggerMessage(Level = LogLevel.Warning, Message = "The API was not told node {NodeId} went away.")]
    private static partial void DisconnectNotSent(ILogger logger, long nodeId, Exception exception);
}
