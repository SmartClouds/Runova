using System.IO.Hashing;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Cloudflare;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Traffic;

/// <summary>Whether the tailer runs, and how much it reads. The test core turns it off and drives it by hand.</summary>
internal sealed record TrafficOptions(bool RunInBackground = true, long TickBudgetBytes = TrafficOptions.DefaultTickBudget, int ChunkBytes = TrafficOptions.DefaultChunk)
{
    public const long DefaultTickBudget = 8L * 1024 * 1024;

    public const int DefaultChunk = 256 * 1024;

    public static TrafficOptions Default { get; } = new();
}

/// <summary>
/// Reads every site's access log as nginx writes it (E109, E110), while statistics or detection is
/// on, and not at all otherwise. Every five seconds it reads what each log gained since its offset,
/// in chunks, under a budget a tick that spreads a backlog over several ticks. Lines go to the
/// aggregator (statistics), the detectors (attacks) and the live view. A line still being written
/// waits for its end. A log that shrank or whose first bytes changed was rotated: the old file is
/// finished from <c>.1</c> when its first bytes are the ones the cursor knew, then the new one is read
/// from its start. Once a minute the counts and the offsets they were read up to are written in one
/// transaction, so a restart continues where it stopped. When turned on, it starts at the end of the
/// logs, unless asked to read what they hold (up to <see cref="ReadExistingCap"/> a site).
/// </summary>
internal sealed partial class TrafficTailer(
    INginxMachine machine,
    IDbContextFactory<CoreDbContext> contexts,
    TrafficManager manager,
    TrafficStore store,
    GeoCountry geo,
    VisitorHasher visitors,
    AttackMonitor attacks,
    AddressBlocks blocks,
    TrafficLiveView live,
    OsInfo os,
    TimeProvider time,
    TrafficOptions options,
    ILogger<TrafficTailer> logger) : BackgroundService
{
    public const long ReadExistingCap = 200L * 1024 * 1024;

    public static readonly TimeSpan Every = TimeSpan.FromSeconds(5);

    public static readonly TimeSpan FlushEvery = TimeSpan.FromMinutes(1);

    public static readonly TimeSpan SitesEvery = TimeSpan.FromMinutes(1);

    /// <summary>How much of a file's start tells it apart from the file that replaces it.</summary>
    internal const int FingerprintBytes = 64;

    private readonly NginxLayout _layout = NginxControl.LayoutFor(os.Family, NginxInspection.Missing(false, true));
    private readonly UserAgentClassifier _agents = new();
    private readonly Dictionary<string, Cursor> _cursors = new(StringComparer.Ordinal);
    private readonly List<AttackHit> _hits = [];
    private readonly SemaphoreSlim _gate = new(1, 1);
    private TrafficConfig _config = manager.Current;
    private TrafficAggregator? _aggregator;
    private string? _zone;
    private AttackDetector? _detector;
    private int _detectorVersion = -1;
    private List<(string Id, string Name)> _sites = [];
    private int _sitesVersion = -1;
    private DateTimeOffset _sitesAt = DateTimeOffset.MinValue;
    private DateTimeOffset _lastFlush;
    private bool _loaded;
    private bool _wasTailing;
    private bool? _startAtEnd;
    private int _nextSite;
    private long _budget;
    private long _badLines;

    /// <summary>Lines that were not access log lines, skipped.</summary>
    public long BadLines => Interlocked.Read(ref _badLines);

    public override void Dispose()
    {
        _gate.Dispose();
        base.Dispose();
    }

    /// <summary>One pass over the logs: read, detect, alert. Writes only once a minute.</summary>
    public async Task TickAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            _config = manager.Current;
            if (!_config.Tailing)
            {
                if (_wasTailing)
                {
                    _wasTailing = false;
                    await FlushCoreAsync(cancellationToken);
                    await attacks.UpdateAsync(_config, cancellationToken);
                }

                return;
            }

            await PrepareAsync(cancellationToken);
            _budget = options.TickBudgetBytes;
            for (var i = 0; i < _sites.Count && _budget > 0; i++)
            {
                var site = _sites[(_nextSite + i) % _sites.Count];
                try
                {
                    await ReadSiteAsync(site.Id, cancellationToken);
                }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException)
                {
                    LogReadFailed(logger, site.Id, error);
                }
            }

            _nextSite = _sites.Count == 0 ? 0 : (_nextSite + 1) % _sites.Count;
            if (_hits.Count > 0)
            {
                var names = _sites.ToDictionary(s => s.Id, s => s.Name, StringComparer.Ordinal);
                attacks.Record(_hits, id => names.GetValueOrDefault(id) ?? id);
                _hits.Clear();
            }

            await attacks.UpdateAsync(_config, cancellationToken);
            if (time.GetUtcNow() - _lastFlush >= FlushEvery)
            {
                await FlushCoreAsync(cancellationToken);
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Writes the counts and offsets so far and the attack events. Retention is <see cref="TrafficMaintenance"/>'s.</summary>
    public async Task FlushAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await FlushCoreAsync(cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    public override async Task StartAsync(CancellationToken cancellationToken)
    {
        if (options.RunInBackground)
        {
            try
            {
                await manager.LoadAsync(cancellationToken);
                await attacks.AssumeOpenAsync(cancellationToken);
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                LogFailed(logger, error);
            }
        }

        await base.StartAsync(cancellationToken);
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        await base.StopAsync(cancellationToken);
        if (options.RunInBackground && _wasTailing)
        {
            try
            {
                await FlushAsync(cancellationToken);
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                LogFailed(logger, error);
            }
        }
    }

    /// <remarks>Paced in real time, as the metrics sampler is, so a test clock moved by hours replays nothing.</remarks>
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.RunInBackground)
        {
            return;
        }

        try
        {
            // blocked.conf from the database, in case the two drifted apart while the core was down.
            await blocks.SyncAsync(stoppingToken);
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            LogFailed(logger, error);
        }

        using var timer = new PeriodicTimer(Every, TimeProvider.System);
        do
        {
            try
            {
                await TickAsync(stoppingToken);
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                LogFailed(logger, error);
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    private async Task PrepareAsync(CancellationToken cancellationToken)
    {
        if (manager.TakeStart(out var readExisting, out var recorded))
        {
            // Turned on: forget where the logs were left. The save took their starting points, or
            // (reading what they hold, or without a machine to look) they are taken now.
            _cursors.Clear();
            _startAtEnd = recorded ? null : !readExisting;
            _loaded = true;
        }
        else if (!_loaded)
        {
            foreach (var saved in await store.CursorsAsync(cancellationToken))
            {
                _cursors[saved.SiteId] = new Cursor(saved.Offset, saved.Fingerprint, saved.FingerprintLength) { LastLineAt = saved.LastLineAt };
            }

            _loaded = true;
        }

        foreach (var taken in manager.TakeCursors())
        {
            _cursors[taken.SiteId] = new Cursor(taken.Offset, taken.Fingerprint, taken.FingerprintLength) { LastLineAt = taken.LastLineAt };
        }

        _wasTailing = true;
        if (_aggregator is null || _zone != _config.Zone.Id)
        {
            if (_aggregator is not null)
            {
                await FlushCoreAsync(cancellationToken);
            }

            _aggregator = new TrafficAggregator(_config.Zone);
            _zone = _config.Zone.Id;
        }

        if (_detector is null || _detectorVersion != _config.Version)
        {
            var allowlist = _config.Attacks.Allowlist.Select(text => IpNetwork.TryParse(text, out var network) ? network : (IpNetwork?)null).OfType<IpNetwork>();
            _detector = new AttackDetector(_config.Attacks.Thresholds, allowlist);
            _detectorVersion = _config.Version;
        }

        var now = time.GetUtcNow();
        if (_sitesVersion != _config.Version || now - _sitesAt >= SitesEvery)
        {
            await using var db = await contexts.CreateDbContextAsync(cancellationToken);
            var excluded = _config.Statistics.ExcludedSites.ToHashSet(StringComparer.Ordinal);
            _sites = [.. (await TrafficManager.SitesAsync(db, cancellationToken))
                .Where(site => !excluded.Contains(site.Id))
                .Select(site => (site.Id, site.Domains.FirstOrDefault() ?? site.Id))];
            if (OriginLockRows.Ranges(await db.OriginLock.AsNoTracking().FirstOrDefaultAsync(s => s.Id == OriginLockSetting.SingletonId, cancellationToken)) is { } ranges)
            {
                geo.TrustCloudflare(CloudflareRangeList.All(ranges));
            }

            _sitesVersion = _config.Version;
            _sitesAt = now;
        }

        if (_startAtEnd is { } atEnd)
        {
            foreach (var (id, _) in _sites)
            {
                if (!_cursors.ContainsKey(id))
                {
                    _cursors[id] = await StartAsync(_layout.AccessLog(id), atEnd, cancellationToken);
                }
            }

            _startAtEnd = null;
        }
    }

    /// <summary>Where a log is first read from: its end, or what it holds up to the cap, or its start when it is not there yet.</summary>
    private async Task<Cursor> StartAsync(string path, bool atEnd, CancellationToken cancellationToken)
    {
        if (await machine.LengthAsync(path, cancellationToken) is not { } length)
        {
            return new Cursor(0, string.Empty, 0) { Dirty = true };
        }

        var offset = atEnd ? length : Math.Max(0, length - ReadExistingCap);
        var cursor = new Cursor(offset, string.Empty, 0) { Align = offset > 0 && offset < length, Dirty = true };
        await CheckFileAsync(path, cursor, length, cancellationToken);
        return cursor;
    }

    private async Task ReadSiteAsync(string siteId, CancellationToken cancellationToken)
    {
        var path = _layout.AccessLog(siteId);
        if (await machine.LengthAsync(path, cancellationToken) is not { } length)
        {
            return;
        }

        if (!_cursors.TryGetValue(siteId, out var cursor))
        {
            // A site that came along after the logs were turned on: nginx made its log on the
            // reload that brought it, so all of it is new.
            cursor = new Cursor(0, string.Empty, 0) { Dirty = true };
            _cursors[siteId] = cursor;
        }

        if (length == cursor.Offset && cursor.FingerprintLength >= Math.Min(FingerprintBytes, length))
        {
            return;
        }

        if (length < cursor.Offset || !await CheckFileAsync(path, cursor, length, cancellationToken))
        {
            if (cursor.Offset > 0 && !await FinishRotatedAsync(siteId, path + ".1", cursor, cancellationToken))
            {
                return;
            }

            cursor.Restart();
            await CheckFileAsync(path, cursor, length, cancellationToken);
        }

        await ReadAsync(siteId, path, cursor, length, cancellationToken);
    }

    /// <summary>Reads the rest of the rotated file the cursor was in. False while the budget has not let it finish.</summary>
    private async Task<bool> FinishRotatedAsync(string siteId, string old, Cursor cursor, CancellationToken cancellationToken)
    {
        if (await machine.LengthAsync(old, cancellationToken) is not { } length || cursor.FingerprintLength == 0
            || !await CheckFileAsync(old, cursor, length, cancellationToken, update: false))
        {
            return true;
        }

        await ReadAsync(siteId, old, cursor, length, cancellationToken);
        return cursor.Offset >= length;
    }

    /// <summary>
    /// Whether the file starts with the bytes the cursor knows (a file shorter than that is another
    /// file). With <paramref name="update"/>, a fingerprint taken while the file was small is extended.
    /// </summary>
    private async Task<bool> CheckFileAsync(string path, Cursor cursor, long length, CancellationToken cancellationToken, bool update = true)
    {
        var wanted = (int)Math.Min(FingerprintBytes, length);
        if (wanted < cursor.FingerprintLength)
        {
            return false;
        }

        if (wanted == 0)
        {
            return true;
        }

        var head = await machine.ReadRangeAsync(path, 0, wanted, cancellationToken);
        if (head.Length < cursor.FingerprintLength)
        {
            return false;
        }

        if (cursor.FingerprintLength > 0 && Fingerprint(head.AsSpan(0, cursor.FingerprintLength)) != cursor.Fingerprint)
        {
            return false;
        }

        if (update && head.Length > cursor.FingerprintLength)
        {
            cursor.Fingerprint = Fingerprint(head);
            cursor.FingerprintLength = head.Length;
            cursor.Dirty = true;
        }

        return true;
    }

    private async Task ReadAsync(string siteId, string path, Cursor cursor, long length, CancellationToken cancellationToken)
    {
        while (cursor.Offset < length && _budget > 0)
        {
            var want = (int)Math.Min(options.ChunkBytes, Math.Min(length - cursor.Offset, _budget));
            var bytes = await machine.ReadRangeAsync(path, cursor.Offset, want, cancellationToken);
            if (bytes.Length == 0)
            {
                return;
            }

            _budget -= bytes.Length;
            var consumed = Lines(siteId, bytes, cursor);
            if (consumed == 0)
            {
                if (bytes.Length < options.ChunkBytes)
                {
                    // The rest of a line nginx is still writing, or the budget cut it: next time.
                    return;
                }

                // One line longer than a whole chunk is not an access log line.
                Interlocked.Increment(ref _badLines);
                consumed = bytes.Length;
            }

            cursor.Offset += consumed;
            cursor.Dirty = true;
            if (consumed < bytes.Length && cursor.Offset + (bytes.Length - consumed) >= length)
            {
                return;
            }
        }
    }

    /// <summary>Hands every whole line to the readers. Returns how many bytes that used up.</summary>
    private int Lines(string siteId, byte[] bytes, Cursor cursor)
    {
        var span = bytes.AsSpan();
        var start = 0;
        if (cursor.Align)
        {
            // Read from the middle of a file: its first piece is the end of a line.
            var first = span.IndexOf((byte)'\n');
            if (first < 0)
            {
                return 0;
            }

            start = first + 1;
            cursor.Align = false;
        }

        while (true)
        {
            var end = span[start..].IndexOf((byte)'\n');
            if (end < 0)
            {
                return start;
            }

            Process(siteId, span.Slice(start, end), cursor);
            start += end + 1;
        }
    }

    private void Process(string siteId, ReadOnlySpan<byte> text, Cursor cursor)
    {
        if (text.IsEmpty || text is [(byte)'\r'])
        {
            return;
        }

        if (!AccessLogParser.TryParse(text, out var line) || !IpKey.TryParse(line.RemoteAddress, out var address))
        {
            Interlocked.Increment(ref _badLines);
            return;
        }

        var target = line.Target;
        var question = target.IndexOf((byte)'?');
        var request = new TrafficRequest(
            siteId,
            line.TimeUnixMs,
            address,
            MethodOf(line.Method),
            AccessLogParser.Text(question < 0 ? target : target[..question]),
            question < 0 ? null : AccessLogParser.Text(target[(question + 1)..]),
            line.Status,
            line.BodyBytes,
            line.RequestTimeMs,
            !line.Extended || line.ContentType.IsEmpty ? null : IsHtml(line.ContentType),
            line.Referrer.IsEmpty ? null : AccessLogParser.Text(line.Referrer),
            line.Host.IsEmpty ? null : AccessLogParser.Text(line.Host),
            _agents.Classify(line.UserAgent),
            _config.Statistics.Countries ? geo.Locate(line, address) : default,
            visitors.Hash(line.RemoteAddress, line.UserAgent),
            line.UserAgent.IndexOf("${"u8) >= 0);
        cursor.LastLineAt = request.AtUnixMs;
        if (_config.Statistics.Enabled)
        {
            _aggregator!.Add(request);
        }

        if (_config.Attacks.Enabled)
        {
            _detector!.Observe(request, _hits);
        }

        live.Record(request);
    }

    private async Task FlushCoreAsync(CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        _lastFlush = now;
        try
        {
            var delta = _aggregator?.TakeDelta(now.ToUnixTimeMilliseconds()) ?? new TrafficDelta();
            var cursors = _cursors.Where(c => c.Value.Dirty)
                .Select(c => new TrafficCursorState(c.Key, c.Value.Offset, c.Value.Fingerprint, c.Value.FingerprintLength, c.Value.LastLineAt))
                .ToList();
            await store.FlushAsync(delta, cursors, cancellationToken);
            foreach (var cursor in _cursors.Values)
            {
                cursor.Dirty = false;
            }

            await attacks.FlushAsync(cancellationToken);
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            LogFlushFailed(logger, error);
        }
    }

    private static TrafficMethod MethodOf(ReadOnlySpan<byte> method) =>
        method.IsEmpty ? TrafficMethod.None
        : method.SequenceEqual("GET"u8) ? TrafficMethod.Get
        : method.SequenceEqual("HEAD"u8) ? TrafficMethod.Head
        : method.SequenceEqual("POST"u8) ? TrafficMethod.Post
        : TrafficMethod.Other;

    private static bool IsHtml(ReadOnlySpan<byte> contentType) =>
        contentType.StartsWith("text/html"u8) || contentType.StartsWith("application/xhtml"u8);

    internal static string Fingerprint(ReadOnlySpan<byte> head) => XxHash64.HashToUInt64(head).ToString("x16", System.Globalization.CultureInfo.InvariantCulture);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Reading the access log of site {SiteId} failed; it is tried again on the next tick.")]
    private static partial void LogReadFailed(ILogger logger, string siteId, Exception error);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Writing traffic statistics failed; the counts of the last minute are lost, the offsets stay as they were.")]
    private static partial void LogFlushFailed(ILogger logger, Exception error);

    [LoggerMessage(Level = LogLevel.Warning, Message = "The traffic tailer hit a problem; it carries on at the next tick.")]
    private static partial void LogFailed(ILogger logger, Exception error);

    /// <summary>How far one site's log has been read, and the file that was.</summary>
    private sealed class Cursor(long offset, string fingerprint, int fingerprintLength)
    {
        public long Offset { get; set; } = offset;

        public string Fingerprint { get; set; } = fingerprint;

        public int FingerprintLength { get; set; } = fingerprintLength;

        /// <summary>Started mid-file: skip to the next line's start.</summary>
        public bool Align { get; set; }

        public long? LastLineAt { get; set; }

        public bool Dirty { get; set; }

        /// <summary>A new file: from its start, its fingerprint taken as it grows.</summary>
        public void Restart()
        {
            Offset = 0;
            Fingerprint = string.Empty;
            FingerprintLength = 0;
            Align = false;
            Dirty = true;
        }
    }
}
