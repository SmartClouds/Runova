using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Traffic;

namespace Runova.ServerCore.Tests.Traffic;

/// <summary>
/// E109 T5, AC1, AC5 and AC6: deltas are added to hourly, daily and dimension rows in one write,
/// with the cursors they were read up to; a day keeps its top values and folds the rest into
/// "Other"; reports read pre-aggregated rows (series by hour, day, week from Monday, or month, the
/// period before, top 50 per dimension, the hour of the week); retention prunes old rows; and no
/// statistics row ever holds a visitor's address.
/// </summary>
public sealed class TrafficStoreTests : IAsyncLifetime
{
    /// <summary>Wednesday 2026-11-18 00:00 UTC.</summary>
    private const long Wednesday = 1_794_960_000_000;

    private const long Hour = 3_600_000;

    private const long Day = 24 * Hour;

    private static readonly UserAgentInfo _firefox = new("Firefox", 133, "Windows", TrafficDevice.Desktop, null);

    private static readonly UserAgentInfo _phone = new("Safari", 18, "iOS", TrafficDevice.Mobile, null);

    private readonly FakeTimeProvider _clock = new(DateTimeOffset.FromUnixTimeMilliseconds(Wednesday + (12 * Hour)));

    private TestDatabase _database = null!;

    private TrafficStore _store = null!;

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        _database = await TestDatabase.CreateAsync();
        _store = new TrafficStore(_database.Contexts, _clock);
    }

    public async ValueTask DisposeAsync() => await _database.DisposeAsync();

    private static TrafficRequest Request(long at, ulong visitor = 1, string path = "/", string site = "app", UserAgentInfo? agent = null, string country = "DE", int status = 200, string? referrer = null) =>
        new(site, at, IpKey.FromAddress(IPAddress.Parse("203.0.113.7")), TrafficMethod.Get, path, null, status, 1000, 20, true, referrer, "app.example.com", agent ?? _firefox, new GeoResult(country, CountrySource.Cloudflare, null, null), visitor, false);

    private async Task FlushAsync(TimeZoneInfo zone, params TrafficRequest[] requests)
    {
        var aggregator = new TrafficAggregator(zone);
        foreach (var request in requests)
        {
            aggregator.Add(request);
        }

        await _store.FlushAsync(aggregator.TakeDelta(requests.Max(r => r.AtUnixMs) + Day), [], Cancel);
    }

    private Task FlushAsync(params TrafficRequest[] requests) => FlushAsync(TimeZoneInfo.Utc, requests);

    private Task<TrafficReport> ReportAsync(long from, long to, TrafficGranularity granularity, string? site = "app", bool compare = true, TimeZoneInfo? zone = null) =>
        _store.ReportAsync(new TrafficReportRequest(site, from, to, granularity, compare), zone ?? TimeZoneInfo.Utc, enabled: true, collectingSince: Wednesday, Cancel);

    [Fact]
    public async Task Flushes_add_up_and_a_returning_visitor_counts_once_a_day()
    {
        await FlushAsync(Request(Wednesday + Hour), Request(Wednesday + Hour + 60_000, visitor: 2));
        await FlushAsync(Request(Wednesday + (2 * Hour), visitor: 1), Request(Wednesday + (2 * Hour), visitor: 3));

        await using var db = await _database.Contexts.CreateDbContextAsync(Cancel);
        var day = await db.TrafficDays.SingleAsync(d => d.SiteId == "app", Cancel);
        Assert.Equal(4, day.PageViews);
        Assert.Equal(3, HyperLogLog.From(day.Sketch).Estimate());
        Assert.Equal(4, (await db.TrafficHours.Where(h => h.SiteId == "app").ToListAsync(Cancel)).Sum(h => h.PageViews));
        Assert.Equal(4, (await db.TrafficDimensionDays.SingleAsync(d => d.SiteId == "app" && d.Dimension == TrafficDimension.Page, Cancel)).Count);
        Assert.Equal(4, (await db.TrafficDays.SingleAsync(d => d.SiteId == TrafficSites.All, Cancel)).PageViews);
    }

    [Fact]
    public async Task An_hours_visitors_keep_the_larger_estimate()
    {
        var aggregator = new TrafficAggregator(TimeZoneInfo.Utc);
        aggregator.Add(Request(Wednesday + Hour, visitor: 1));
        aggregator.Add(Request(Wednesday + Hour, visitor: 2));
        await _store.FlushAsync(aggregator.TakeDelta(Wednesday + Hour), [], Cancel);
        aggregator.Add(Request(Wednesday + Hour + 1000, visitor: 1));
        await _store.FlushAsync(aggregator.TakeDelta(Wednesday + Hour + 1000), [], Cancel);

        await using var db = await _database.Contexts.CreateDbContextAsync(Cancel);
        Assert.Equal(2, (await db.TrafficHours.SingleAsync(h => h.SiteId == "app", Cancel)).Visitors);
    }

    [Fact]
    public async Task A_day_keeps_its_top_values_and_folds_the_rest_into_other()
    {
        var store = new TrafficStore(_database.Contexts, _clock, topValues: 3);
        var aggregator = new TrafficAggregator(TimeZoneInfo.Utc);
        foreach (var (path, times) in new[] { ("/a", 5), ("/b", 4), ("/c", 3), ("/d", 2) })
        {
            for (var i = 0; i < times; i++)
            {
                aggregator.Add(Request(Wednesday + Hour, path: path));
            }
        }

        await store.FlushAsync(aggregator.TakeDelta(Wednesday + Hour), [], Cancel);
        aggregator.Add(Request(Wednesday + Hour, path: "/e"));
        await store.FlushAsync(aggregator.TakeDelta(Wednesday + Hour), [], Cancel);

        await using var db = await _database.Contexts.CreateDbContextAsync(Cancel);
        var pages = await db.TrafficDimensionDays.Where(d => d.SiteId == "app" && d.Dimension == TrafficDimension.Page).ToDictionaryAsync(d => d.Value, d => d.Count, Cancel);
        Assert.Equal(new Dictionary<string, long> { ["/a"] = 5, ["/b"] = 4, ["/c"] = 3, [TrafficSites.Other] = 3 }, pages);
    }

    [Fact]
    public async Task Cursors_are_saved_with_the_counts_they_were_read_up_to()
    {
        await _store.FlushAsync(new TrafficDelta(), [new TrafficCursorState("app", 4096, "abc", 64, Wednesday)], Cancel);
        await _store.FlushAsync(new TrafficDelta(), [new TrafficCursorState("app", 8192, "abc", 64, Wednesday + 1)], Cancel);

        var cursors = await _store.CursorsAsync(Cancel);

        Assert.Equal(new TrafficCursorState("app", 8192, "abc", 64, Wednesday + 1), Assert.Single(cursors));
    }

    [Fact]
    public async Task A_day_report_has_totals_a_filled_series_breakdowns_and_the_period_before()
    {
        await FlushAsync(
            Request(Wednesday - Day + Hour, visitor: 9),
            Request(Wednesday + (9 * Hour), visitor: 1, path: "/", referrer: "https://news.example.org/"),
            Request(Wednesday + (9 * Hour) + 60_000, visitor: 1, path: "/pricing"),
            Request(Wednesday + (10 * Hour), visitor: 2, path: "/", agent: _phone, country: "SE"),
            Request(Wednesday + (10 * Hour), visitor: 3, path: "/robots.txt", agent: new UserAgentInfo("Other", 0, "Other", TrafficDevice.Bot, "Googlebot")),
            Request(Wednesday + (2 * Day) + Hour, visitor: 4, path: "/blog"));

        var report = await ReportAsync(Wednesday, Wednesday + (3 * Day), TrafficGranularity.Day);

        Assert.Equal((3L, 4L, 5L, 1L), (report.Totals.Visits, report.Totals.PageViews, report.Totals.Requests, report.Totals.BotRequests));
        Assert.Equal(3, report.Totals.Visitors);
        Assert.Equal([Wednesday, Wednesday + Day, Wednesday + (2 * Day)], report.Series.Select(p => p.StartUnixMs));
        Assert.Equal([3L, 0L, 1L], report.Series.Select(p => p.PageViews));
        Assert.Equal([2L, 0L, 1L], report.Series.Select(p => p.Visitors));
        var pages = report.Breakdowns.Single(b => b.Dimension == TrafficDimension.Page);
        Assert.Equal(("/", 2L), (pages.Top[0].Value, pages.Top[0].Count));
        Assert.Equal(4, pages.Total);
        Assert.Equal("news.example.org", Assert.Single(report.Breakdowns.Single(b => b.Dimension == TrafficDimension.Referrer).Top).Value);
        Assert.Equal(["Desktop", "Mobile"], report.Breakdowns.Single(b => b.Dimension == TrafficDimension.Device).Top.Select(c => c.Value).Order());
        Assert.Equal("Googlebot", Assert.Single(report.Breakdowns.Single(b => b.Dimension == TrafficDimension.Bot).Top).Value);
        Assert.Equal(Enum.GetValues<TrafficDimension>(), report.Breakdowns.Select(b => b.Dimension));
        Assert.Equal(1, report.Previous!.PageViews);
        Assert.Equal(3, report.PreviousSeries!.Length);
        Assert.Equal(new TrafficCountrySources(4, 0, 0), report.CountrySources);
        Assert.Equal(168, report.HourOfWeek.Length);
        // Wednesday is the third day from Monday: 09:00 and 10:00 that day.
        Assert.Equal(2, report.HourOfWeek[(2 * 24) + 9]);
        Assert.Equal(1, report.HourOfWeek[(2 * 24) + 10]);
        Assert.True(report.Enabled);
        Assert.Equal("UTC", report.TimeZone);
        Assert.Equal(Wednesday, report.CollectingSinceUnixMs);
    }

    [Fact]
    public async Task Weeks_start_on_monday_and_months_on_the_first()
    {
        var monday = Wednesday - (2 * Day);
        await FlushAsync(
            Request(monday - Hour, visitor: 1),
            Request(monday + Hour, visitor: 2),
            Request(monday + (6 * Day) + Hour, visitor: 2),
            Request(monday + (7 * Day) + Hour, visitor: 3));

        var weeks = await ReportAsync(monday - (7 * Day), monday + (14 * Day), TrafficGranularity.Week, compare: false);
        var months = await ReportAsync(new DateTimeOffset(2026, 11, 1, 0, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds(), new DateTimeOffset(2027, 1, 1, 0, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds(), TrafficGranularity.Month, compare: false);

        Assert.Equal([monday - (7 * Day), monday, monday + (7 * Day)], weeks.Series.Select(p => p.StartUnixMs));
        Assert.Equal([1L, 2L, 1L], weeks.Series.Select(p => p.PageViews));
        Assert.Equal([1L, 1L, 1L], weeks.Series.Select(p => p.Visitors));
        Assert.Null(weeks.Previous);
        Assert.Equal([new DateTimeOffset(2026, 11, 1, 0, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds(), new DateTimeOffset(2026, 12, 1, 0, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds()], months.Series.Select(p => p.StartUnixMs));
        Assert.Equal(4, months.Series[0].PageViews);
        Assert.Equal(3, months.Totals.Visitors);
    }

    [Fact]
    public async Task An_hour_report_reads_the_hourly_rows()
    {
        await FlushAsync(Request(Wednesday + (9 * Hour)), Request(Wednesday + (9 * Hour) + 1000, visitor: 2), Request(Wednesday + (11 * Hour)));

        var report = await ReportAsync(Wednesday + (8 * Hour), Wednesday + (12 * Hour), TrafficGranularity.Hour, compare: false);

        Assert.Equal([0L, 2L, 0L, 1L], report.Series.Select(p => p.PageViews));
        Assert.Equal([0L, 2L, 0L, 1L], report.Series.Select(p => p.Visitors));
        Assert.Equal(3, report.Totals.PageViews);
    }

    [Fact]
    public async Task An_hour_report_is_refused_beyond_a_month()
    {
        await Assert.ThrowsAsync<ArgumentException>(() => ReportAsync(Wednesday - (40 * Day), Wednesday, TrafficGranularity.Hour));
    }

    [Fact]
    public async Task Reports_for_every_site_read_the_rows_kept_for_all()
    {
        await FlushAsync(Request(Wednesday + Hour, site: "app"), Request(Wednesday + Hour, site: "blog", visitor: 2));

        var report = await ReportAsync(Wednesday, Wednesday + Day, TrafficGranularity.Day, site: null);

        Assert.Equal(2, report.Totals.PageViews);
        Assert.Null(report.SiteId);
    }

    [Fact]
    public async Task Every_value_of_a_dimension_comes_a_page_at_a_time_with_a_search()
    {
        var requests = Enumerable.Range(0, 30).SelectMany(i => Enumerable.Repeat(Request(Wednesday + Hour, path: $"/post-{i:00}", visitor: (ulong)i), i + 1)).ToArray();
        await FlushAsync(requests);

        var first = await _store.DimensionAsync(new TrafficDimensionRequest("app", Wednesday, Wednesday + Day, TrafficDimension.Page, 0, 10), TimeZoneInfo.Utc, Cancel);
        var second = await _store.DimensionAsync(new TrafficDimensionRequest("app", Wednesday, Wednesday + Day, TrafficDimension.Page, 10, 10), TimeZoneInfo.Utc, Cancel);
        var found = await _store.DimensionAsync(new TrafficDimensionRequest("app", Wednesday, Wednesday + Day, TrafficDimension.Page, Search: "post-2"), TimeZoneInfo.Utc, Cancel);

        Assert.Equal(("/post-29", 30L), (first.Items[0].Value, first.Items[0].Count));
        Assert.Equal("/post-19", second.Items[0].Value);
        Assert.Equal(30, first.TotalItems);
        Assert.Equal(465, first.Total);
        Assert.Equal(10, found.TotalItems);
        Assert.All(found.Items, item => Assert.Contains("post-2", item.Value, StringComparison.Ordinal));
    }

    [Fact]
    public async Task Retention_prunes_hours_and_days_separately()
    {
        await FlushAsync(Request(Wednesday - (100 * Day)), Request(Wednesday - (10 * Day)), Request(Wednesday - Hour));

        var pruned = await _store.PruneAsync(hourlyDays: 7, dailyDays: 30, Cancel);

        await using var db = await _database.Contexts.CreateDbContextAsync(Cancel);
        Assert.True(pruned > 0);
        Assert.Equal(2, await db.TrafficHours.CountAsync(Cancel));
        Assert.Equal(4, await db.TrafficDays.CountAsync(Cancel));
        Assert.DoesNotContain(await db.TrafficDimensionDays.Select(d => d.StartUnixMs).ToListAsync(Cancel), start => start < Wednesday - (30 * Day));
    }

    [Fact]
    public async Task Deleting_one_site_keeps_the_others_and_deleting_all_empties_everything()
    {
        await FlushAsync(Request(Wednesday + Hour, site: "app"), Request(Wednesday + Hour, site: "blog"));
        await _store.FlushAsync(new TrafficDelta(), [new TrafficCursorState("app", 10, "f", 1, null)], Cancel);

        await _store.DeleteAsync("app", Cancel);
        await using (var db = await _database.Contexts.CreateDbContextAsync(Cancel))
        {
            Assert.Empty(await db.TrafficDays.Where(d => d.SiteId == "app").ToListAsync(Cancel));
            Assert.NotEmpty(await db.TrafficDays.Where(d => d.SiteId == "blog").ToListAsync(Cancel));
            Assert.Single(await _store.CursorsAsync(Cancel));
        }

        await _store.DeleteAsync(null, Cancel);
        await using (var db = await _database.Contexts.CreateDbContextAsync(Cancel))
        {
            Assert.Equal(0, await db.TrafficDays.CountAsync(Cancel) + await db.TrafficHours.CountAsync(Cancel) + await db.TrafficDimensionDays.CountAsync(Cancel));
        }
    }

    [Fact]
    public async Task No_statistics_row_holds_the_visitors_address()
    {
        await FlushAsync(Request(Wednesday + Hour), Request(Wednesday + Hour, visitor: 2, agent: new UserAgentInfo("Other", 0, "Other", TrafficDevice.Bot, "curl")));

        await using var db = await _database.Contexts.CreateDbContextAsync(Cancel);
        var text = string.Join('\n', (await db.TrafficDimensionDays.ToListAsync(Cancel)).Select(d => d.Value));
        Assert.DoesNotContain("203.0.113.7", text, StringComparison.Ordinal);
        var bytes = (await db.TrafficDays.ToListAsync(Cancel)).SelectMany(d => d.Sketch).ToArray();
        Assert.False(System.Text.Encoding.ASCII.GetString(bytes).Contains("203.0.113.7", StringComparison.Ordinal));
        Assert.True(await _store.StorageBytesAsync(Cancel) > 0);
    }
}
