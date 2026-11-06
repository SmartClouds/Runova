using System.Collections.Concurrent;
using System.Threading.Channels;
using Runova.Monitoring.Contracts.Grpc;

namespace Runova.Monitoring.Gateway;

/// <summary>One node's open stream.</summary>
public sealed class NodeSession(long nodeId, string serial) : IDisposable
{
    private readonly CancellationTokenSource _closed = new();

    public long NodeId { get; } = nodeId;

    public string Serial { get; } = serial;

    /// <summary>What to write to the node. One writer drains it, since gRPC writes may not overlap.</summary>
    public Channel<ServerMessage> Outbound { get; } = Channel.CreateBounded<ServerMessage>(
        new BoundedChannelOptions(1_000) { SingleReader = true, FullMode = BoundedChannelFullMode.Wait });

    public CancellationToken Closed => _closed.Token;

    public string? CloseReason { get; private set; }

    public void Close(string reason)
    {
        CloseReason ??= reason;
        try
        {
            _closed.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // Already gone.
        }

        Outbound.Writer.TryComplete();
    }

    public void Dispose() => _closed.Dispose();
}

/// <summary>The streams this gateway holds, one per node. A node that connects again replaces its old stream.</summary>
public sealed class NodeSessions
{
    private readonly ConcurrentDictionary<long, NodeSession> _sessions = new();

    public int Count => _sessions.Count;

    public NodeSession Open(long nodeId, string serial)
    {
        var session = new NodeSession(nodeId, serial);
        _sessions.AddOrUpdate(nodeId, session, (_, old) =>
        {
            old.Close("The node connected again.");
            return session;
        });
        return session;
    }

    /// <summary>Forgets the session if it is still the current one. True when it was.</summary>
    public bool Remove(NodeSession session) => _sessions.TryRemove(new KeyValuePair<long, NodeSession>(session.NodeId, session));

    public bool TryGet(long nodeId, out NodeSession? session) => _sessions.TryGetValue(nodeId, out session);

    /// <summary>Queues a message for the node, if this gateway holds its stream.</summary>
    public async ValueTask<bool> DeliverAsync(long nodeId, ServerMessage message, CancellationToken ct = default)
    {
        if (!_sessions.TryGetValue(nodeId, out var session))
        {
            return false;
        }

        try
        {
            await session.Outbound.Writer.WriteAsync(message, ct);
            return true;
        }
        catch (ChannelClosedException)
        {
            return false;
        }
    }

    public void Close(long nodeId, string reason)
    {
        if (_sessions.TryGetValue(nodeId, out var session))
        {
            session.Close(reason);
        }
    }

    /// <summary>Closes the node's stream when its certificate is one of <paramref name="serials"/>, or when no serial is named.</summary>
    public void Revoke(long nodeId, IReadOnlyList<string> serials)
    {
        if (_sessions.TryGetValue(nodeId, out var session)
            && (serials.Count == 0 || serials.Contains(session.Serial, StringComparer.OrdinalIgnoreCase)))
        {
            session.Close("The node's certificate was revoked.");
        }
    }
}
