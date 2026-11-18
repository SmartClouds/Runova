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
/// E109 and E110: what is kept still ages out and blocks still expire while statistics and detection
/// are off, since nothing reads the logs then. Expired blocks are lifted every minute; statistics and
/// attack events past their retention go once a day.
/// </summary>
public sealed class TrafficMaintenanceTests : IAsyncLifetime
{
    private const long Day = 86_400_000;

    private readonly FakeTimeProvider _clock = new(DateTimeOffset.FromUnixTimeMilliseconds(1_794_996_000_000));

    private readonly NginxKit _kit = new();

    private readonly string _geoFolder = TestFolders.Create("maintenance-geo");

    private TestDatabase _database = null!;

    private AlertCenter _alerts = null!;

    private AddressBlocks _blocks = null!;

    private GeoDatabaseUpdater _geo = null!;

    private TrafficManager _manager = null!;

    private TrafficMaintenance _maintenance = null!;

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private long Now => _clock.GetUtcNow().ToUnixTimeMilliseconds();

    public async ValueTask InitializeAsync()
    {
        _database = await TestDatabase.CreateAsync();
        await _kit.SetUpAsync();
        var store = new TrafficStore(_database.Contexts, _clock);
        _alerts = new AlertCenter(_database.Contexts, _clock, new Redactor(), NullLogger<AlertCenter>.Instance);
        _blocks = new AddressBlocks(_database.Contexts, new BlockList(_kit.Control, _kit.Applier, NginxKit.Ubuntu, NullLogger<BlockList>.Instance), _clock, NullLogger<AddressBlocks>.Instance);
        _geo = new GeoDatabaseUpdater(new FakeGeoHttp(), _geoFolder, new GeoCountry(), _clock, NullLogger<GeoDatabaseUpdater>.Instance);
        _manager = new TrafficManager(_database.Contexts, store, _geo, _clock);
        var attacks = new AttackMonitor(_database.Contexts, _alerts, _blocks, new FixedAppAddresses(), _clock, NullLogger<AttackMonitor>.Instance);
        _maintenance = new TrafficMaintenance(_manager, store, attacks, _blocks, _clock, new TrafficOptions(), NullLogger<TrafficMaintenance>.Instance);
        await _manager.LoadAsync(Cancel);
    }

    public async ValueTask DisposeAsync()
    {
        _maintenance.Dispose();
        _manager.Dispose();
        _geo.Dispose();
        _blocks.Dispose();
        _alerts.Dispose();
        _kit.Dispose();
        TestFolders.Delete(_geoFolder);
        await _database.DisposeAsync();
    }

    private async Task SeedAsync()
    {
        await using var db = await _database.Contexts.CreateDbContextAsync(Cancel);
        db.TrafficHours.AddRange(new TrafficHour { SiteId = "app", HourUnixMs = Now - (100 * Day) }, new TrafficHour { SiteId = "app", HourUnixMs = Now - Day });
        db.TrafficDays.AddRange(new TrafficDay { SiteId = "app", Day = 1, StartUnixMs = Now - (800 * Day) }, new TrafficDay { SiteId = "app", Day = 2, StartUnixMs = Now - Day });
        db.TrafficDimensionDays.Add(new TrafficDimensionDay { SiteId = "app", Day = 1, StartUnixMs = Now - (800 * Day), Dimension = TrafficDimension.Page, Value = "/", Count = 1 });
        db.AttackEvents.AddRange(
            new AttackEvent { SiteId = "app", Kind = AttackKind.Scan, Address = "198.51.100.7", FirstSeenAt = Now - (40 * Day), LastSeenAt = Now - (40 * Day), Count = 20 },
            new AttackEvent { SiteId = "app", Kind = AttackKind.Scan, Address = "198.51.100.8", FirstSeenAt = Now - Day, LastSeenAt = Now - Day, Count = 20 });
        await db.SaveChangesAsync(Cancel);
    }

    [Fact]
    public async Task With_everything_off_old_statistics_and_attack_events_still_go()
    {
        Assert.False(_manager.Current.Tailing);
        await SeedAsync();

        await _maintenance.RunOnceAsync(Cancel);

        await using var db = await _database.Contexts.CreateDbContextAsync(Cancel);
        Assert.Equal(1, await db.TrafficHours.CountAsync(Cancel));
        Assert.Equal(1, await db.TrafficDays.CountAsync(Cancel));
        Assert.Equal(0, await db.TrafficDimensionDays.CountAsync(Cancel));
        Assert.Equal("198.51.100.8", (await db.AttackEvents.SingleAsync(Cancel)).Address);
    }

    [Fact]
    public async Task Statistics_age_out_once_a_day_not_every_minute()
    {
        await _maintenance.RunOnceAsync(Cancel);
        await SeedAsync();

        _clock.Advance(TimeSpan.FromMinutes(1));
        await _maintenance.RunOnceAsync(Cancel);
        await using (var db = await _database.Contexts.CreateDbContextAsync(Cancel))
        {
            Assert.Equal(2, await db.TrafficHours.CountAsync(Cancel));
        }

        _clock.Advance(TimeSpan.FromDays(1));
        await _maintenance.RunOnceAsync(Cancel);
        await using (var db = await _database.Contexts.CreateDbContextAsync(Cancel))
        {
            Assert.Equal(1, await db.TrafficHours.CountAsync(Cancel));
        }
    }

    [Fact]
    public async Task With_everything_off_an_expired_block_is_lifted_within_a_minute()
    {
        await _blocks.BlockAsync(new BlockAddressRequest("198.51.100.7", Minutes: 5), "maria", null, Cancel);
        await _maintenance.StartAsync(Cancel);
        try
        {
            await WaitAsync(() => _maintenance.Passes >= 1);
            _clock.Advance(TimeSpan.FromMinutes(6));
            await WaitAsync(() => _maintenance.Passes >= 2);

            Assert.Empty(await _blocks.ListAsync(Cancel));
            Assert.DoesNotContain("198.51.100.7", _kit.Machine.Text(_kit.Layout.BlockListFile), StringComparison.Ordinal);
            await using var db = await _database.Contexts.CreateDbContextAsync(Cancel);
            Assert.Empty(await db.BlockedAddresses.ToListAsync(Cancel));
        }
        finally
        {
            await _maintenance.StopAsync(Cancel);
        }
    }

    /// <summary>Waits for the background pass the fake clock let run; a generous limit, never a timing check.</summary>
    private static async Task WaitAsync(Func<bool> done)
    {
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(Cancel);
        limit.CancelAfter(TimeSpan.FromSeconds(30));
        while (!done())
        {
            await Task.Delay(10, limit.Token);
        }
    }
}
