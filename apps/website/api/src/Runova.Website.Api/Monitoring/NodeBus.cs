using Google.Protobuf;
using Runova.Monitoring.Contracts;
using Runova.Monitoring.Contracts.Grpc;
using Wolverine;

namespace Runova.Website.Api.Monitoring;

/// <summary>
/// What the API tells the gateways about nodes (E54). In production it goes through Wolverine to
/// a fanout exchange on the internal RabbitMQ; with no RabbitMQ configured nothing is sent, and
/// the tests swap in a recording one.
/// </summary>
public interface INodeBus
{
    /// <summary>A message for the node's stream, written by whichever gateway holds it.</summary>
    ValueTask SendAsync(long nodeId, ServerMessage message, CancellationToken ct = default);

    /// <summary>Close the node's stream; with <paramref name="serials"/>, refuse those certificates from now on.</summary>
    ValueTask RevokedAsync(long nodeId, IReadOnlyList<string> serials, CancellationToken ct = default);

    /// <summary>Close the node's stream, but keep trusting its certificate.</summary>
    ValueTask CloseAsync(long nodeId, string reason, CancellationToken ct = default);
}

/// <summary>Used when no RabbitMQ is configured: there is no gateway to tell.</summary>
internal sealed class NullNodeBus(ILogger<NullNodeBus> logger) : INodeBus
{
    public ValueTask SendAsync(long nodeId, ServerMessage message, CancellationToken ct = default)
    {
        if (logger.IsEnabled(LogLevel.Debug))
        {
            logger.NoBus(message.BodyCase.ToString(), nodeId);
        }

        return ValueTask.CompletedTask;
    }

    public ValueTask RevokedAsync(long nodeId, IReadOnlyList<string> serials, CancellationToken ct = default) => ValueTask.CompletedTask;

    public ValueTask CloseAsync(long nodeId, string reason, CancellationToken ct = default) => ValueTask.CompletedTask;
}

/// <summary>Publishes through Wolverine, whose durable outbox keeps a message until RabbitMQ has it.</summary>
internal sealed class WolverineNodeBus(IMessageBus bus) : INodeBus
{
    public ValueTask SendAsync(long nodeId, ServerMessage message, CancellationToken ct = default) =>
        bus.PublishAsync(new NodeOutbound(nodeId, message.ToByteArray()));

    public ValueTask RevokedAsync(long nodeId, IReadOnlyList<string> serials, CancellationToken ct = default) =>
        bus.PublishAsync(new NodeRevoked(nodeId, serials));

    public ValueTask CloseAsync(long nodeId, string reason, CancellationToken ct = default) =>
        bus.PublishAsync(new CloseNodeConnection(nodeId, reason));
}

/// <summary>The monitors a node should check (the online monitors' assigner, E55).</summary>
public interface IAssignmentSource
{
    Task<IReadOnlyList<MonitorDefinition>> ForNodeAsync(long nodeId, CancellationToken ct = default);
}

/// <summary>Takes a node's results (the online monitors' ingestor, E55).</summary>
public interface IResultIngestor
{
    Task IngestAsync(CheckResultBatch batch, CancellationToken ct = default);
}
