using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Traffic;

namespace Runova.ServerCore.Tests.Traffic;

/// <summary>
/// E109 T7 and E110 T5: the settings for statistics, detection and auto-block, checked with problems
/// in plain words, the defaults (all off until statistics are first turned on, which turns detection
/// on too unless someone chose otherwise), and the status of every site.
/// </summary>
public sealed class TrafficManagerTests : IAsyncLifetime
{
    private readonly FakeTimeProvider _clock = new(DateTimeOffset.FromUnixTimeMilliseconds(1_794_996_000_000));

    private readonly string _geoFolder = TestFolders.Create("traffic-geo");

    private TestDatabase _database = null!;

    private TrafficManager _manager = null!;

    private GeoDatabaseUpdater _geo = null!;

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static TrafficSettings On => new(true, true, [], 90, 730, "UTC");

    public async ValueTask InitializeAsync()
    {
        _database = await TestDatabase.CreateAsync();
        _geo = new GeoDatabaseUpdater(new FakeGeoHttp(), _geoFolder, new GeoCountry(), _clock, NullLogger<GeoDatabaseUpdater>.Instance);
        _manager = new TrafficManager(_database.Contexts, new TrafficStore(_database.Contexts, _clock), _geo, _clock);
        await using var db = await _database.Contexts.CreateDbContextAsync(Cancel);
        db.Sites.AddRange(
            new Site { Id = "app", Settings = "{}" },
            new Site { Id = "blog", Settings = "{}", LocationSnippet = "location = /health {\n    access_log off;\n    return 200;\n}\n" },
            new Site { Id = CoreDomain.CoreDomainSettings.SiteId, Settings = "{}" });
        db.SiteDomains.AddRange(
            new SiteDomain { SiteId = "app", Domain = "www.app.example.com", Position = 1 },
            new SiteDomain { SiteId = "app", Domain = "app.example.com", Position = 0 },
            new SiteDomain { SiteId = "blog", Domain = "blog.example.com", Position = 0 });
        await db.SaveChangesAsync(Cancel);
        await _manager.LoadAsync(Cancel);
    }

    public async ValueTask DisposeAsync()
    {
        _geo.Dispose();
        TestFolders.Delete(_geoFolder);
        await _database.DisposeAsync();
    }

    [Fact]
    public async Task Everything_is_off_until_someone_turns_it_on_with_sensible_defaults()
    {
        var status = await _manager.StatusAsync(Cancel);

        Assert.False(status.Settings.Enabled);
        Assert.True(status.Settings.Countries);
        Assert.Equal((90, 730), (status.Settings.HourlyRetentionDays, status.Settings.DailyRetentionDays));
        Assert.Equal(status.DefaultTimeZone, status.Settings.TimeZone);
        Assert.False(string.IsNullOrEmpty(status.DefaultTimeZone));
        Assert.False(status.Attacks.Enabled);
        Assert.Equal(new AttackThresholds(20, 50, 5, 20, 5, 600, 5, 10), status.Attacks.Thresholds);
        Assert.Equal(30, status.Attacks.EventRetentionDays);
        Assert.Equal((false, 60, 1000), (status.AutoBlock.Enabled, status.AutoBlock.Minutes, status.AutoBlock.MaxBlocked));
        Assert.Equal(Enum.GetValues<AttackKind>(), status.AutoBlock.Kinds);
        Assert.False(_manager.Current.Tailing);
        Assert.Null(status.CollectingSinceUnixMs);
    }

    [Fact]
    public async Task Turning_statistics_on_turns_detection_on_and_asks_the_tailer_to_start()
    {
        var result = await _manager.SaveTrafficAsync(On with { ReadExistingLogs = true }, "maria", Cancel);

        Assert.Empty(result.Problems);
        Assert.True(result.Status!.Settings.Enabled);
        Assert.True(result.Status.Attacks.Enabled);
        Assert.Equal(_clock.GetUtcNow().ToUnixTimeMilliseconds(), result.Status.CollectingSinceUnixMs);
        Assert.Equal("maria", result.Status.ChangedBy);
        Assert.True(_manager.Current.Tailing);
        Assert.True(_manager.TakeStart(out var readExisting));
        Assert.True(readExisting);
        Assert.False(_manager.TakeStart(out _));
    }

    [Fact]
    public async Task With_detection_reading_the_logs_already_statistics_join_in_without_a_new_start()
    {
        await _manager.SaveAttacksAsync(_manager.Current.Attacks with { Enabled = true }, "maria", Cancel);
        Assert.True(_manager.TakeStart(out _));

        await _manager.SaveTrafficAsync(On with { ReadExistingLogs = true }, "maria", Cancel);

        Assert.False(_manager.TakeStart(out _));
    }

    [Fact]
    public async Task Detection_someone_turned_off_stays_off()
    {
        var defaults = (await _manager.StatusAsync(Cancel)).Attacks;
        await _manager.SaveAttacksAsync(defaults with { Enabled = false }, "maria", Cancel);

        await _manager.SaveTrafficAsync(On, "maria", Cancel);

        Assert.False(_manager.Current.Attacks.Enabled);
        Assert.True(_manager.Current.Tailing);
    }

    [Fact]
    public async Task Reading_what_the_logs_hold_only_counts_the_first_time()
    {
        await _manager.SaveTrafficAsync(On, "maria", Cancel);
        await _manager.SaveAttacksAsync(_manager.Current.Attacks with { Enabled = false }, "maria", Cancel);
        await _manager.SaveTrafficAsync(On with { Enabled = false }, "maria", Cancel);
        _manager.TakeStart(out _);
        Assert.False(_manager.Current.Tailing);

        await _manager.SaveTrafficAsync(On with { ReadExistingLogs = true }, "maria", Cancel);

        Assert.True(_manager.TakeStart(out var readExisting));
        Assert.False(readExisting);
    }

    [Theory]
    [InlineData(6, 730, "UTC", "hourly")]
    [InlineData(366, 730, "UTC", "hourly")]
    [InlineData(90, 29, "UTC", "daily")]
    [InlineData(90, 1826, "UTC", "daily")]
    [InlineData(90, 730, "Mars/Olympus_Mons", "time zone")]
    [InlineData(90, 730, "", "time zone")]
    public async Task Statistics_settings_out_of_range_are_refused_in_plain_words(int hourly, int daily, string zone, string words)
    {
        var result = await _manager.SaveTrafficAsync(new TrafficSettings(true, true, [], hourly, daily, zone), "maria", Cancel);

        Assert.Contains(result.Problems, problem => problem.Contains(words, StringComparison.OrdinalIgnoreCase));
        Assert.Null(result.Status);
        Assert.False(_manager.Current.Statistics.Enabled);
    }

    [Fact]
    public async Task A_site_left_out_must_exist()
    {
        var result = await _manager.SaveTrafficAsync(On with { ExcludedSites = ["app", "nope"] }, "maria", Cancel);

        Assert.Equal(["There is no site called nope to leave out."], result.Problems);
    }

    [Theory]
    [InlineData(2, 50, 5, 20, 5, 600, 5, 10, "probe")]
    [InlineData(20, 50, 0, 20, 5, 600, 5, 10, "window")]
    [InlineData(20, 50, 5, 1, 5, 600, 5, 10, "sign-in")]
    [InlineData(20, 50, 5, 20, 61, 600, 5, 10, "window")]
    [InlineData(20, 50, 5, 20, 5, 10, 5, 10, "flood")]
    [InlineData(20, 50, 5, 20, 5, 600, 0, 10, "injection")]
    public async Task Thresholds_that_make_no_sense_are_refused(int probes, int notFound, int scanWindow, int attempts, int bruteWindow, int flood, int injections, int injectionWindow, string words)
    {
        var defaults = (await _manager.StatusAsync(Cancel)).Attacks;

        var result = await _manager.SaveAttacksAsync(defaults with { Thresholds = new AttackThresholds(probes, notFound, scanWindow, attempts, bruteWindow, flood, injections, injectionWindow) }, "maria", Cancel);

        Assert.Contains(result.Problems, problem => problem.Contains(words, StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task The_allowlist_takes_addresses_and_networks_only()
    {
        var defaults = (await _manager.StatusAsync(Cancel)).Attacks;

        var refused = await _manager.SaveAttacksAsync(defaults with { Allowlist = ["203.0.113.0/24", "example.com"] }, "maria", Cancel);
        var saved = await _manager.SaveAttacksAsync(defaults with { Allowlist = [" 203.0.113.0/24 ", "2001:db8::1"], EventRetentionDays = 60 }, "maria", Cancel);

        Assert.Single(refused.Problems);
        Assert.Contains("example.com", refused.Problems[0], StringComparison.Ordinal);
        Assert.Empty(saved.Problems);
        Assert.Equal(["203.0.113.0/24", "2001:db8::1"], saved.Status!.Attacks.Allowlist);
        Assert.Equal(60, _manager.Current.Attacks.EventRetentionDays);
    }

    [Theory]
    [InlineData(-1, 1000, "minutes")]
    [InlineData(60, 0, "at once")]
    [InlineData(60, 100_001, "at once")]
    public async Task Auto_block_settings_are_checked(int minutes, int max, string words)
    {
        var result = await _manager.SaveAutoBlockAsync(new AutoBlockSettings(true, [AttackKind.Scan], minutes, max), "olga", Cancel);

        Assert.Contains(result.Problems, problem => problem.Contains(words, StringComparison.OrdinalIgnoreCase));
        Assert.False(_manager.Current.AutoBlock.Enabled);
    }

    [Fact]
    public async Task Auto_block_saves_its_kinds()
    {
        var result = await _manager.SaveAutoBlockAsync(new AutoBlockSettings(true, [AttackKind.BruteForce, AttackKind.Scan], 0, 200), "olga", Cancel);

        Assert.Empty(result.Problems);
        Assert.Equal([AttackKind.Scan, AttackKind.BruteForce], _manager.Current.AutoBlock.Kinds);
        Assert.Equal(0, _manager.Current.AutoBlock.Minutes);
    }

    [Fact]
    public async Task The_status_lists_each_site_with_its_domains_and_whether_it_logs()
    {
        await _manager.SaveTrafficAsync(On with { ExcludedSites = ["blog"] }, "maria", Cancel);
        await using (var db = await _database.Contexts.CreateDbContextAsync(Cancel))
        {
            db.TrafficLogCursors.Add(new TrafficLogCursor { SiteId = "app", Offset = 10, LastLineAt = 1234 });
            await db.SaveChangesAsync(Cancel);
        }

        var status = await _manager.StatusAsync(Cancel);

        Assert.Equal(["app", "blog"], status.Sites.Select(s => s.SiteId));
        var app = status.Sites[0];
        Assert.Equal((false, false, 1234L), (app.Excluded, app.LoggingOff, app.LastLineAtUnixMs));
        Assert.Equal(["app.example.com", "www.app.example.com"], app.Domains);
        Assert.Equal((true, true), (status.Sites[1].Excluded, status.Sites[1].LoggingOff));
        Assert.False(status.GeoDatabaseReady);
    }

    [Fact]
    public async Task Deleting_statistics_empties_them()
    {
        await using (var db = await _database.Contexts.CreateDbContextAsync(Cancel))
        {
            db.TrafficDays.Add(new TrafficDay { SiteId = "app", Day = 1, StartUnixMs = 1 });
            await db.SaveChangesAsync(Cancel);
        }

        await _manager.DeleteAsync(null, Cancel);

        await using var check = await _database.Contexts.CreateDbContextAsync(Cancel);
        Assert.Empty(await check.TrafficDays.ToListAsync(Cancel));
    }

    [Fact]
    public async Task Settings_survive_a_restart()
    {
        await _manager.SaveTrafficAsync(On with { HourlyRetentionDays = 30 }, "maria", Cancel);
        var again = new TrafficManager(_database.Contexts, new TrafficStore(_database.Contexts, _clock), _geo, _clock);

        await again.LoadAsync(Cancel);

        Assert.Equal(30, again.Current.Statistics.HourlyRetentionDays);
        Assert.True(again.Current.Tailing);
        Assert.False(again.TakeStart(out _));
    }
}
