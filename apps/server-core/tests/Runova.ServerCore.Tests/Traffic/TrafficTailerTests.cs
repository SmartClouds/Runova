using System.Globalization;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Alerts;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Nginx;
using Runova.ServerCore.Security;
using Runova.ServerCore.Tests.Nginx;
using Runova.ServerCore.Traffic;

namespace Runova.ServerCore.Tests.Traffic;

/// <summary>
/// E109 T6, AC1, AC2 and AC3: the tailer reads what each site's log gained since its saved offset,
/// in chunks under a budget a tick; a line still being written waits; a rotated file is finished
/// from .1 before the new one starts, and a truncated one starts over, so no line is lost or counted
/// twice; a restart continues from the saved cursor; and with everything off it does not touch the
/// logs at all.
/// </summary>
public sealed class TrafficTailerTests : IAsyncLifetime
{
    private const string AppLog = "/var/log/nginx/runova-app.access.log";

    private const string BlogLog = "/var/log/nginx/runova-blog.access.log";

    private readonly FakeTimeProvider _clock = new(DateTimeOffset.FromUnixTimeMilliseconds(1_794_996_000_000));

    private readonly NginxKit _kit = new();

    private readonly string _geoFolder = TestFolders.Create("tailer-geo");

    private TestDatabase _database = null!;

    private CountingMachine _machine = null!;

    private TrafficManager _manager = null!;

    private TrafficStore _store = null!;

    private AlertCenter _alerts = null!;

    private AddressBlocks _blocks = null!;

    private GeoDatabaseUpdater _geo = null!;

    private TrafficLiveView _live = null!;

    private int _line;

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        _database = await TestDatabase.CreateAsync();
        await _kit.SetUpAsync();
        _machine = new CountingMachine(_kit.Machine);
        _store = new TrafficStore(_database.Contexts, _clock);
        _geo = new GeoDatabaseUpdater(new FakeGeoHttp(), _geoFolder, new GeoCountry(), _clock, NullLogger<GeoDatabaseUpdater>.Instance);
        _manager = new TrafficManager(_database.Contexts, _store, _geo, _clock, _kit.Machine, NginxKit.Ubuntu);
        _alerts = new AlertCenter(_database.Contexts, _clock, new Redactor(), NullLogger<AlertCenter>.Instance);
        _blocks = new AddressBlocks(_database.Contexts, new BlockList(_kit.Control, _kit.Applier, NginxKit.Ubuntu, NullLogger<BlockList>.Instance), _clock, NullLogger<AddressBlocks>.Instance);
        _live = new TrafficLiveView(_clock);
        await using var db = await _database.Contexts.CreateDbContextAsync(Cancel);
        db.Sites.AddRange(new Site { Id = "app", Settings = "{}" }, new Site { Id = "blog", Settings = "{}" });
        db.SiteDomains.AddRange(new SiteDomain { SiteId = "app", Domain = "app.example.com" }, new SiteDomain { SiteId = "blog", Domain = "blog.example.com" });
        await db.SaveChangesAsync(Cancel);
        await _manager.LoadAsync(Cancel);
    }

    public async ValueTask DisposeAsync()
    {
        _blocks.Dispose();
        _alerts.Dispose();
        _manager.Dispose();
        _geo.Dispose();
        _kit.Dispose();
        TestFolders.Delete(_geoFolder);
        await _database.DisposeAsync();
    }

    private TrafficTailer Tailer(TrafficOptions? options = null) => new(
        _machine,
        _database.Contexts,
        _manager,
        _store,
        new GeoCountry(),
        new VisitorHasher(new byte[32]),
        new AttackMonitor(_database.Contexts, _alerts, _blocks, new FixedAppAddresses(), _clock, NullLogger<AttackMonitor>.Instance),
        _blocks,
        _live,
        NginxKit.Ubuntu,
        _clock,
        options ?? new TrafficOptions(RunInBackground: false),
        NullLogger<TrafficTailer>.Instance);

    private string Line(string path = "/", string address = "198.51.100.4", int status = 200, string agent = "Mozilla/5.0 (X11; Linux x86_64) Firefox/133.0")
    {
        _line++;
        var at = _clock.GetUtcNow().ToString("dd/MMM/yyyy:HH:mm:ss +0000", CultureInfo.InvariantCulture);
        return $"{address} - - [{at}] \"GET {path} HTTP/1.1\" {status} 512 \"-\" \"{agent}\" \"app.example.com\" 0.004 \"text/html\" https {address} \"-\" \"-\" \"-\"\n";
    }

    private void Append(string log, string text) => _kit.Machine.AppendText(log, text);

    private void Append(string log, int lines, string path = "/")
    {
        var text = new StringBuilder();
        for (var i = 0; i < lines; i++)
        {
            text.Append(Line(path));
        }

        Append(log, text.ToString());
    }

    private async Task StatisticsOnAsync(bool readExisting = false, string[]? excluded = null) =>
        Assert.Empty((await _manager.SaveTrafficAsync(new TrafficSettings(true, false, excluded ?? [], 90, 730, "UTC", readExisting), "test", Cancel)).Problems);

    private async Task<long> RequestsAsync(string site = "app")
    {
        await using var db = await _database.Contexts.CreateDbContextAsync(Cancel);
        return await db.TrafficDays.Where(d => d.SiteId == site).SumAsync(d => d.Requests, Cancel);
    }

    private static async Task RunAsync(TrafficTailer tailer, int ticks = 1)
    {
        for (var i = 0; i < ticks; i++)
        {
            await tailer.TickAsync(Cancel);
        }

        await tailer.FlushAsync(Cancel);
    }

    [Fact]
    public async Task With_everything_off_the_logs_are_not_touched()
    {
        Append(AppLog, 5);
        var tailer = Tailer();
        _machine.Reset();

        await RunAsync(tailer, ticks: 3);

        Assert.Equal(0, _machine.Calls);
    }

    [Fact]
    public async Task Turning_on_starts_at_the_end_and_counts_what_comes_after()
    {
        Append(AppLog, 5);
        var tailer = Tailer();
        await StatisticsOnAsync();
        await RunAsync(tailer);

        Append(AppLog, 3);
        Append(BlogLog, 2);
        await RunAsync(tailer);

        Assert.Equal(3, await RequestsAsync());
        Assert.Equal(2, await RequestsAsync("blog"));
        Assert.Equal(5, await RequestsAsync(TrafficSites.All));
    }

    [Fact]
    public async Task Lines_written_right_after_turning_on_count_even_before_the_first_tick()
    {
        Append(AppLog, 5);
        var tailer = Tailer();

        await StatisticsOnAsync();
        Append(AppLog, 3);
        Append(BlogLog, 2);
        await RunAsync(tailer);

        Assert.Equal(3, await RequestsAsync());
        Assert.Equal(2, await RequestsAsync("blog"));
    }

    [Fact]
    public async Task A_site_created_after_turning_on_is_read_from_the_start_of_its_log()
    {
        var tailer = Tailer();
        await StatisticsOnAsync();
        await RunAsync(tailer);
        await using (var db = await _database.Contexts.CreateDbContextAsync(Cancel))
        {
            db.Sites.Add(new Site { Id = "shop", Settings = "{}" });
            await db.SaveChangesAsync(Cancel);
        }

        // nginx creates its log on the reload and visitors arrive before the tailer looks at the site.
        Append("/var/log/nginx/runova-shop.access.log", 4);
        _clock.Advance(TrafficTailer.SitesEvery);
        await RunAsync(tailer);

        Assert.Equal(4, await RequestsAsync("shop"));
    }

    [Fact]
    public async Task A_site_let_back_in_while_reading_starts_from_where_its_log_is_then()
    {
        var tailer = Tailer();
        await StatisticsOnAsync(excluded: ["blog"]);
        await RunAsync(tailer);
        Append(BlogLog, 5);

        await StatisticsOnAsync();
        Append(BlogLog, 2);
        await RunAsync(tailer);

        Assert.Equal(2, await RequestsAsync("blog"));
    }

    [Fact]
    public async Task Reading_what_the_logs_hold_counts_it_too()
    {
        Append(AppLog, 5);
        var tailer = Tailer();
        await StatisticsOnAsync(readExisting: true);

        await RunAsync(tailer);

        Assert.Equal(5, await RequestsAsync());
    }

    [Fact]
    public async Task A_line_still_being_written_waits_for_its_end()
    {
        var tailer = Tailer();
        await StatisticsOnAsync();
        await RunAsync(tailer);
        var line = Line("/half");

        Append(AppLog, line[..40]);
        await RunAsync(tailer);
        Assert.Equal(0, await RequestsAsync());

        Append(AppLog, line[40..]);
        await RunAsync(tailer);
        Assert.Equal(1, await RequestsAsync());
    }

    [Fact]
    public async Task A_restart_continues_from_the_saved_cursor()
    {
        var tailer = Tailer();
        await StatisticsOnAsync();
        await RunAsync(tailer);
        Append(AppLog, 2);
        await RunAsync(tailer);

        Append(AppLog, 4);
        var restarted = Tailer();
        await RunAsync(restarted);

        Assert.Equal(6, await RequestsAsync());
    }

    [Fact]
    public async Task A_rotated_log_is_finished_from_the_old_file_before_the_new_one_starts()
    {
        var tailer = Tailer();
        await StatisticsOnAsync();
        Append(AppLog, 1);
        await RunAsync(tailer);
        Append(AppLog, 2);
        await RunAsync(tailer);

        // These land in the old file after the last read, then logrotate moves it and nginx opens a new one.
        Append(AppLog, 3);
        await _kit.Machine.MoveAsync(AppLog, AppLog + ".1", Cancel);
        _clock.Advance(TimeSpan.FromSeconds(30));
        Append(AppLog, 4);
        await RunAsync(tailer);

        // The log was not there when statistics came on, so its first line counts too.
        Assert.Equal(10, await RequestsAsync());
    }

    [Fact]
    public async Task A_rotated_log_that_has_grown_past_the_old_offset_is_still_noticed()
    {
        var tailer = Tailer();
        await StatisticsOnAsync();
        Append(AppLog, 1);
        await RunAsync(tailer);
        Append(AppLog, 2);
        await RunAsync(tailer);

        await _kit.Machine.MoveAsync(AppLog, AppLog + ".1", Cancel);
        _clock.Advance(TimeSpan.FromSeconds(30));
        Append(AppLog, 10);
        await RunAsync(tailer);

        Assert.Equal(13, await RequestsAsync());
    }

    [Fact]
    public async Task A_truncated_log_starts_over()
    {
        var tailer = Tailer();
        await StatisticsOnAsync();
        await RunAsync(tailer);
        Append(AppLog, 3);
        await RunAsync(tailer);

        _kit.Machine.WriteText(AppLog, Line("/after"));
        await RunAsync(tailer);

        Assert.Equal(4, await RequestsAsync());
    }

    [Fact]
    public async Task A_big_backlog_is_read_a_budget_at_a_time()
    {
        var tailer = Tailer(new TrafficOptions(RunInBackground: false, TickBudgetBytes: 16 * 1024, ChunkBytes: 4 * 1024));
        await StatisticsOnAsync();
        await RunAsync(tailer);
        Append(AppLog, 400);
        var size = (await _kit.Machine.LengthAsync(AppLog, Cancel))!.Value;
        _machine.Reset();

        await tailer.TickAsync(Cancel);

        Assert.InRange(_machine.BytesRead, 12 * 1024, 16 * 1024 + 1024);
        Assert.All(_machine.ReadSizes, read => Assert.True(read <= 4 * 1024));
        for (var i = 0; i < (size / (12 * 1024)) + 2; i++)
        {
            await tailer.TickAsync(Cancel);
        }

        await tailer.FlushAsync(Cancel);
        Assert.Equal(400, await RequestsAsync());
    }

    [Fact]
    public async Task A_site_left_out_is_not_read()
    {
        var tailer = Tailer();
        await StatisticsOnAsync(excluded: ["blog"]);
        await RunAsync(tailer);
        _machine.Reset();

        Append(BlogLog, 3);
        await RunAsync(tailer);

        Assert.Equal(0, await RequestsAsync("blog"));
        Assert.DoesNotContain(BlogLog, _machine.Paths);
    }

    [Fact]
    public async Task Turning_everything_off_stops_every_read_and_on_again_continues()
    {
        var tailer = Tailer();
        await StatisticsOnAsync();
        await RunAsync(tailer);
        Append(AppLog, 2);
        await RunAsync(tailer);
        await _manager.SaveAttacksAsync(_manager.Current.Attacks with { Enabled = false }, "test", Cancel);
        await _manager.SaveTrafficAsync(_manager.Current.Statistics with { Enabled = false }, "test", Cancel);
        await RunAsync(tailer);
        _machine.Reset();

        Append(AppLog, 5);
        await RunAsync(tailer, ticks: 3);
        Assert.Equal(0, _machine.Calls);

        await StatisticsOnAsync();
        await RunAsync(tailer);
        Append(AppLog, 1);
        await RunAsync(tailer);
        Assert.Equal(3, await RequestsAsync());
    }

    [Fact]
    public async Task With_only_detection_on_the_lines_feed_the_detectors_and_nothing_is_counted()
    {
        await _manager.SaveAttacksAsync(_manager.Current.Attacks with { Enabled = true }, "test", Cancel);
        var tailer = Tailer();
        await RunAsync(tailer);

        var probes = new StringBuilder();
        for (var i = 0; i < 25; i++)
        {
            probes.Append(Line("/.env", address: "192.0.2.77", status: 404));
        }

        Append(AppLog, probes.ToString());
        await RunAsync(tailer);

        var alert = Assert.Single(await _alerts.ListAsync(new AlertQuery(), Cancel));
        Assert.Equal((AlertKind.WebScan, "site:app"), (alert.Kind, alert.Resource));
        Assert.Contains("192.0.2.77", alert.Message, StringComparison.Ordinal);
        Assert.Equal(0, await RequestsAsync());
        await using var db = await _database.Contexts.CreateDbContextAsync(Cancel);
        Assert.Equal(25, (await db.AttackEvents.SingleAsync(Cancel)).Count);
    }

    [Fact]
    public async Task Lines_show_in_the_live_view_and_bad_lines_are_skipped()
    {
        var tailer = Tailer();
        await StatisticsOnAsync();
        await RunAsync(tailer);

        Append(AppLog, "not a log line\n" + Line("/now") + "\n");
        await tailer.TickAsync(Cancel);

        var live = _live.Snapshot("app");
        Assert.Equal((1, 1), (live.VisitorsNow, live.RequestsLastMinute));
        Assert.Equal("/now", Assert.Single(live.PagesNow).Value);
        Assert.Equal(1, tailer.BadLines);
    }
}

/// <summary>A machine that counts every call and every byte read, so a test can tell the logs were not touched.</summary>
internal sealed class CountingMachine(INginxMachine inner) : INginxMachine
{
    private int _calls;

    public int Calls => _calls;

    public long BytesRead { get; private set; }

    public List<int> ReadSizes { get; } = [];

    public List<string> Paths { get; } = [];

    public void Reset()
    {
        _calls = 0;
        BytesRead = 0;
        ReadSizes.Clear();
        Paths.Clear();
    }

    public Task<string?> ReadTextAsync(string path, CancellationToken cancellationToken) => Count(path, inner.ReadTextAsync(path, cancellationToken));

    public Task WriteAsync(string path, ReadOnlyMemory<byte> content, UnixFileMode mode, CancellationToken cancellationToken) => Count(path, inner.WriteAsync(path, content, mode, cancellationToken));

    public Task<bool> ExistsAsync(string path, CancellationToken cancellationToken) => Count(path, inner.ExistsAsync(path, cancellationToken));

    public Task DeleteAsync(string path, CancellationToken cancellationToken) => Count(path, inner.DeleteAsync(path, cancellationToken));

    public Task CreateDirectoryAsync(string path, UnixFileMode mode, CancellationToken cancellationToken) => Count(path, inner.CreateDirectoryAsync(path, mode, cancellationToken));

    public Task<IReadOnlyList<string>> ListAsync(string path, CancellationToken cancellationToken) => Count(path, inner.ListAsync(path, cancellationToken));

    public Task<string?> ReadLinkAsync(string path, CancellationToken cancellationToken) => Count(path, inner.ReadLinkAsync(path, cancellationToken));

    public Task ReplaceLinkAsync(string path, string target, CancellationToken cancellationToken) => Count(path, inner.ReplaceLinkAsync(path, target, cancellationToken));

    public Task MoveAsync(string from, string to, CancellationToken cancellationToken) => Count(from, inner.MoveAsync(from, to, cancellationToken));

    public Task<long?> LengthAsync(string path, CancellationToken cancellationToken) => Count(path, inner.LengthAsync(path, cancellationToken));

    public async Task<byte[]> ReadRangeAsync(string path, long offset, int maxBytes, CancellationToken cancellationToken)
    {
        var bytes = await Count(path, inner.ReadRangeAsync(path, offset, maxBytes, cancellationToken));
        BytesRead += bytes.Length;
        ReadSizes.Add(bytes.Length);
        return bytes;
    }

    public Task<ProcessResult> RunAsync(ProcessSpec spec, CancellationToken cancellationToken) => Count(spec.Program, inner.RunAsync(spec, cancellationToken));

    public Task<ProcessResult> RunInUnitAsync(JobContext job, string step, string description, ProcessSpec spec, CancellationToken cancellationToken) =>
        Count(spec.Program, inner.RunInUnitAsync(job, step, description, spec, cancellationToken));

    private T Count<T>(string path, T task)
    {
        Interlocked.Increment(ref _calls);
        lock (Paths)
        {
            Paths.Add(path);
        }

        return task;
    }
}
