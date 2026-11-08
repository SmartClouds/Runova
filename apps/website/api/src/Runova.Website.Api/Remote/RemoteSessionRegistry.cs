using System.Security.Cryptography;
using Microsoft.AspNetCore.WebUtilities;

namespace Runova.Website.Api.Remote;

internal enum RemoteSessionState
{
    Ringing,
    Accepted,
}

/// <summary>Who is in a session, by account, computer and hub connection.</summary>
internal sealed record RemoteSessionParties(
    long HostDeviceId,
    long HostUserId,
    string HostConnectionId,
    long ControllerUserId,
    long? ControllerDeviceId,
    string ControllerConnectionId,
    string Mode);

/// <summary>A request between two computers, from ringing until either side leaves.</summary>
internal sealed class RemoteSession(string id, RemoteSessionParties parties, DateTimeOffset createdAt)
{
    public string Id { get; } = id;

    public RemoteSessionParties Parties { get; } = parties;

    public DateTimeOffset CreatedAt { get; } = createdAt;

    public RemoteSessionState State { get; set; } = RemoteSessionState.Ringing;

    /// <summary>The saved record, once the host said the two computers are connected.</summary>
    public long? RecordId { get; set; }

    public bool Has(string connectionId) =>
        Parties.HostConnectionId == connectionId || Parties.ControllerConnectionId == connectionId;
}

/// <summary>
/// The sessions the hub is passing messages for (E60), in memory. A session id is 128 random
/// bits, and every message is checked against the connections in it, so knowing an id is not
/// enough to talk into a session.
/// </summary>
internal sealed class RemoteSessionRegistry(TimeProvider time)
{
    private readonly Dictionary<string, RemoteSession> _sessions = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();

    public RemoteSession Open(RemoteSessionParties parties)
    {
        var session = new RemoteSession(WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(16)), parties, time.GetUtcNow());
        lock (_gate)
        {
            _sessions[session.Id] = session;
        }

        return session;
    }

    public RemoteSession? Get(string sessionId)
    {
        lock (_gate)
        {
            return _sessions.GetValueOrDefault(sessionId);
        }
    }

    /// <summary>The host accepts a ringing session. Null when it is not the host's or not ringing.</summary>
    public RemoteSession? Accept(string sessionId, string hostConnectionId)
    {
        lock (_gate)
        {
            if (_sessions.GetValueOrDefault(sessionId) is not { State: RemoteSessionState.Ringing } session
                || session.Parties.HostConnectionId != hostConnectionId)
            {
                return null;
            }

            session.State = RemoteSessionState.Accepted;
            return session;
        }
    }

    /// <summary>The other party's connection, when the caller is in the session.</summary>
    public string? OtherSide(string sessionId, string connectionId)
    {
        lock (_gate)
        {
            return _sessions.GetValueOrDefault(sessionId) is { } session ? Other(session, connectionId) : null;
        }
    }

    /// <summary>Where a signaling message goes: the other party, once the host accepted.</summary>
    public string? SignalTarget(string sessionId, string connectionId)
    {
        lock (_gate)
        {
            return _sessions.GetValueOrDefault(sessionId) is { State: RemoteSessionState.Accepted } session ? Other(session, connectionId) : null;
        }
    }

    public RemoteSession? Remove(string sessionId)
    {
        lock (_gate)
        {
            return _sessions.Remove(sessionId, out var session) ? session : null;
        }
    }

    /// <summary>Ends every session the connection was in.</summary>
    public IReadOnlyList<RemoteSession> RemoveFor(string connectionId)
    {
        lock (_gate)
        {
            var ended = _sessions.Values.Where(s => s.Has(connectionId)).ToList();
            foreach (var session in ended)
            {
                _sessions.Remove(session.Id);
            }

            return ended;
        }
    }

    /// <summary>Ends the sessions that rang for longer than <see cref="RemoteLimits.RingFor"/>.</summary>
    public IReadOnlyList<RemoteSession> ExpireRinging()
    {
        var cutoff = time.GetUtcNow() - RemoteLimits.RingFor;
        lock (_gate)
        {
            var expired = _sessions.Values.Where(s => s.State == RemoteSessionState.Ringing && s.CreatedAt < cutoff).ToList();
            foreach (var session in expired)
            {
                _sessions.Remove(session.Id);
            }

            return expired;
        }
    }

    public int CountFor(string connectionId)
    {
        lock (_gate)
        {
            return _sessions.Values.Count(s => s.Has(connectionId));
        }
    }

    private static string? Other(RemoteSession session, string connectionId) =>
        session.Parties.HostConnectionId == connectionId ? session.Parties.ControllerConnectionId
        : session.Parties.ControllerConnectionId == connectionId ? session.Parties.HostConnectionId
        : null;
}
