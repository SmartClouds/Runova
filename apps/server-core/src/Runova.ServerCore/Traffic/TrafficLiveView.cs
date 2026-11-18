using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Traffic;

/// <summary>
/// What is happening on the sites now (E109), from memory and never from the database: visitors
/// seen in the last five minutes, requests in the last minute, and the pages people are looking at.
/// Lines older than five minutes (a backlog read late) are left out. Each site, and every site
/// together, keeps at most a fixed number of visitors and recent page views. Safe from several threads.
/// </summary>
internal sealed class TrafficLiveView(TimeProvider time, int maxVisitors = TrafficLiveView.DefaultMaxVisitors)
{
    public const int DefaultMaxVisitors = 50_000;

    public const int MaxPagesKept = 5000;

    public const int PagesShown = 10;

    private static readonly long _visitorWindowMs = (long)TimeSpan.FromMinutes(5).TotalMilliseconds;

    private const long SecondMs = 1000;

    private const int Seconds = 60;

    private readonly Lock _gate = new();
    private readonly Dictionary<string, Site> _sites = new(StringComparer.Ordinal);

    public void Record(in TrafficRequest request)
    {
        var now = time.GetUtcNow().ToUnixTimeMilliseconds();
        var at = Math.Min(request.AtUnixMs, now);
        if (now - at > _visitorWindowMs)
        {
            return;
        }

        var page = !request.Agent.IsBot && TrafficAggregator.IsPageView(request);
        lock (_gate)
        {
            foreach (var key in new[] { request.Site, TrafficSites.All })
            {
                if (!_sites.TryGetValue(key, out var site))
                {
                    site = new Site();
                    _sites[key] = site;
                }

                site.Request(at);
                if (!request.Agent.IsBot)
                {
                    site.Visitor(request.Visitor, at, now, maxVisitors);
                }

                if (page)
                {
                    site.Page(request.Path, at);
                }
            }
        }
    }

    /// <summary>One site, or every site when the id is null.</summary>
    public TrafficLive Snapshot(string? siteId)
    {
        var now = time.GetUtcNow().ToUnixTimeMilliseconds();
        lock (_gate)
        {
            if (!_sites.TryGetValue(siteId ?? TrafficSites.All, out var site))
            {
                return new TrafficLive(now, 0, 0, []);
            }

            site.Forget(now);
            return new TrafficLive(
                now,
                site.Visitors.Count,
                site.RequestsSince(now - (Seconds * SecondMs)),
                [.. site.Pages.GroupBy(p => p.Path, StringComparer.Ordinal)
                    .Select(g => new TrafficCount(g.Key, g.LongCount()))
                    .OrderByDescending(c => c.Count)
                    .ThenBy(c => c.Value, StringComparer.Ordinal)
                    .Take(PagesShown)]);
        }
    }

    private sealed class Site
    {
        private readonly long[] _seconds = new long[Seconds];
        private readonly int[] _counts = new int[Seconds];
        private long _forgotAt;

        public Dictionary<ulong, long> Visitors { get; } = [];

        public Queue<(long At, string Path)> Pages { get; } = new();

        public void Request(long at)
        {
            var second = at / SecondMs;
            var slot = (int)(second % Seconds);
            if (_seconds[slot] != second)
            {
                _seconds[slot] = second;
                _counts[slot] = 0;
            }

            _counts[slot]++;
        }

        public int RequestsSince(long from)
        {
            var total = 0;
            for (var i = 0; i < Seconds; i++)
            {
                if (_seconds[i] * SecondMs >= from)
                {
                    total += _counts[i];
                }
            }

            return total;
        }

        public void Visitor(ulong visitor, long at, long now, int max)
        {
            if (!Visitors.ContainsKey(visitor) && Visitors.Count >= max)
            {
                // Full: older visitors go, at most once a second, so a busy site does not scan the map per line.
                if (now - _forgotAt >= SecondMs)
                {
                    _forgotAt = now;
                    Forget(now);
                }

                if (Visitors.Count >= max)
                {
                    return;
                }
            }

            Visitors[visitor] = Math.Max(at, Visitors.GetValueOrDefault(visitor));
        }

        public void Page(string path, long at)
        {
            Pages.Enqueue((at, path));
            while (Pages.Count > MaxPagesKept)
            {
                Pages.Dequeue();
            }
        }

        /// <summary>Lets go of visitors and pages older than five minutes.</summary>
        public void Forget(long now)
        {
            var cutoff = now - _visitorWindowMs;
            foreach (var old in Visitors.Where(v => v.Value < cutoff).Select(v => v.Key).ToList())
            {
                Visitors.Remove(old);
            }

            while (Pages.TryPeek(out var page) && page.At < cutoff)
            {
                Pages.Dequeue();
            }
        }
    }
}
