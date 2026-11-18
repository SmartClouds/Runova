using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Traffic;

/// <summary>How far one site's log was read when a flush was taken.</summary>
internal sealed record TrafficCursorState(string SiteId, long Offset, string Fingerprint, int FingerprintLength, long? LastLineAt);

/// <summary>
/// Traffic statistics in the core's database (E109). The tailer's deltas are added to the rows in
/// one write transaction a minute, together with how far each log was read, so a restart neither
/// loses nor repeats a line. Each day keeps its <see cref="TopValuesPerDay"/> most common values
/// per dimension and folds the rest into "Other". Reports read only these rows: at most a year of
/// days (plus the year before for the comparison), at most a month of hours, and every breakdown
/// summed in SQL.
/// </summary>
internal sealed class TrafficStore(IDbContextFactory<CoreDbContext> contexts, TimeProvider time, int topValues = TrafficStore.TopValuesPerDay)
{
    public const int TopValuesPerDay = 500;

    public const int TopInReport = 50;

    public const int MaxDimensionPage = 500;

    public static readonly TimeSpan MaxHourlyRange = TimeSpan.FromDays(31);

    public static readonly TimeSpan MaxRange = TimeSpan.FromDays(3 * 366);

    private const long HourMs = 3_600_000;

    /// <summary>About what a row costs on disk, for the storage estimate.</summary>
    private const long HourRowBytes = 400;

    private const long DayRowBytes = 4096 + 500;

    private const long DimensionRowBytes = 120;

    private const long EventRowBytes = 400;

    public async Task FlushAsync(TrafficDelta delta, IReadOnlyCollection<TrafficCursorState> cursors, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(delta);
        ArgumentNullException.ThrowIfNull(cursors);
        if (delta.IsEmpty && cursors.Count == 0)
        {
            return;
        }

        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        await using var transaction = await CoreDatabase.BeginWriteAsync(db, cancellationToken);
        await AddHoursAsync(db, delta, cancellationToken);
        await AddDaysAsync(db, delta, cancellationToken);
        await AddDimensionsAsync(db, delta, cancellationToken);
        await SaveCursorsAsync(db, cursors, cancellationToken);
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    public async Task<TrafficCursorState[]> CursorsAsync(CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        return [.. (await db.TrafficLogCursors.AsNoTracking().OrderBy(c => c.SiteId).ToListAsync(cancellationToken))
            .Select(c => new TrafficCursorState(c.SiteId, c.Offset, c.Fingerprint, c.FingerprintLength, c.LastLineAt))];
    }

    /// <summary>The report for a range; ArgumentException for a range no report covers.</summary>
    public async Task<TrafficReport> ReportAsync(TrafficReportRequest request, TimeZoneInfo zone, bool enabled, long? collectingSince, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(zone);
        CheckRange(request.FromUnixMs, request.ToUnixMs);
        if (!Enum.IsDefined(request.Granularity))
        {
            throw new ArgumentException("A report is by hour, day, week or month.");
        }

        if (request.Granularity == TrafficGranularity.Hour && request.ToUnixMs - request.FromUnixMs > (long)MaxHourlyRange.TotalMilliseconds)
        {
            throw new ArgumentException($"An hourly report covers at most {MaxHourlyRange.TotalDays:0} days. Choose days for a longer range.");
        }

        var site = request.SiteId ?? TrafficSites.All;
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var current = await PeriodAsync(db, site, request.FromUnixMs, request.ToUnixMs, request.Granularity, zone, cancellationToken);
        Period? previous = null;
        if (request.Compare)
        {
            var length = request.ToUnixMs - request.FromUnixMs;
            previous = await PeriodAsync(db, site, request.FromUnixMs - length, request.FromUnixMs, request.Granularity, zone, cancellationToken);
        }

        var breakdowns = new List<TrafficBreakdown>();
        foreach (var dimension in Enum.GetValues<TrafficDimension>())
        {
            var values = DimensionRows(db, site, dimension, request.FromUnixMs, request.ToUnixMs, zone);
            var top = await Grouped(values).Take(TopInReport).ToListAsync(cancellationToken);
            var total = await values.SumAsync(d => (long?)d.Count, cancellationToken) ?? 0;
            breakdowns.Add(new TrafficBreakdown(dimension, [.. top], total));
        }

        return new TrafficReport(
            request.SiteId,
            request.FromUnixMs,
            request.ToUnixMs,
            request.Granularity,
            zone.Id,
            current.Totals,
            current.Series,
            [.. breakdowns],
            await HourOfWeekAsync(db, site, request.FromUnixMs, request.ToUnixMs, zone, cancellationToken),
            current.Sources,
            enabled,
            collectingSince,
            previous?.Totals,
            previous?.Series);
    }

    public async Task<TrafficDimensionPage> DimensionAsync(TrafficDimensionRequest request, TimeZoneInfo zone, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(zone);
        CheckRange(request.FromUnixMs, request.ToUnixMs);
        if (!Enum.IsDefined(request.Dimension))
        {
            throw new ArgumentException("There is no such breakdown.");
        }

        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var rows = DimensionRows(db, request.SiteId ?? TrafficSites.All, request.Dimension, request.FromUnixMs, request.ToUnixMs, zone);
        var total = await rows.SumAsync(d => (long?)d.Count, cancellationToken) ?? 0;
        if (request.Search?.Trim() is { Length: > 0 } search)
        {
            search = search.Length > 200 ? search[..200] : search;
            rows = rows.Where(d => d.Value.Contains(search));
        }

        var grouped = Grouped(rows);
        var count = await grouped.CountAsync(cancellationToken);
        var items = await grouped
            .Skip(Math.Max(0, request.Offset))
            .Take(Math.Clamp(request.Limit, 1, MaxDimensionPage))
            .ToListAsync(cancellationToken);
        return new TrafficDimensionPage(request.Dimension, [.. items], total, count);
    }

    /// <summary>Hours older than the hourly retention, and days and their values older than the daily one.</summary>
    public async Task<int> PruneAsync(int hourlyDays, int dailyDays, CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var hourCutoff = (now - TimeSpan.FromDays(hourlyDays)).ToUnixTimeMilliseconds();
        var dayCutoff = (now - TimeSpan.FromDays(dailyDays)).ToUnixTimeMilliseconds();
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        return await db.TrafficHours.Where(h => h.HourUnixMs < hourCutoff).ExecuteDeleteAsync(cancellationToken)
            + await db.TrafficDays.Where(d => d.StartUnixMs < dayCutoff).ExecuteDeleteAsync(cancellationToken)
            + await db.TrafficDimensionDays.Where(d => d.StartUnixMs < dayCutoff).ExecuteDeleteAsync(cancellationToken);
    }

    /// <summary>
    /// One site's statistics, or every site's (the all-sites rows with them) when the id is null.
    /// The cursors stay, so the logs are not read again from the start.
    /// </summary>
    public async Task DeleteAsync(string? siteId, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        if (siteId is null)
        {
            await db.TrafficHours.ExecuteDeleteAsync(cancellationToken);
            await db.TrafficDays.ExecuteDeleteAsync(cancellationToken);
            await db.TrafficDimensionDays.ExecuteDeleteAsync(cancellationToken);
            return;
        }

        await db.TrafficHours.Where(h => h.SiteId == siteId).ExecuteDeleteAsync(cancellationToken);
        await db.TrafficDays.Where(d => d.SiteId == siteId).ExecuteDeleteAsync(cancellationToken);
        await db.TrafficDimensionDays.Where(d => d.SiteId == siteId).ExecuteDeleteAsync(cancellationToken);
    }

    /// <summary>Roughly what statistics and attack events take in the database.</summary>
    public async Task<long> StorageBytesAsync(CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        return (await db.TrafficHours.LongCountAsync(cancellationToken) * HourRowBytes)
            + (await db.TrafficDays.LongCountAsync(cancellationToken) * DayRowBytes)
            + (await db.TrafficDimensionDays.LongCountAsync(cancellationToken) * DimensionRowBytes)
            + (await db.AttackEvents.LongCountAsync(cancellationToken) * EventRowBytes);
    }

    /// <summary>The day (days since 0001-01-01) a moment falls on in the zone.</summary>
    public static int DayNumber(long unixMs, TimeZoneInfo zone) =>
        DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.FromUnixTimeMilliseconds(unixMs), zone).DateTime).DayNumber;

    /// <summary>When a day of the zone begins, in UTC.</summary>
    public static long StartOf(DateOnly date, TimeZoneInfo zone)
    {
        ArgumentNullException.ThrowIfNull(zone);
        var midnight = date.ToDateTime(TimeOnly.MinValue);
        return new DateTimeOffset(midnight, zone.GetUtcOffset(midnight)).ToUnixTimeMilliseconds();
    }

    private static void CheckRange(long from, long to)
    {
        if (to <= from)
        {
            throw new ArgumentException("A report needs a range that ends after it starts.");
        }

        if (to - from > (long)MaxRange.TotalMilliseconds)
        {
            throw new ArgumentException($"A report covers at most {MaxRange.TotalDays:0} days.");
        }
    }

    private static IQueryable<TrafficDimensionDay> DimensionRows(CoreDbContext db, string site, TrafficDimension dimension, long from, long to, TimeZoneInfo zone)
    {
        var first = StartOf(DateOnly.FromDayNumber(DayNumber(from, zone)), zone);
        var last = StartOf(DateOnly.FromDayNumber(DayNumber(to - 1, zone)), zone);
        return db.TrafficDimensionDays.AsNoTracking()
            .Where(d => d.SiteId == site && d.Dimension == dimension && d.StartUnixMs >= first && d.StartUnixMs <= last);
    }

    private static IQueryable<TrafficCount> Grouped(IQueryable<TrafficDimensionDay> rows) =>
        rows.GroupBy(d => d.Value)
            .Select(g => new { Value = g.Key, Count = g.Sum(d => d.Count) })
            .OrderByDescending(x => x.Count)
            .ThenBy(x => x.Value)
            .Select(x => new TrafficCount(x.Value, x.Count));

    private static async Task<Period> PeriodAsync(CoreDbContext db, string site, long from, long to, TrafficGranularity granularity, TimeZoneInfo zone, CancellationToken cancellationToken)
    {
        var dayFrom = DayNumber(from, zone);
        var dayTo = DayNumber(to - 1, zone);
        var days = await db.TrafficDays.AsNoTracking()
            .Where(d => d.SiteId == site && d.Day >= dayFrom && d.Day <= dayTo)
            .OrderBy(d => d.Day)
            .ToListAsync(cancellationToken);
        var sources = new TrafficCountrySources(days.Sum(d => d.CountryCloudflare), days.Sum(d => d.CountryDbIp), days.Sum(d => d.CountryUnknown));
        var allVisitors = Merge(days);
        if (granularity == TrafficGranularity.Hour)
        {
            var hours = await db.TrafficHours.AsNoTracking()
                .Where(h => h.SiteId == site && h.HourUnixMs >= from && h.HourUnixMs < to)
                .ToDictionaryAsync(h => h.HourUnixMs, cancellationToken);
            var series = new List<TrafficPoint>();
            for (var hour = from - (((from % HourMs) + HourMs) % HourMs); hour < to; hour += HourMs)
            {
                var row = hours.GetValueOrDefault(hour);
                series.Add(row is null
                    ? new TrafficPoint(hour, 0, 0, 0, 0, 0, 0, 0, 0)
                    : new TrafficPoint(hour, row.Visitors, row.Visits, row.PageViews, row.Requests, row.BotRequests, row.Bytes, row.Status4xx, row.Status5xx));
            }

            return new Period(Totals(hours.Values.Select(Sums.Of), allVisitors.Estimate()), [.. series], sources);
        }

        var buckets = new List<(DateOnly Start, List<TrafficDay> Days)>();
        var start = Align(DateOnly.FromDayNumber(dayFrom), granularity);
        for (var date = start; StartOf(date, zone) < to && buckets.Count < 4000; date = Next(date, granularity))
        {
            buckets.Add((date, []));
        }

        var byStart = buckets.ToDictionary(b => b.Start);
        foreach (var day in days)
        {
            if (byStart.TryGetValue(Align(DateOnly.FromDayNumber(day.Day), granularity), out var bucket))
            {
                bucket.Days.Add(day);
            }
        }

        var points = buckets.Select(bucket =>
        {
            var sum = Sums.Total(bucket.Days.Select(Sums.Of));
            return new TrafficPoint(StartOf(bucket.Start, zone), Merge(bucket.Days).Estimate(), sum.Visits, sum.PageViews, sum.Requests, sum.BotRequests, sum.Bytes, sum.Status4xx, sum.Status5xx);
        });
        return new Period(Totals(days.Select(Sums.Of), allVisitors.Estimate()), [.. points], sources);
    }

    /// <summary>Page views by hour of the week, Monday 00:00 first, summed in SQL at the zone's offset at the range's end.</summary>
    private static async Task<long[]> HourOfWeekAsync(CoreDbContext db, string site, long from, long to, TimeZoneInfo zone, CancellationToken cancellationToken)
    {
        var offset = (long)zone.GetUtcOffset(DateTimeOffset.FromUnixTimeMilliseconds(to - 1)).TotalMilliseconds;
        var slots = await db.TrafficHours.AsNoTracking()
            .Where(h => h.SiteId == site && h.HourUnixMs >= from && h.HourUnixMs < to)
            .Select(h => new { Local = (h.HourUnixMs + offset) / HourMs, h.PageViews })
            // 1970-01-01 was a Thursday, the fourth day from Monday.
            .GroupBy(h => ((((h.Local / 24) + 3) % 7) * 24) + (h.Local % 24))
            .Select(g => new { Slot = g.Key, PageViews = g.Sum(h => h.PageViews) })
            .ToListAsync(cancellationToken);
        var week = new long[168];
        foreach (var slot in slots)
        {
            if (slot.Slot is >= 0 and < 168)
            {
                week[slot.Slot] = slot.PageViews;
            }
        }

        return week;
    }

    private static DateOnly Align(DateOnly date, TrafficGranularity granularity) => granularity switch
    {
        TrafficGranularity.Week => date.AddDays(-(((int)date.DayOfWeek + 6) % 7)),
        TrafficGranularity.Month => new DateOnly(date.Year, date.Month, 1),
        _ => date,
    };

    private static DateOnly Next(DateOnly date, TrafficGranularity granularity) => granularity switch
    {
        TrafficGranularity.Week => date.AddDays(7),
        TrafficGranularity.Month => date.AddMonths(1),
        _ => date.AddDays(1),
    };

    private static HyperLogLog Merge(IEnumerable<TrafficDay> days)
    {
        var sketch = new HyperLogLog();
        foreach (var day in days)
        {
            sketch.Merge(HyperLogLog.From(day.Sketch));
        }

        return sketch;
    }

    private static TrafficTotals Totals(IEnumerable<Sums> rows, long visitors)
    {
        var sum = Sums.Total(rows);
        return new TrafficTotals(
            visitors,
            sum.Visits,
            sum.PageViews,
            sum.Requests,
            sum.BotRequests,
            sum.Bytes,
            sum.Bounces,
            sum.VisitSeconds,
            sum.Status2xx,
            sum.Status3xx,
            sum.Status4xx,
            sum.Status5xx,
            sum.ResponseCount == 0 ? 0 : Math.Round((double)sum.ResponseMsTotal / sum.ResponseCount, 1),
            Math.Round(ResponseHistogram.Percentile(sum.Histogram, 0.95), 1));
    }

    private static async Task AddHoursAsync(CoreDbContext db, TrafficDelta delta, CancellationToken cancellationToken)
    {
        foreach (var group in delta.Hours.GroupBy(entry => entry.Key.Site))
        {
            var site = group.Key;
            var hours = group.Select(entry => entry.Key.HourUnixMs).ToList();
            var rows = await db.TrafficHours.Where(h => h.SiteId == site && hours.Contains(h.HourUnixMs)).ToDictionaryAsync(h => h.HourUnixMs, cancellationToken);
            foreach (var (key, counters) in group)
            {
                if (!rows.TryGetValue(key.HourUnixMs, out var row))
                {
                    row = new TrafficHour { SiteId = site, HourUnixMs = key.HourUnixMs };
                    db.TrafficHours.Add(row);
                }

                row.Requests += counters.Requests;
                row.PageViews += counters.PageViews;
                row.Visits += counters.Visits;
                row.Bounces += counters.Bounces;
                row.VisitSeconds += counters.VisitSeconds;
                row.Bytes += counters.Bytes;
                row.BotRequests += counters.BotRequests;
                row.Status2xx += counters.Status2xx;
                row.Status3xx += counters.Status3xx;
                row.Status4xx += counters.Status4xx;
                row.Status5xx += counters.Status5xx;
                row.ResponseMsTotal += counters.ResponseMsTotal;
                row.ResponseCount += counters.ResponseCount;
                row.ResponseHistogram = AddHistogram(row.ResponseHistogram, counters.Histogram);
                row.Visitors = Math.Max(row.Visitors, delta.HourVisitors.GetValueOrDefault(key));
            }
        }
    }

    private static async Task AddDaysAsync(CoreDbContext db, TrafficDelta delta, CancellationToken cancellationToken)
    {
        foreach (var group in delta.Days.GroupBy(entry => entry.Key.Site))
        {
            var site = group.Key;
            var days = group.Select(entry => entry.Key.Day).ToList();
            var rows = await db.TrafficDays.Where(d => d.SiteId == site && days.Contains(d.Day)).ToDictionaryAsync(d => d.Day, cancellationToken);
            foreach (var (key, dayDelta) in group)
            {
                if (!rows.TryGetValue(key.Day, out var row))
                {
                    row = new TrafficDay { SiteId = site, Day = key.Day, StartUnixMs = dayDelta.StartUnixMs };
                    db.TrafficDays.Add(row);
                }

                var counters = dayDelta.Counters;
                row.Requests += counters.Requests;
                row.PageViews += counters.PageViews;
                row.Visits += counters.Visits;
                row.Bounces += counters.Bounces;
                row.VisitSeconds += counters.VisitSeconds;
                row.Bytes += counters.Bytes;
                row.BotRequests += counters.BotRequests;
                row.Status2xx += counters.Status2xx;
                row.Status3xx += counters.Status3xx;
                row.Status4xx += counters.Status4xx;
                row.Status5xx += counters.Status5xx;
                row.ResponseMsTotal += counters.ResponseMsTotal;
                row.ResponseCount += counters.ResponseCount;
                row.CountryCloudflare += counters.CountryCloudflare;
                row.CountryDbIp += counters.CountryDbIp;
                row.CountryUnknown += counters.CountryUnknown;
                row.ResponseHistogram = AddHistogram(row.ResponseHistogram, counters.Histogram);
                var sketch = HyperLogLog.From(row.Sketch);
                sketch.Merge(dayDelta.Sketch);
                row.Sketch = sketch.ToArray();
            }
        }
    }

    private async Task AddDimensionsAsync(CoreDbContext db, TrafficDelta delta, CancellationToken cancellationToken)
    {
        foreach (var ((site, day, dimension), values) in delta.Dimensions)
        {
            var keys = values.Values.Keys.ToList();
            var group = db.TrafficDimensionDays.Where(d => d.SiteId == site && d.Day == day && d.Dimension == dimension);
            var rows = await group.Where(d => keys.Contains(d.Value)).ToDictionaryAsync(d => d.Value, StringComparer.Ordinal, cancellationToken);
            var added = false;
            foreach (var (value, count) in values.Values)
            {
                if (rows.TryGetValue(value, out var row))
                {
                    row.Count += count;
                    continue;
                }

                db.TrafficDimensionDays.Add(new TrafficDimensionDay { SiteId = site, Day = day, StartUnixMs = values.StartUnixMs, Dimension = dimension, Value = value, Count = count });
                added = true;
            }

            if (!added)
            {
                continue;
            }

            await db.SaveChangesAsync(cancellationToken);
            if (await group.CountAsync(d => d.Value != TrafficSites.Other, cancellationToken) <= topValues)
            {
                continue;
            }

            // Past the day's limit: the least common values go into "Other".
            var all = await group.ToListAsync(cancellationToken);
            var folded = all.Where(d => d.Value != TrafficSites.Other)
                .OrderByDescending(d => d.Count)
                .ThenBy(d => d.Value, StringComparer.Ordinal)
                .Skip(topValues)
                .ToList();
            var other = all.FirstOrDefault(d => d.Value == TrafficSites.Other);
            if (other is null)
            {
                other = new TrafficDimensionDay { SiteId = site, Day = day, StartUnixMs = values.StartUnixMs, Dimension = dimension, Value = TrafficSites.Other };
                db.TrafficDimensionDays.Add(other);
            }

            other.Count += folded.Sum(d => d.Count);
            db.TrafficDimensionDays.RemoveRange(folded);
        }
    }

    private async Task SaveCursorsAsync(CoreDbContext db, IReadOnlyCollection<TrafficCursorState> cursors, CancellationToken cancellationToken)
    {
        if (cursors.Count == 0)
        {
            return;
        }

        var ids = cursors.Select(c => c.SiteId).ToList();
        var rows = await db.TrafficLogCursors.Where(c => ids.Contains(c.SiteId)).ToDictionaryAsync(c => c.SiteId, StringComparer.Ordinal, cancellationToken);
        var now = time.GetUtcNow().ToUnixTimeMilliseconds();
        foreach (var cursor in cursors)
        {
            if (!rows.TryGetValue(cursor.SiteId, out var row))
            {
                row = new TrafficLogCursor { SiteId = cursor.SiteId };
                db.TrafficLogCursors.Add(row);
            }

            row.Offset = cursor.Offset;
            row.Fingerprint = cursor.Fingerprint;
            row.FingerprintLength = cursor.FingerprintLength;
            row.LastLineAt = cursor.LastLineAt ?? row.LastLineAt;
            row.UpdatedAt = now;
        }
    }

    private static byte[] AddHistogram(byte[] stored, long[] counts)
    {
        var total = ResponseHistogram.Read(stored);
        ResponseHistogram.AddTo(total, counts);
        return ResponseHistogram.Write(total);
    }

    private sealed record Period(TrafficTotals Totals, TrafficPoint[] Series, TrafficCountrySources Sources);

    /// <summary>Hour and day rows summed alike.</summary>
    private sealed class Sums
    {
        public long Visits { get; private set; }

        public long PageViews { get; private set; }

        public long Requests { get; private set; }

        public long BotRequests { get; private set; }

        public long Bytes { get; private set; }

        public long Bounces { get; private set; }

        public long VisitSeconds { get; private set; }

        public long Status2xx { get; private set; }

        public long Status3xx { get; private set; }

        public long Status4xx { get; private set; }

        public long Status5xx { get; private set; }

        public long ResponseMsTotal { get; private set; }

        public long ResponseCount { get; private set; }

        public long[] Histogram { get; } = new long[ResponseHistogram.Buckets];

        public static Sums Of(TrafficHour row) => Of(row.Visits, row.PageViews, row.Requests, row.BotRequests, row.Bytes, row.Bounces, row.VisitSeconds, row.Status2xx, row.Status3xx, row.Status4xx, row.Status5xx, row.ResponseMsTotal, row.ResponseCount, row.ResponseHistogram);

        public static Sums Of(TrafficDay row) => Of(row.Visits, row.PageViews, row.Requests, row.BotRequests, row.Bytes, row.Bounces, row.VisitSeconds, row.Status2xx, row.Status3xx, row.Status4xx, row.Status5xx, row.ResponseMsTotal, row.ResponseCount, row.ResponseHistogram);

        public static Sums Total(IEnumerable<Sums> parts)
        {
            var total = new Sums();
            foreach (var part in parts)
            {
                total.Visits += part.Visits;
                total.PageViews += part.PageViews;
                total.Requests += part.Requests;
                total.BotRequests += part.BotRequests;
                total.Bytes += part.Bytes;
                total.Bounces += part.Bounces;
                total.VisitSeconds += part.VisitSeconds;
                total.Status2xx += part.Status2xx;
                total.Status3xx += part.Status3xx;
                total.Status4xx += part.Status4xx;
                total.Status5xx += part.Status5xx;
                total.ResponseMsTotal += part.ResponseMsTotal;
                total.ResponseCount += part.ResponseCount;
                ResponseHistogram.AddTo(total.Histogram, part.Histogram);
            }

            return total;
        }

        private static Sums Of(long visits, long pageViews, long requests, long bots, long bytes, long bounces, long seconds, long s2, long s3, long s4, long s5, long msTotal, long msCount, byte[] histogram)
        {
            var sums = new Sums
            {
                Visits = visits,
                PageViews = pageViews,
                Requests = requests,
                BotRequests = bots,
                Bytes = bytes,
                Bounces = bounces,
                VisitSeconds = seconds,
                Status2xx = s2,
                Status3xx = s3,
                Status4xx = s4,
                Status5xx = s5,
                ResponseMsTotal = msTotal,
                ResponseCount = msCount,
            };
            ResponseHistogram.AddTo(sums.Histogram, ResponseHistogram.Read(histogram));
            return sums;
        }
    }
}
