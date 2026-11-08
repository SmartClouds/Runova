using Runova.Website.Data.Remote;

namespace Runova.Website.Api.Remote;

public enum PresenceChange
{
    /// <summary>The device is still reachable, or the connection was not current.</summary>
    None,

    /// <summary>That was the device's last way in.</summary>
    WentOffline,
}

/// <summary>
/// Which computers are online, and through which hub connection (E60). A computer has up to two
/// ways in: the app while someone is signed in, and the background agent (E64). The app answers
/// when it is there; the agent covers the rest. Kept in memory: a restart takes everyone offline
/// and both come back within seconds as SignalR reconnects.
/// </summary>
internal sealed class RemotePresence
{
    public sealed record Entry(long DeviceId, long UserId, string Kind);

    public sealed record Endpoint(string ConnectionId, string Kind);

    public sealed record Gone(Entry? Entry, PresenceChange Change);

    private readonly Dictionary<long, Dictionary<string, string>> _byDevice = [];
    private readonly Dictionary<string, Entry> _byConnection = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();

    /// <summary>The device is online through this connection, which replaces any earlier one of the same kind.</summary>
    public void Online(long deviceId, long userId, string connectionId, string kind = RemoteDeviceKinds.App)
    {
        lock (_gate)
        {
            if (!_byDevice.TryGetValue(deviceId, out var endpoints))
            {
                endpoints = new Dictionary<string, string>(StringComparer.Ordinal);
                _byDevice[deviceId] = endpoints;
            }

            if (endpoints.Remove(kind, out var previous))
            {
                _byConnection.Remove(previous);
            }

            endpoints[kind] = connectionId;
            _byConnection[connectionId] = new Entry(deviceId, userId, kind);
        }
    }

    /// <summary>The connection went away.</summary>
    public Gone Offline(string connectionId)
    {
        lock (_gate)
        {
            if (!_byConnection.Remove(connectionId, out var entry))
            {
                return new Gone(null, PresenceChange.None);
            }

            if (!_byDevice.TryGetValue(entry.DeviceId, out var endpoints)
                || !endpoints.TryGetValue(entry.Kind, out var current)
                || current != connectionId)
            {
                return new Gone(entry, PresenceChange.None);
            }

            endpoints.Remove(entry.Kind);
            if (endpoints.Count > 0)
            {
                return new Gone(entry, PresenceChange.None);
            }

            _byDevice.Remove(entry.DeviceId);
            return new Gone(entry, PresenceChange.WentOffline);
        }
    }

    /// <summary>Drops a revoked device. Returns the connections it was online through.</summary>
    public IReadOnlyList<string> Remove(long deviceId)
    {
        lock (_gate)
        {
            if (!_byDevice.Remove(deviceId, out var endpoints))
            {
                return [];
            }

            foreach (var connection in endpoints.Values)
            {
                _byConnection.Remove(connection);
            }

            return [.. endpoints.Values];
        }
    }

    /// <summary>Drops the device's agent only, when its owner turned it off. Returns its connection.</summary>
    public string? RemoveAgent(long deviceId)
    {
        lock (_gate)
        {
            if (!_byDevice.TryGetValue(deviceId, out var endpoints) || !endpoints.Remove(RemoteDeviceKinds.Agent, out var connection))
            {
                return null;
            }

            _byConnection.Remove(connection);
            if (endpoints.Count == 0)
            {
                _byDevice.Remove(deviceId);
            }

            return connection;
        }
    }

    public bool IsOnline(long deviceId)
    {
        lock (_gate)
        {
            return _byDevice.ContainsKey(deviceId);
        }
    }

    /// <summary>Where a request for the device goes: the app when it is there, otherwise the agent.</summary>
    public Endpoint? EndpointOf(long deviceId)
    {
        lock (_gate)
        {
            if (!_byDevice.TryGetValue(deviceId, out var endpoints))
            {
                return null;
            }

            return endpoints.TryGetValue(RemoteDeviceKinds.App, out var app) ? new Endpoint(app, RemoteDeviceKinds.App)
                : endpoints.TryGetValue(RemoteDeviceKinds.Agent, out var agent) ? new Endpoint(agent, RemoteDeviceKinds.Agent)
                : null;
        }
    }

    public Entry? DeviceOf(string connectionId)
    {
        lock (_gate)
        {
            return _byConnection.GetValueOrDefault(connectionId);
        }
    }
}
