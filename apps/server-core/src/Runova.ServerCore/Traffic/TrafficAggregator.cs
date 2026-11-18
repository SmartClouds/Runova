using System.Globalization;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Traffic;

/// <summary>What one hour or day adds to its row: counts only ever added, never set.</summary>
internal sealed class TrafficCounters
{
    public long Requests { get; set; }

    public long PageViews { get; set; }

    public long Visits { get; set; }

    public long Bounces { get; set; }

    public long VisitSeconds { get; set; }

    public long Bytes { get; set; }

    public long BotRequests { get; set; }

    public long Status2xx { get; set; }

    public long Status3xx { get; set; }

    public long Status4xx { get; set; }

    public long Status5xx { get; set; }

    public long ResponseMsTotal { get; set; }

    public long ResponseCount { get; set; }

    public long CountryCloudflare { get; set; }

    public long CountryDbIp { get; set; }

    public long CountryUnknown { get; set; }

    public long[] Histogram { get; } = new long[ResponseHistogram.Buckets];
}

internal sealed class TrafficDayDelta(long startUnixMs)
{
    public long StartUnixMs { get; } = startUnixMs;

    public TrafficCounters Counters { get; } = new();

    public HyperLogLog Sketch { get; } = new();
}

internal sealed class TrafficDimensionDelta(long startUnixMs)
{
    public long StartUnixMs { get; } = startUnixMs;

    public Dictionary<string, long> Values { get; } = new(StringComparer.Ordinal);
}

/// <summary>Everything counted since the last flush, by hour, day and dimension; the store adds it to the rows.</summary>
internal sealed class TrafficDelta
{
    public Dictionary<(string Site, long HourUnixMs), TrafficCounters> Hours { get; } = [];

    /// <summary>The visitors of each hour touched, estimated over the whole hour so far: the row keeps the larger.</summary>
    public Dictionary<(string Site, long HourUnixMs), long> HourVisitors { get; } = [];

    public Dictionary<(string Site, int Day), TrafficDayDelta> Days { get; } = [];

    public Dictionary<(string Site, int Day, TrafficDimension Dimension), TrafficDimensionDelta> Dimensions { get; } = [];

    public bool IsEmpty => Hours.Count == 0 && Days.Count == 0 && Dimensions.Count == 0;
}

/// <summary>
/// Turns requests into hourly, daily and per-dimension counts (E109), for each site and for every
/// site together (<see cref="TrafficSites.All"/>). Pure: lines in, a delta out, no clock and no I/O.
/// Bots count as requests and under the Bot dimension, never as visitors, page views or visits. A
/// visit is counted when it starts, under its first page (the entry page); its bounce and length
/// once it ends, in the hour and day it started. Days are those of the given time zone. Each
/// dimension keeps at most <c>maxValues</c> values a day in memory, the rest under "Other". Not
/// thread-safe: the tailer feeds it from one loop.
/// </summary>
internal sealed class TrafficAggregator(TimeZoneInfo zone, int maxValues = TrafficAggregator.DefaultMaxValues, int visitCapacity = VisitTracker.DefaultCapacity)
{
    public const int DefaultMaxValues = 5000;

    private const long HourMs = 3_600_000;

    /// <summary>Every time zone's offset is a whole number of quarter hours, so a day starts on one.</summary>
    private const long SlotMs = 15 * 60_000;

    private static readonly string[] _statuses = [.. Enumerable.Range(0, 1000).Select(code => code.ToString(CultureInfo.InvariantCulture))];

    private static readonly HashSet<string> _pageExtensions = new(StringComparer.OrdinalIgnoreCase) { "html", "htm", "xhtml", "shtml", "php", "asp", "aspx", "jsp", "cgi", "pl" };

    private readonly VisitTracker _visits = new(visitCapacity);
    private readonly List<ClosedVisit> _closed = [];
    private readonly Dictionary<long, (int Day, long Start)> _days = [];
    private readonly Dictionary<(string Site, long HourUnixMs), HyperLogLog> _hourSketches = [];
    private TrafficDelta _delta = new();

    public int OpenVisits => _visits.Open;

    public void Add(in TrafficRequest request)
    {
        var hour = request.AtUnixMs - Mod(request.AtUnixMs, HourMs);
        var (day, start) = DayOf(request.AtUnixMs);
        var pageView = !request.Agent.IsBot && IsPageView(request);
        Count(request.Site, request, hour, day, start, pageView);
        Count(TrafficSites.All, request, hour, day, start, pageView);
        if (!pageView)
        {
            return;
        }

        if (_visits.PageView(request.Site, request.Visitor, request.AtUnixMs, _closed))
        {
            foreach (var site in new[] { request.Site, TrafficSites.All })
            {
                HourOf(site, hour).Visits++;
                DayOf(site, day, start).Counters.Visits++;
                Dimension(site, day, start, TrafficDimension.EntryPage, request.Path);
            }
        }

        EndClosedVisits();
    }

    /// <summary>Ends the visits quiet for 30 minutes by <paramref name="nowUnixMs"/>, then hands over everything counted and starts afresh.</summary>
    public TrafficDelta TakeDelta(long nowUnixMs)
    {
        _visits.Close(nowUnixMs, _closed);
        EndClosedVisits();
        foreach (var key in _delta.Hours.Keys)
        {
            if (_hourSketches.TryGetValue(key, out var sketch))
            {
                _delta.HourVisitors[key] = sketch.Estimate();
            }
        }

        // An hour's sketch is kept while lines for it may still come.
        foreach (var old in _hourSketches.Keys.Where(key => key.HourUnixMs < nowUnixMs - (2 * HourMs)).ToList())
        {
            _hourSketches.Remove(old);
        }

        if (_days.Count > 4096)
        {
            _days.Clear();
        }

        var delta = _delta;
        _delta = new TrafficDelta();
        return delta;
    }

    /// <summary>GET or HEAD, answered 200 or 304, with HTML; on a line without a content type, a path that is not a static file.</summary>
    public static bool IsPageView(in TrafficRequest request) =>
        request.Method is TrafficMethod.Get or TrafficMethod.Head
        && request.Status is 200 or 304
        && (request.Html ?? !IsStaticFile(request.Path));

    public static bool IsStaticFile(string path)
    {
        ArgumentNullException.ThrowIfNull(path);
        var name = path[(path.LastIndexOf('/') + 1)..];
        var dot = name.LastIndexOf('.');
        return dot >= 0 && dot < name.Length - 1 && !_pageExtensions.Contains(name[(dot + 1)..]);
    }

    /// <summary>The domain of a referrer from another site, lowercase; null for none or for the site itself.</summary>
    public static string? ReferrerDomain(string? referrer, string? host)
    {
        if (string.IsNullOrEmpty(referrer))
        {
            return null;
        }

        var start = referrer.IndexOf("://", StringComparison.Ordinal);
        if (start <= 0)
        {
            return null;
        }

        start += 3;
        var end = referrer.IndexOfAny(['/', '?', '#'], start);
        var authority = referrer[start..(end < 0 ? referrer.Length : end)];
        authority = authority[(authority.LastIndexOf('@') + 1)..];
        var colon = authority.StartsWith('[') ? authority.IndexOf(']', StringComparison.Ordinal) + 1 : authority.IndexOf(':', StringComparison.Ordinal);
        var domain = (colon > 0 ? authority[..colon] : authority).ToLowerInvariant();
        return domain.Length == 0 || string.Equals(domain, host, StringComparison.OrdinalIgnoreCase) ? null : TrafficSites.Clip(domain);
    }

    private void Count(string site, in TrafficRequest request, long hour, int day, long start, bool pageView)
    {
        var hourCounters = HourOf(site, hour);
        var dayDelta = DayOf(site, day, start);
        foreach (var counters in new[] { hourCounters, dayDelta.Counters })
        {
            counters.Requests++;
            counters.Bytes += request.Bytes;
            switch (request.Status / 100)
            {
                case 2:
                    counters.Status2xx++;
                    break;
                case 3:
                    counters.Status3xx++;
                    break;
                case 4:
                    counters.Status4xx++;
                    break;
                case 5:
                    counters.Status5xx++;
                    break;
            }

            if (request.ResponseMs >= 0)
            {
                counters.ResponseMsTotal += request.ResponseMs;
                counters.ResponseCount++;
                ResponseHistogram.Add(counters.Histogram, request.ResponseMs);
            }

            if (request.Agent.IsBot)
            {
                counters.BotRequests++;
            }
            else if (pageView)
            {
                counters.PageViews++;
            }
        }

        Dimension(site, day, start, TrafficDimension.StatusCode, request.Status is >= 0 and < 1000 ? _statuses[request.Status] : "?");
        if (request.Agent.IsBot)
        {
            Dimension(site, day, start, TrafficDimension.Bot, request.Agent.Bot!);
            return;
        }

        // A person who got an answer, not a probe that found nothing.
        if (request.Status < 400)
        {
            dayDelta.Sketch.Add(request.Visitor);
            if (!_hourSketches.TryGetValue((site, hour), out var sketch))
            {
                sketch = new HyperLogLog();
                _hourSketches[(site, hour)] = sketch;
            }

            sketch.Add(request.Visitor);
        }

        if (!pageView)
        {
            return;
        }

        Dimension(site, day, start, TrafficDimension.Page, request.Path);
        if (ReferrerDomain(request.Referrer, request.Host) is { } referrer)
        {
            Dimension(site, day, start, TrafficDimension.Referrer, referrer);
        }

        Dimension(site, day, start, TrafficDimension.Browser, request.Agent.Browser);
        Dimension(site, day, start, TrafficDimension.OperatingSystem, request.Agent.OperatingSystem);
        Dimension(site, day, start, TrafficDimension.Device, DeviceName(request.Agent.Device));
        if (request.Geo.Country is not { } country)
        {
            return;
        }

        Dimension(site, day, start, TrafficDimension.Country, country);
        switch (request.Geo.Source)
        {
            case CountrySource.Cloudflare:
                dayDelta.Counters.CountryCloudflare++;
                break;
            case CountrySource.DbIp:
                dayDelta.Counters.CountryDbIp++;
                break;
            default:
                dayDelta.Counters.CountryUnknown++;
                break;
        }

        if (request.Geo.City is { Length: > 0 } city)
        {
            Dimension(site, day, start, TrafficDimension.City, $"{city}, {country}");
        }
    }

    private void EndClosedVisits()
    {
        foreach (var visit in _closed)
        {
            var hour = visit.StartUnixMs - Mod(visit.StartUnixMs, HourMs);
            var (day, start) = DayOf(visit.StartUnixMs);
            foreach (var site in new[] { visit.Site, TrafficSites.All })
            {
                foreach (var counters in new[] { HourOf(site, hour), DayOf(site, day, start).Counters })
                {
                    counters.Bounces += visit.Pages == 1 ? 1 : 0;
                    counters.VisitSeconds += visit.Seconds;
                }
            }
        }

        _closed.Clear();
    }

    private TrafficCounters HourOf(string site, long hour)
    {
        if (!_delta.Hours.TryGetValue((site, hour), out var counters))
        {
            counters = new TrafficCounters();
            _delta.Hours[(site, hour)] = counters;
        }

        return counters;
    }

    private TrafficDayDelta DayOf(string site, int day, long start)
    {
        if (!_delta.Days.TryGetValue((site, day), out var delta))
        {
            delta = new TrafficDayDelta(start);
            _delta.Days[(site, day)] = delta;
        }

        return delta;
    }

    private void Dimension(string site, int day, long start, TrafficDimension dimension, string value)
    {
        if (!_delta.Dimensions.TryGetValue((site, day, dimension), out var delta))
        {
            delta = new TrafficDimensionDelta(start);
            _delta.Dimensions[(site, day, dimension)] = delta;
        }

        var key = TrafficSites.Clip(value);
        if (delta.Values.TryGetValue(key, out var count))
        {
            delta.Values[key] = count + 1;
        }
        else if (delta.Values.Count >= maxValues)
        {
            delta.Values[TrafficSites.Other] = delta.Values.GetValueOrDefault(TrafficSites.Other) + 1;
        }
        else
        {
            delta.Values[key] = 1;
        }
    }

    /// <summary>The day (and when it began, in UTC) that the moment falls on in the time zone.</summary>
    private (int Day, long Start) DayOf(long unixMs)
    {
        var slot = unixMs - Mod(unixMs, SlotMs);
        if (_days.TryGetValue(slot, out var known))
        {
            return known;
        }

        var local = TimeZoneInfo.ConvertTime(DateTimeOffset.FromUnixTimeMilliseconds(unixMs), zone);
        var midnight = local.DateTime.Date;
        var start = new DateTimeOffset(midnight, zone.GetUtcOffset(midnight)).ToUnixTimeMilliseconds();
        var day = (DateOnly.FromDateTime(midnight).DayNumber, start);
        _days[slot] = day;
        return day;
    }

    private static string DeviceName(TrafficDevice device) => device switch
    {
        TrafficDevice.Mobile => "Mobile",
        TrafficDevice.Tablet => "Tablet",
        TrafficDevice.Bot => "Bot",
        _ => "Desktop",
    };

    private static long Mod(long value, long by) => ((value % by) + by) % by;
}
