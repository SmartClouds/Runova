namespace Runova.Website.Api.Remote;

/// <summary>
/// Sliding-window limits for the remote hub (E60), by any key: an account, a target computer. The
/// hub's methods are not HTTP requests, so ASP.NET's rate limiter can not see them.
/// </summary>
internal sealed class RemoteRateLimiter(TimeProvider time)
{
    private readonly Dictionary<string, Queue<DateTimeOffset>> _hits = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();
    private DateTimeOffset _lastSweep = DateTimeOffset.MinValue;

    /// <summary>How many keys are being tracked.</summary>
    public int Count
    {
        get
        {
            lock (_gate)
            {
                return _hits.Count;
            }
        }
    }

    public bool TryAcquire(string key, int limit, TimeSpan window)
    {
        var now = time.GetUtcNow();
        lock (_gate)
        {
            Sweep(now, window);
            if (!_hits.TryGetValue(key, out var hits))
            {
                hits = new Queue<DateTimeOffset>();
                _hits[key] = hits;
            }

            while (hits.Count > 0 && hits.Peek() <= now - window)
            {
                hits.Dequeue();
            }

            if (hits.Count >= limit)
            {
                return false;
            }

            hits.Enqueue(now);
            return true;
        }
    }

    // Once per window, keys with nothing left in it go, so a flood of keys does not stay in memory.
    private void Sweep(DateTimeOffset now, TimeSpan window)
    {
        if (now - _lastSweep < window)
        {
            return;
        }

        _lastSweep = now;
        foreach (var (key, hits) in _hits.ToList())
        {
            if (hits.Count == 0 || hits.Last() <= now - window)
            {
                _hits.Remove(key);
            }
        }
    }
}

/// <summary>The hub's limits.</summary>
internal static class RemoteLimits
{
    /// <summary>Connection requests one account may make.</summary>
    public const int RequestsPerAccount = 20;

    public static readonly TimeSpan RequestWindow = TimeSpan.FromMinutes(1);

    /// <summary>Password requests one computer takes from everyone together, against guessing.</summary>
    public const int PasswordRequestsPerDevice = 30;

    public static readonly TimeSpan PasswordWindow = TimeSpan.FromMinutes(10);

    /// <summary>Signaling messages per session, which is far more than ICE ever needs.</summary>
    public const int SignalsPerSession = 600;

    public static readonly TimeSpan SignalWindow = TimeSpan.FromMinutes(1);

    /// <summary>The largest signaling message, in characters. An SDP offer is a few kilobytes.</summary>
    public const int MaxSignalLength = 64 * 1024;

    /// <summary>Sessions one connection may have open, ringing or live.</summary>
    public const int SessionsPerConnection = 8;

    /// <summary>How long a request rings before it is given up.</summary>
    public static readonly TimeSpan RingFor = TimeSpan.FromSeconds(60);
}
