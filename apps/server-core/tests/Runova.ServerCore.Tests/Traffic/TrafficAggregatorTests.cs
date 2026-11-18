using Runova.ServerCore.Contracts;
using Runova.ServerCore.Traffic;

namespace Runova.ServerCore.Tests.Traffic;

/// <summary>
/// E109 T5 and AC1: lines in, hourly, daily and per-dimension deltas out, for the site and for all
/// sites together. A page view is a GET or HEAD answered 200 or 304 with HTML (or, on lines without
/// a content type, a path without a static file's extension); bots are counted apart and never in
/// the human figures; days follow the report's time zone.
/// </summary>
public sealed class TrafficAggregatorTests
{
    /// <summary>2026-11-18 10:00:00 UTC.</summary>
    private const long Ten = 1_794_996_000_000;

    private const long Hour = 3_600_000;

    private static readonly UserAgentInfo _firefox = new("Firefox", 133, "Windows", TrafficDevice.Desktop, null);

    private static readonly UserAgentInfo _phone = new("Safari", 18, "iOS", TrafficDevice.Mobile, null);

    private static readonly UserAgentInfo _googlebot = new("Other", 0, "Other", TrafficDevice.Bot, "Googlebot");

    private static TrafficRequest Request(
        long at = Ten,
        string path = "/",
        TrafficMethod method = TrafficMethod.Get,
        int status = 200,
        bool? html = true,
        UserAgentInfo? agent = null,
        ulong visitor = 1,
        string site = "app",
        string? referrer = null,
        string country = "DE",
        CountrySource source = CountrySource.DbIp,
        string? city = null,
        int responseMs = 20,
        long bytes = 1000) =>
        new(site, at, default, method, path, null, status, bytes, responseMs, html, referrer, "app.example.com", agent ?? _firefox, new GeoResult(country, source, city, null), visitor, false);

    private static TrafficAggregator Aggregator(TimeZoneInfo? zone = null) => new(zone ?? TimeZoneInfo.Utc);

    private static long Count(TrafficDelta delta, string site, TrafficDimension dimension, string value) =>
        delta.Dimensions.Where(d => d.Key.Site == site && d.Key.Dimension == dimension)
            .Sum(d => d.Value.Values.GetValueOrDefault(value));

    [Fact]
    public void A_page_view_counts_in_its_hour_and_day_for_the_site_and_for_all_sites()
    {
        var aggregator = Aggregator();

        aggregator.Add(Request(at: Ten + 60_000, path: "/blog", bytes: 5000));
        var delta = aggregator.TakeDelta(Ten + 120_000);

        foreach (var site in new[] { "app", TrafficSites.All })
        {
            var hour = delta.Hours[(site, Ten)];
            Assert.Equal((1, 1, 1, 5000), (hour.Requests, hour.PageViews, hour.Visits, hour.Bytes));
            Assert.Equal(1, hour.Status2xx);
            var day = delta.Days[(site, DateOnly.FromDateTime(new DateTime(2026, 11, 18)).DayNumber)];
            Assert.Equal((1, 1, 1), (day.Counters.Requests, day.Counters.PageViews, day.Counters.Visits));
            Assert.Equal(Ten - (10 * Hour), day.StartUnixMs);
            Assert.Equal(1, day.Sketch.Estimate());
            Assert.Equal(1, Count(delta, site, TrafficDimension.Page, "/blog"));
            Assert.Equal(1, Count(delta, site, TrafficDimension.EntryPage, "/blog"));
            Assert.Equal(1, Count(delta, site, TrafficDimension.Browser, "Firefox"));
            Assert.Equal(1, Count(delta, site, TrafficDimension.OperatingSystem, "Windows"));
            Assert.Equal(1, Count(delta, site, TrafficDimension.Device, "Desktop"));
            Assert.Equal(1, Count(delta, site, TrafficDimension.Country, "DE"));
            Assert.Equal(1, Count(delta, site, TrafficDimension.StatusCode, "200"));
            Assert.Equal(1, delta.HourVisitors[(site, Ten)]);
        }
    }

    [Fact]
    public void A_delta_is_taken_once()
    {
        var aggregator = Aggregator();
        aggregator.Add(Request());

        Assert.False(aggregator.TakeDelta(Ten).IsEmpty);
        Assert.True(aggregator.TakeDelta(Ten).IsEmpty);
    }

    [Fact]
    public void Bots_are_counted_apart_and_stay_out_of_the_human_figures()
    {
        var aggregator = Aggregator();

        aggregator.Add(Request(agent: _googlebot, path: "/about"));
        aggregator.Add(Request(agent: _googlebot, path: "/robots.txt", html: false, visitor: 9));
        var delta = aggregator.TakeDelta(Ten);

        var hour = delta.Hours[("app", Ten)];
        Assert.Equal((2, 2, 0, 0), (hour.Requests, hour.BotRequests, hour.PageViews, hour.Visits));
        Assert.Equal(2, Count(delta, "app", TrafficDimension.Bot, "Googlebot"));
        Assert.Equal(2, Count(delta, "app", TrafficDimension.StatusCode, "200"));
        Assert.Equal(0, Count(delta, "app", TrafficDimension.Page, "/about"));
        Assert.Equal(0, Count(delta, "app", TrafficDimension.Browser, "Other"));
        Assert.Equal(0, delta.Days.Single(d => d.Key.Site == "app").Value.Sketch.Estimate());
    }

    [Theory]
    [InlineData("GET", 200, "true", "/", true)]
    [InlineData("HEAD", 200, "true", "/", true)]
    [InlineData("GET", 304, "null", "/about", true)]
    [InlineData("GET", 304, "null", "/app.js", false)]
    [InlineData("GET", 200, "null", "/index.php", true)]
    [InlineData("GET", 200, "null", "/docs/guide.html", true)]
    [InlineData("GET", 200, "null", "/img/logo.png", false)]
    [InlineData("GET", 200, "false", "/", false)]
    [InlineData("POST", 200, "true", "/", false)]
    [InlineData("GET", 404, "true", "/missing", false)]
    [InlineData("GET", 301, "true", "/", false)]
    public void What_counts_as_a_page_view(string method, int status, string html, string path, bool counts)
    {
        var aggregator = Aggregator();

        aggregator.Add(Request(method: Enum.Parse<TrafficMethod>(method, ignoreCase: true), status: status, html: html == "null" ? null : bool.Parse(html), path: path));

        Assert.Equal(counts ? 1 : 0, aggregator.TakeDelta(Ten).Hours[("app", Ten)].PageViews);
    }

    [Fact]
    public void Days_follow_the_reports_time_zone()
    {
        var plusTwo = TimeZoneInfo.CreateCustomTimeZone("Test/PlusTwo", TimeSpan.FromHours(2), "Plus two", "Plus two");
        var aggregator = Aggregator(plusTwo);
        // 22:30 UTC on the 18th is 00:30 on the 19th two hours east.
        var late = Ten + (12 * Hour) + (30 * 60_000);

        aggregator.Add(Request(at: late));
        var delta = aggregator.TakeDelta(late);

        var day = Assert.Single(delta.Days, d => d.Key.Site == "app");
        Assert.Equal(DateOnly.FromDateTime(new DateTime(2026, 11, 19)).DayNumber, day.Key.Day);
        Assert.Equal(Ten + (12 * Hour), day.Value.StartUnixMs);
        Assert.Equal(Ten + (12 * Hour), Assert.Single(delta.Hours, h => h.Key.Site == "app").Key.HourUnixMs);
    }

    [Fact]
    public void A_visit_ends_after_thirty_quiet_minutes_with_its_length_and_without_a_bounce()
    {
        var aggregator = Aggregator();
        aggregator.Add(Request(at: Ten, path: "/"));
        aggregator.Add(Request(at: Ten + 120_000, path: "/pricing"));
        aggregator.Add(Request(at: Ten + 60_000, visitor: 2, path: "/blog"));
        var first = aggregator.TakeDelta(Ten + 180_000);

        var later = aggregator.TakeDelta(Ten + (40 * 60_000));

        Assert.Equal((2, 3), (first.Hours[("app", Ten)].Visits, first.Hours[("app", Ten)].PageViews));
        Assert.Equal(1, Count(first, "app", TrafficDimension.EntryPage, "/"));
        Assert.Equal(1, Count(first, "app", TrafficDimension.EntryPage, "/blog"));
        Assert.Equal(0, Count(first, "app", TrafficDimension.EntryPage, "/pricing"));
        var hour = later.Hours[("app", Ten)];
        Assert.Equal((1, 120, 0), (hour.Bounces, hour.VisitSeconds, hour.PageViews));
        Assert.Equal(1, later.Days.Single(d => d.Key.Site == TrafficSites.All).Value.Counters.Bounces);
    }

    [Fact]
    public void Referrers_count_other_sites_by_domain()
    {
        var aggregator = Aggregator();

        aggregator.Add(Request(referrer: "https://News.Example.org/top?id=4"));
        aggregator.Add(Request(referrer: "https://app.example.com/previous", visitor: 2));
        aggregator.Add(Request(referrer: "android-app://com.google.android.gm/", visitor: 3));
        var delta = aggregator.TakeDelta(Ten);

        Assert.Equal(1, Count(delta, "app", TrafficDimension.Referrer, "news.example.org"));
        Assert.Equal(1, Count(delta, "app", TrafficDimension.Referrer, "com.google.android.gm"));
        Assert.Equal(2, delta.Dimensions.Where(d => d.Key is { Site: "app", Dimension: TrafficDimension.Referrer }).Sum(d => d.Value.Values.Values.Sum()));
    }

    [Fact]
    public void Countries_and_cities_say_where_they_came_from()
    {
        var aggregator = Aggregator();

        aggregator.Add(Request(country: "DE", source: CountrySource.Cloudflare, city: "Berlin"));
        aggregator.Add(Request(country: "SE", source: CountrySource.DbIp, visitor: 2));
        aggregator.Add(Request(country: GeoCountry.Unknown, source: CountrySource.None, visitor: 3));
        var delta = aggregator.TakeDelta(Ten);

        var day = delta.Days.Single(d => d.Key.Site == "app").Value.Counters;
        Assert.Equal((1, 1, 1), (day.CountryCloudflare, day.CountryDbIp, day.CountryUnknown));
        Assert.Equal(1, Count(delta, "app", TrafficDimension.City, "Berlin, DE"));
        Assert.Equal(1, Count(delta, "app", TrafficDimension.Country, GeoCountry.Unknown));
    }

    [Fact]
    public void Status_classes_and_response_times_are_kept()
    {
        var aggregator = Aggregator();
        foreach (var (status, ms) in new[] { (200, 10), (204, 30), (301, 40), (404, 50), (500, 2000), (502, 90) })
        {
            aggregator.Add(Request(status: status, responseMs: ms));
        }

        var hour = aggregator.TakeDelta(Ten).Hours[("app", Ten)];

        Assert.Equal((2, 1, 1, 2), (hour.Status2xx, hour.Status3xx, hour.Status4xx, hour.Status5xx));
        Assert.Equal((2220, 6), (hour.ResponseMsTotal, hour.ResponseCount));
        Assert.Equal(6, hour.Histogram.Sum());
    }

    [Fact]
    public void A_dimension_keeps_its_most_common_values_and_folds_the_rest_into_other()
    {
        var aggregator = new TrafficAggregator(TimeZoneInfo.Utc, maxValues: 3);

        for (var i = 0; i < 5; i++)
        {
            aggregator.Add(Request(path: $"/page-{i}", visitor: (ulong)i));
        }

        var delta = aggregator.TakeDelta(Ten);

        var pages = delta.Dimensions.Single(d => d.Key is { Site: "app", Dimension: TrafficDimension.Page }).Value.Values;
        Assert.Equal(4, pages.Count);
        Assert.Equal(2, pages[TrafficSites.Other]);
    }

    [Fact]
    public void Long_values_are_clipped()
    {
        var aggregator = Aggregator();

        aggregator.Add(Request(path: "/" + new string('a', 1000)));

        var page = Assert.Single(aggregator.TakeDelta(Ten).Dimensions.Single(d => d.Key is { Site: "app", Dimension: TrafficDimension.Page }).Value.Values).Key;
        Assert.Equal(TrafficSites.MaxValueLength, page.Length);
    }

    [Fact]
    public void The_95th_percentile_comes_from_the_histogram()
    {
        var counts = new long[ResponseHistogram.Buckets];
        for (var i = 0; i < 95; i++)
        {
            ResponseHistogram.Add(counts, 8);
        }

        for (var i = 0; i < 5; i++)
        {
            ResponseHistogram.Add(counts, 4000);
        }

        Assert.InRange(ResponseHistogram.Percentile(counts, 0.95), 5, 10);
        Assert.InRange(ResponseHistogram.Percentile(counts, 0.99), 3000, 5000);
        Assert.Equal(0, ResponseHistogram.Percentile(new long[ResponseHistogram.Buckets], 0.95));
        Assert.Equal(counts, ResponseHistogram.Read(ResponseHistogram.Write(counts)));
        Assert.Equal(new long[ResponseHistogram.Buckets], ResponseHistogram.Read([1, 2]));
    }
}
