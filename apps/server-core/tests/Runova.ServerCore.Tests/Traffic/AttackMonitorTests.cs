using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Alerts;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Security;
using Runova.ServerCore.Tests.Nginx;
using Runova.ServerCore.Traffic;

namespace Runova.ServerCore.Tests.Traffic;

/// <summary>
/// E110 T2, T4 and AC1: one open alert per site and kind, naming the top addresses with their
/// country and counts, Warning rising to Critical with volume, resolved after ten quiet minutes;
/// attack events written once a minute; auto-block for the kinds chosen, never an app's address.
/// </summary>
public sealed class AttackMonitorTests : IAsyncLifetime
{
    private readonly FakeTimeProvider _clock = new(DateTimeOffset.FromUnixTimeMilliseconds(1_794_996_000_000));

    private readonly NginxKit _kit = new();

    private readonly FixedAppAddresses _app = new();

    private TestDatabase _database = null!;

    private AlertCenter _alerts = null!;

    private AddressBlocks _blocks = null!;

    private AttackMonitor _monitor = null!;

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static readonly AttackThresholds _thresholds = new(20, 50, 5, 20, 5, 600, 5, 10);

    private long Now => _clock.GetUtcNow().ToUnixTimeMilliseconds();

    private static IpKey Key(string address) => IpKey.FromAddress(IPAddress.Parse(address));

    private static TrafficConfig Config(bool detection = true, AutoBlockSettings? autoBlock = null) => new(
        new TrafficSettings(false, true, [], 90, 730, "UTC"),
        new AttackSettings(detection, _thresholds, [], 30),
        autoBlock ?? new AutoBlockSettings(false, Enum.GetValues<AttackKind>(), 60, 1000),
        TimeZoneInfo.Utc,
        null,
        1);

    public async ValueTask InitializeAsync()
    {
        _database = await TestDatabase.CreateAsync();
        await _kit.SetUpAsync();
        _alerts = new AlertCenter(_database.Contexts, _clock, new Redactor(), NullLogger<AlertCenter>.Instance);
        _blocks = new AddressBlocks(_database.Contexts, new BlockList(_kit.Control, _kit.Applier, NginxKit.Ubuntu, NullLogger<BlockList>.Instance), _clock, NullLogger<AddressBlocks>.Instance);
        _monitor = new AttackMonitor(_database.Contexts, _alerts, _blocks, _app, _clock, NullLogger<AttackMonitor>.Instance);
    }

    public async ValueTask DisposeAsync()
    {
        _blocks.Dispose();
        _alerts.Dispose();
        _kit.Dispose();
        await _database.DisposeAsync();
    }

    private AttackHit Hit(string address = "198.51.100.7", AttackKind kind = AttackKind.Scan, int count = 1, string path = "/.env", string site = "app", bool siteWide = false, string? country = "DE") =>
        new(site, kind, Key(address), Now, path, country, count, siteWide);

    private void Record(params AttackHit[] hits) => _monitor.Record(hits, site => site + ".example.com");

    private async Task<AlertInfo[]> OpenAsync() => await _alerts.ListAsync(new AlertQuery(), Cancel);

    [Fact]
    public async Task A_scan_opens_one_warning_for_the_site_naming_the_address()
    {
        Record(Hit(count: 20));

        await _monitor.UpdateAsync(Config(), Cancel);

        var alert = Assert.Single(await OpenAsync());
        Assert.Equal((AlertKind.WebScan, "site:app", AlertSeverity.Warning), (alert.Kind, alert.Resource, alert.Severity));
        Assert.Contains("198.51.100.7 (DE)", alert.Message, StringComparison.Ordinal);
        Assert.Contains("app.example.com", alert.Message, StringComparison.Ordinal);
        Assert.Contains("20", alert.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task More_addresses_keep_one_alert_that_turns_critical_with_volume()
    {
        Record(Hit(count: 20));
        await _monitor.UpdateAsync(Config(), Cancel);
        _clock.Advance(TimeSpan.FromMinutes(2));

        Record([.. Enumerable.Range(1, 5).Select(i => Hit(address: $"192.0.2.{i}", count: 30, country: null))]);
        await _monitor.UpdateAsync(Config(), Cancel);

        var alert = Assert.Single(await OpenAsync());
        Assert.Equal(AlertSeverity.Critical, alert.Severity);
        Assert.Contains("6 addresses", alert.Message, StringComparison.Ordinal);
        Assert.Contains("and 3 more", alert.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Each_kind_and_site_has_its_own_alert()
    {
        Record(Hit(count: 20), Hit(kind: AttackKind.BruteForce, count: 20, path: "/wp-login.php"), Hit(site: "blog", count: 20), Hit(kind: AttackKind.Injection, count: 5), Hit(kind: AttackKind.Flood, count: 600));

        await _monitor.UpdateAsync(Config(), Cancel);

        Assert.Equal(
            [(AlertKind.WebScan, "site:app"), (AlertKind.WebScan, "site:blog"), (AlertKind.WebBruteForce, "site:app"), (AlertKind.WebFlood, "site:app"), (AlertKind.WebInjection, "site:app")],
            (await OpenAsync()).Select(a => (a.Kind, a.Resource)).Order());
    }

    [Fact]
    public async Task Ten_quiet_minutes_resolve_the_alert()
    {
        Record(Hit(count: 20));
        await _monitor.UpdateAsync(Config(), Cancel);
        _clock.Advance(TimeSpan.FromMinutes(9));
        Record(Hit());
        await _monitor.UpdateAsync(Config(), Cancel);
        _clock.Advance(TimeSpan.FromMinutes(9));
        await _monitor.UpdateAsync(Config(), Cancel);
        Assert.Single(await OpenAsync());

        _clock.Advance(TimeSpan.FromMinutes(1));
        await _monitor.UpdateAsync(Config(), Cancel);

        Assert.Empty(await OpenAsync());
    }

    [Fact]
    public async Task Turning_detection_off_resolves_what_is_open()
    {
        Record(Hit(count: 20));
        await _monitor.UpdateAsync(Config(), Cancel);

        await _monitor.UpdateAsync(Config(detection: false), Cancel);

        Assert.Empty(await OpenAsync());
    }

    [Fact]
    public async Task An_alert_open_before_a_restart_resolves_once_quiet()
    {
        await _alerts.RaiseAsync(AlertKind.WebFlood, "site:app", AlertSeverity.Warning, "old", Cancel);
        await _monitor.AssumeOpenAsync(Cancel);
        await _monitor.UpdateAsync(Config(), Cancel);
        Assert.Single(await OpenAsync());

        _clock.Advance(TimeSpan.FromMinutes(10));
        await _monitor.UpdateAsync(Config(), Cancel);

        Assert.Empty(await OpenAsync());
    }

    [Fact]
    public async Task Attack_events_are_written_and_carried_on()
    {
        Record(Hit(count: 20, path: "/.env"));
        await _monitor.FlushAsync(Cancel);
        _clock.Advance(TimeSpan.FromMinutes(1));
        Record([.. new[] { "/.git/config", "/.env", "/a", "/b", "/c", "/d" }.Select(path => Hit(path: path))]);
        await _monitor.FlushAsync(Cancel);

        await using var db = await _database.Contexts.CreateDbContextAsync(Cancel);
        var row = await db.AttackEvents.SingleAsync(Cancel);
        Assert.Equal(("app", AttackKind.Scan, "198.51.100.7", "DE", 26), (row.SiteId, row.Kind, row.Address, row.Country, row.Count));
        Assert.Equal(row.FirstSeenAt + 60_000, row.LastSeenAt);
        Assert.Equal(["/.env", "/.git/config", "/a", "/b", "/c"], TrafficMapper.ReadStrings(row.SamplePaths));
    }

    [Fact]
    public async Task Auto_block_blocks_the_kinds_chosen_but_never_an_apps_address_or_a_site_wide_flood()
    {
        _app.Addresses.Add(Key("203.0.113.50"));
        var autoBlock = new AutoBlockSettings(true, [AttackKind.Scan, AttackKind.Flood], 60, 1000);
        Record(
            Hit(count: 20),
            Hit(address: "203.0.113.50", count: 20),
            Hit(address: "192.0.2.9", kind: AttackKind.BruteForce, count: 20),
            Hit(address: "192.0.2.10", kind: AttackKind.Flood, siteWide: true));

        await _monitor.UpdateAsync(Config(autoBlock: autoBlock), Cancel);
        await _monitor.FlushAsync(Cancel);

        Assert.Equal(["198.51.100.7"], (await _blocks.ListAsync(Cancel)).Select(b => b.Network));
        await using var db = await _database.Contexts.CreateDbContextAsync(Cancel);
        Assert.True((await db.AttackEvents.SingleAsync(e => e.Address == "198.51.100.7", Cancel)).Blocked);
    }

    [Fact]
    public async Task Attacks_are_listed_newest_first_with_a_series_and_counts()
    {
        Record(Hit(count: 20), Hit(address: "192.0.2.1", kind: AttackKind.BruteForce, count: 20));
        await _monitor.FlushAsync(Cancel);
        _clock.Advance(TimeSpan.FromHours(2));
        Record(Hit(address: "192.0.2.2", kind: AttackKind.Injection, count: 5));
        await _monitor.FlushAsync(Cancel);
        await _blocks.BlockAsync(new BlockAddressRequest("192.0.2.2"), "maria", null, Cancel);

        var summary = await _monitor.ListAsync(new AttackQuery(null, Now - (3 * 3_600_000), Now + 1), Cancel);
        var week = await _monitor.ListAsync(new AttackQuery("app"), Cancel);

        Assert.Equal("192.0.2.2", summary.Events[0].Address);
        Assert.Equal((3, 1), (summary.Addresses, summary.Blocked));
        Assert.Equal(4, summary.Series.Length);
        Assert.Equal((1, 1, 0), (summary.Series[1].Scan, summary.Series[1].BruteForce, summary.Series[1].Injection));
        Assert.Equal(1, summary.Series[3].Injection);
        Assert.Equal(8, week.Series.Length);
        Assert.Equal(3, week.Events.Length);
    }

    [Fact]
    public async Task Old_attack_events_are_pruned()
    {
        Record(Hit(count: 20));
        await _monitor.FlushAsync(Cancel);
        _clock.Advance(TimeSpan.FromDays(31));

        Assert.Equal(1, await _monitor.PruneAsync(30, Cancel));
    }
}

/// <summary>The addresses apps are connected from, as a test sets them.</summary>
internal sealed class FixedAppAddresses : IAppAddresses
{
    public List<IpKey> Addresses { get; } = [];

    public Task<IReadOnlyList<IpKey>> CurrentAsync(CancellationToken cancellationToken) => Task.FromResult<IReadOnlyList<IpKey>>([.. Addresses]);

    public Task<IpKey?> OfAsync(Microsoft.AspNetCore.SignalR.HubCallerContext context, CancellationToken cancellationToken) =>
        Task.FromResult<IpKey?>(Addresses.Count > 0 ? Addresses[0] : null);
}
