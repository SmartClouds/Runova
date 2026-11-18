namespace Runova.ServerCore.Traffic;

/// <summary>A visit that ended: its pages and how long it lasted, from its first page view to its last.</summary>
internal readonly record struct ClosedVisit(string Site, ulong Visitor, long StartUnixMs, int Pages, long Seconds);

/// <summary>
/// Open visits, one per visitor and site (E109). A visit is page views with no gap over
/// <see cref="Gap"/>; a longer gap ends it and starts another. At most <see cref="DefaultCapacity"/>
/// visits stay open: a new one past that ends the one quiet longest, so memory stays bounded
/// whatever the traffic. Times are the log lines' own. Not thread-safe.
/// </summary>
internal sealed class VisitTracker(int capacity = VisitTracker.DefaultCapacity)
{
    public const int DefaultCapacity = 100_000;

    public static readonly TimeSpan Gap = TimeSpan.FromMinutes(30);

    private static readonly long _gapMs = (long)Gap.TotalMilliseconds;

    private readonly Dictionary<(string Site, ulong Visitor), LinkedListNode<Visit>> _open = [];

    /// <summary>Least recently seen first.</summary>
    private readonly LinkedList<Visit> _order = new();

    public int Open => _open.Count;

    /// <summary>Counts a page view. True when it starts a visit; a visit it ends goes to <paramref name="closed"/>.</summary>
    public bool PageView(string site, ulong visitor, long atUnixMs, List<ClosedVisit>? closed = null)
    {
        var key = (site, visitor);
        if (_open.TryGetValue(key, out var node))
        {
            var visit = node.Value;
            if (atUnixMs - visit.Last <= _gapMs)
            {
                visit.Pages++;
                visit.Start = Math.Min(visit.Start, atUnixMs);
                visit.Last = Math.Max(visit.Last, atUnixMs);
                _order.Remove(node);
                _order.AddLast(node);
                return false;
            }

            End(node, closed);
        }

        if (_open.Count >= capacity && _order.First is { } oldest)
        {
            End(oldest, closed);
        }

        _open[key] = _order.AddLast(new Visit(site, visitor, atUnixMs));
        return true;
    }

    /// <summary>Ends every visit quiet for the whole gap by <paramref name="nowUnixMs"/>.</summary>
    public void Close(long nowUnixMs, List<ClosedVisit> closed)
    {
        ArgumentNullException.ThrowIfNull(closed);
        while (_order.First is { } oldest && nowUnixMs - oldest.Value.Last >= _gapMs)
        {
            End(oldest, closed);
        }
    }

    private void End(LinkedListNode<Visit> node, List<ClosedVisit>? closed)
    {
        var visit = node.Value;
        _order.Remove(node);
        _open.Remove((visit.Site, visit.Visitor));
        closed?.Add(new ClosedVisit(visit.Site, visit.Visitor, visit.Start, visit.Pages, (visit.Last - visit.Start) / 1000));
    }

    private sealed class Visit(string site, ulong visitor, long at)
    {
        public string Site { get; } = site;

        public ulong Visitor { get; } = visitor;

        public long Start { get; set; } = at;

        public long Last { get; set; } = at;

        public int Pages { get; set; } = 1;
    }
}
