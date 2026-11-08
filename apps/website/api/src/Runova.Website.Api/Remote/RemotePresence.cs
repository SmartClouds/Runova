namespace Runova.Website.Api.Remote;

/// <summary>
/// Which computers are online, through which hub connection (E60). Kept in memory: a restart
/// takes everyone offline and the apps come back within seconds as SignalR reconnects.
/// </summary>
internal sealed class RemotePresence
{
    public sealed record Entry(long DeviceId, long UserId);

    private readonly Dictionary<long, string> _byDevice = [];
    private readonly Dictionary<string, Entry> _byConnection = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();

    /// <summary>The device is online through this connection, which replaces any earlier one.</summary>
    public void Online(long deviceId, long userId, string connectionId)
    {
        lock (_gate)
        {
            _byDevice[deviceId] = connectionId;
            _byConnection[connectionId] = new Entry(deviceId, userId);
        }
    }

    /// <summary>The connection went away. Returns the device it took offline, if it was still the current one.</summary>
    public Entry? Offline(string connectionId)
    {
        lock (_gate)
        {
            if (!_byConnection.Remove(connectionId, out var entry))
            {
                return null;
            }

            if (_byDevice.TryGetValue(entry.DeviceId, out var current) && current == connectionId)
            {
                _byDevice.Remove(entry.DeviceId);
                return entry;
            }

            return null;
        }
    }

    /// <summary>Drops a revoked device. Returns the connection it was online through.</summary>
    public string? Remove(long deviceId)
    {
        lock (_gate)
        {
            if (!_byDevice.Remove(deviceId, out var connectionId))
            {
                return null;
            }

            _byConnection.Remove(connectionId);
            return connectionId;
        }
    }

    public bool IsOnline(long deviceId)
    {
        lock (_gate)
        {
            return _byDevice.ContainsKey(deviceId);
        }
    }

    public string? ConnectionOf(long deviceId)
    {
        lock (_gate)
        {
            return _byDevice.GetValueOrDefault(deviceId);
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
