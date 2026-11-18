using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Traffic;

/// <summary>The settings in use, as the tailer reads them on every tick. Version moves on every save.</summary>
internal sealed record TrafficConfig(TrafficSettings Statistics, AttackSettings Attacks, AutoBlockSettings AutoBlock, TimeZoneInfo Zone, long? EnabledAt, int Version)
{
    /// <summary>The logs are read while statistics or detection is on, and not at all otherwise.</summary>
    public bool Tailing => Statistics.Enabled || Attacks.Enabled;
}

/// <summary>
/// Statistics, detection and auto-block settings (E109, E110): saved in one row, checked first with
/// the problems in plain words, and in effect at once. Everything starts off. The first time
/// statistics are turned on, detection comes on with them unless someone set detection themselves;
/// detection can also run on its own. Statistics start at the end of the logs, unless the person asks
/// to read what the logs already hold, which only the first time makes sense (a later start would
/// count lines twice).
/// </summary>
internal sealed class TrafficManager(IDbContextFactory<CoreDbContext> contexts, TrafficStore store, GeoDatabaseUpdater geo, TimeProvider time, INginxMachine? machine = null, OsInfo? os = null) : IDisposable
{
    public const int MinHourlyDays = 7;
    public const int MaxHourlyDays = 365;
    public const int MinDailyDays = 30;
    public const int MaxDailyDays = 1825;
    public const int MinEventDays = 7;
    public const int MaxEventDays = 365;
    public const int MaxAllowlist = 1000;
    public const int MaxBlockMinutes = 525_600;
    public const int MaxBlockedAtOnce = 100_000;

    private readonly SemaphoreSlim _gate = new(1, 1);

    /// <summary>Where the sites' logs are, to take their starting points as the logs are turned on.</summary>
    private readonly (INginxMachine Machine, NginxLayout Layout)? _logs =
        machine is null ? null : (machine, NginxControl.LayoutFor(os?.Family ?? OsFamily.Debian, NginxInspection.Missing(false, true)));
    private readonly Lock _startGate = new();
    private volatile TrafficConfig _current = Configure(Defaults(), version: 0);
    private (bool ReadExisting, bool Recorded)? _start;
    private readonly Dictionary<string, TrafficCursorState> _pendingCursors = new(StringComparer.Ordinal);
    private volatile bool _loaded;

    public TrafficConfig Current => _current;

    public void Dispose() => _gate.Dispose();

    /// <summary>The server's own time zone by its IANA name, which new settings start with; UTC when it has none.</summary>
    public static string ServerTimeZone()
    {
        var local = TimeZoneInfo.Local;
        if (local.HasIanaId)
        {
            return local.Id;
        }

        return TimeZoneInfo.TryConvertWindowsIdToIanaId(local.Id, out var iana) ? iana : "UTC";
    }

    public static TimeZoneInfo ZoneOf(string? name) =>
        !string.IsNullOrWhiteSpace(name) && TimeZoneInfo.TryFindSystemTimeZoneById(name, out var zone) ? zone : TimeZoneInfo.Utc;

    /// <summary>Loads the settings once, for a caller that may come before the tailer has started.</summary>
    public async Task EnsureLoadedAsync(CancellationToken cancellationToken)
    {
        if (!_loaded)
        {
            await LoadAsync(cancellationToken);
        }
    }

    public async Task LoadAsync(CancellationToken cancellationToken)
    {
        _loaded = true;
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var row = await db.TrafficSettings.AsNoTracking().FirstOrDefaultAsync(s => s.Id == TrafficSetting.SingletonId, cancellationToken) ?? Defaults();
        _current = Configure(row, _current.Version + 1);
    }

    /// <summary>Whether a save has just turned the logs on, and whether to read what they already hold. Once per save.</summary>
    public bool TakeStart(out bool readExisting) => TakeStart(out readExisting, out _);

    /// <param name="recorded">The save took every log's starting point itself (<see cref="TakeCursors"/>).</param>
    public bool TakeStart(out bool readExisting, out bool recorded)
    {
        lock (_startGate)
        {
            readExisting = _start?.ReadExisting ?? false;
            recorded = _start?.Recorded ?? false;
            var started = _start is not null;
            _start = null;
            return started;
        }
    }

    /// <summary>Starting points a save took for logs the tailer is to read from now on. Once each.</summary>
    public IReadOnlyList<TrafficCursorState> TakeCursors()
    {
        lock (_startGate)
        {
            var cursors = _pendingCursors.Values.ToList();
            _pendingCursors.Clear();
            return cursors;
        }
    }

    public async Task<TrafficStatus> StatusAsync(CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var row = await db.TrafficSettings.AsNoTracking().FirstOrDefaultAsync(s => s.Id == TrafficSetting.SingletonId, cancellationToken) ?? Defaults();
        var excluded = TrafficMapper.ReadStrings(row.ExcludedSites).ToHashSet(StringComparer.Ordinal);
        var cursors = await db.TrafficLogCursors.AsNoTracking().ToDictionaryAsync(c => c.SiteId, c => c.LastLineAt, StringComparer.Ordinal, cancellationToken);
        var sites = (await SitesAsync(db, cancellationToken))
            .Select(site => new TrafficSiteStatus(site.Id, site.Domains, excluded.Contains(site.Id), site.LoggingOff, cursors.GetValueOrDefault(site.Id)))
            .ToArray();
        var geoState = geo.State;
        return TrafficMapper.ToStatus(row, sites, geoState.Ready, await store.StorageBytesAsync(cancellationToken), ServerTimeZone(), geoState.UpdatedAtUnixMs, geoState.Problem);
    }

    public async Task<TrafficSaveResult> SaveTrafficAsync(TrafficSettings settings, string by, CancellationToken cancellationToken)
    {
        if (settings is null)
        {
            return new TrafficSaveResult(["The settings are missing."]);
        }

        var excluded = (settings.ExcludedSites ?? []).Where(id => !string.IsNullOrWhiteSpace(id)).Select(id => id.Trim()).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
        var problems = new List<string>();
        if (settings.HourlyRetentionDays is < MinHourlyDays or > MaxHourlyDays)
        {
            problems.Add($"Keep hourly figures for {MinHourlyDays} to {MaxHourlyDays} days.");
        }

        if (settings.DailyRetentionDays is < MinDailyDays or > MaxDailyDays)
        {
            problems.Add($"Keep daily figures for {MinDailyDays} to {MaxDailyDays} days (five years).");
        }

        var zone = settings.TimeZone?.Trim() ?? string.Empty;
        if (zone.Length is 0 or > 64 || !TimeZoneInfo.TryFindSystemTimeZoneById(zone, out _))
        {
            problems.Add($"'{zone}' is not a time zone this server knows. Use a name such as Europe/Berlin or UTC.");
        }

        var readExisting = false;
        return await SaveAsync(
            async (db, row) =>
            {
                var known = (await SitesAsync(db, cancellationToken)).Select(site => site.Id).ToHashSet(StringComparer.Ordinal);
                problems.AddRange(excluded.Where(id => !known.Contains(id)).Select(id => $"There is no site called {id} to leave out."));
                if (problems.Count > 0)
                {
                    return problems;
                }

                var turningOn = settings.Enabled && !row.Enabled;
                readExisting = turningOn && row.EnabledAt is null && settings.ReadExistingLogs;
                TrafficMapper.Apply(settings with { ExcludedSites = excluded, TimeZone = zone }, row);
                if (turningOn)
                {
                    row.EnabledAt = time.GetUtcNow().ToUnixTimeMilliseconds();
                    if (!row.DetectionChosen)
                    {
                        row.AttackEnabled = true;
                    }
                }

                return problems;
            },
            by,
            cancellationToken,
            () => readExisting);
    }

    public Task<TrafficSaveResult> SaveAttacksAsync(AttackSettings settings, string by, CancellationToken cancellationToken)
    {
        if (settings?.Thresholds is not { } thresholds)
        {
            return Task.FromResult(new TrafficSaveResult(["The settings are missing."]));
        }

        var problems = new List<string>();
        Range(problems, thresholds.ScanProbes, 3, 10_000, "A scan needs 3 to 10,000 probe requests.");
        Range(problems, thresholds.ScanNotFound, 5, 100_000, "A scan needs 5 to 100,000 pages not found.");
        Range(problems, thresholds.ScanWindowMinutes, 1, 60, "The scan window is 1 to 60 minutes.");
        Range(problems, thresholds.BruteForceAttempts, 3, 10_000, "Brute force needs 3 to 10,000 sign-in attempts.");
        Range(problems, thresholds.BruteForceWindowMinutes, 1, 60, "The brute force window is 1 to 60 minutes.");
        Range(problems, thresholds.FloodRequestsPerMinute, 60, 1_000_000, "A flood is 60 to 1,000,000 requests a minute from one address.");
        Range(problems, thresholds.InjectionHits, 1, 10_000, "Injection needs 1 to 10,000 probes.");
        Range(problems, thresholds.InjectionWindowMinutes, 1, 60, "The injection window is 1 to 60 minutes.");
        Range(problems, settings.EventRetentionDays, MinEventDays, MaxEventDays, $"Keep attacks for {MinEventDays} to {MaxEventDays} days.");
        var allowlist = new List<string>();
        foreach (var entry in (settings.Allowlist ?? []).Where(entry => !string.IsNullOrWhiteSpace(entry)).Select(entry => entry.Trim()))
        {
            if (NginxAddresses.TryParseNetwork(entry, out var canonical, out _))
            {
                allowlist.Add(canonical);
            }
            else
            {
                problems.Add($"'{entry}' in the allowlist is not an address or a network like 203.0.113.0/24.");
            }
        }

        if (allowlist.Count > MaxAllowlist)
        {
            problems.Add($"The allowlist holds at most {MaxAllowlist} entries.");
        }

        return SaveAsync(
            (_, row) =>
            {
                if (problems.Count == 0)
                {
                    TrafficMapper.Apply(settings with { Allowlist = [.. allowlist.Distinct(StringComparer.Ordinal)] }, row);
                    row.DetectionChosen = true;
                }

                return Task.FromResult(problems);
            },
            by,
            cancellationToken);
    }

    public Task<TrafficSaveResult> SaveAutoBlockAsync(AutoBlockSettings settings, string by, CancellationToken cancellationToken)
    {
        if (settings is null)
        {
            return Task.FromResult(new TrafficSaveResult(["The settings are missing."]));
        }

        var problems = new List<string>();
        var kinds = settings.Kinds ?? [];
        if (kinds.Any(kind => !Enum.IsDefined(kind)))
        {
            problems.Add("One of the attack kinds is not one this server knows. Update the app, then try again.");
        }

        Range(problems, settings.Minutes, 0, MaxBlockMinutes, $"A block lasts 0 (for good) to {MaxBlockMinutes} minutes (a year).");
        Range(problems, settings.MaxBlocked, 1, MaxBlockedAtOnce, $"Block 1 to {MaxBlockedAtOnce} addresses at once.");
        return SaveAsync(
            (_, row) =>
            {
                if (problems.Count == 0)
                {
                    TrafficMapper.Apply(settings with { Kinds = [.. Enum.GetValues<AttackKind>().Where(kinds.Contains)] }, row);
                }

                return Task.FromResult(problems);
            },
            by,
            cancellationToken);
    }

    public async Task<TrafficStatus> DeleteAsync(string? siteId, CancellationToken cancellationToken)
    {
        await store.DeleteAsync(siteId, cancellationToken);
        return await StatusAsync(cancellationToken);
    }

    /// <summary>A log read from its end as it is now, or from its start when nginx has not made it yet.</summary>
    private static async Task<TrafficCursorState> StartOfAsync(INginxMachine machine, string path, string siteId, CancellationToken cancellationToken)
    {
        if (await machine.LengthAsync(path, cancellationToken) is not { } length)
        {
            return new TrafficCursorState(siteId, 0, string.Empty, 0, null);
        }

        var head = length == 0 ? [] : await machine.ReadRangeAsync(path, 0, (int)Math.Min(TrafficTailer.FingerprintBytes, length), cancellationToken);
        return new TrafficCursorState(siteId, length, head.Length == 0 ? string.Empty : TrafficTailer.Fingerprint(head), head.Length, null);
    }

    private static async Task SaveCursorsAsync(CoreDbContext db, List<TrafficCursorState> cursors, CancellationToken cancellationToken)
    {
        var ids = cursors.Select(c => c.SiteId).ToList();
        var rows = await db.TrafficLogCursors.Where(c => ids.Contains(c.SiteId)).ToDictionaryAsync(c => c.SiteId, StringComparer.Ordinal, cancellationToken);
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
        }
    }

    /// <summary>Sites as statistics see them: every site but the core's own domain, its domains in order, and whether a snippet turns its log off.</summary>
    internal static async Task<List<(string Id, string[] Domains, bool LoggingOff)>> SitesAsync(CoreDbContext db, CancellationToken cancellationToken)
    {
        var sites = await db.Sites.AsNoTracking()
            .Where(s => s.Id != CoreDomain.CoreDomainSettings.SiteId)
            .OrderBy(s => s.Id)
            .Select(s => new { s.Id, s.ServerSnippet, s.LocationSnippet })
            .ToListAsync(cancellationToken);
        var domains = (await db.SiteDomains.AsNoTracking().ToListAsync(cancellationToken))
            .GroupBy(d => d.SiteId, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.OrderBy(d => d.Position).Select(d => d.Domain).ToArray(), StringComparer.Ordinal);
        return [.. sites.Select(site => (site.Id, domains.GetValueOrDefault(site.Id) ?? [], LogsOff(site.ServerSnippet) || LogsOff(site.LocationSnippet)))];
    }

    /// <summary>Whether a snippet has <c>access_log off</c> anywhere: the only access_log a snippet may have.</summary>
    internal static bool LogsOff(string? snippet)
    {
        if (string.IsNullOrWhiteSpace(snippet))
        {
            return false;
        }

        try
        {
            return Off(NginxConfigParser.Parse(NginxSnippet.Normalize(snippet)));
        }
        catch (NginxSyntaxException)
        {
            return false;
        }

        static bool Off(IReadOnlyList<NginxDirective> directives) =>
            directives.Any(d => (d.Name == "access_log" && d.Arguments is ["off"]) || (d.Block is { } block && Off(block)));
    }

    private static TrafficSetting Defaults() => new() { TimeZone = ServerTimeZone() };

    private static TrafficConfig Configure(TrafficSetting row, int version) =>
        new(TrafficMapper.ToSettings(row), TrafficMapper.ToAttacks(row), TrafficMapper.ToAutoBlock(row), ZoneOf(row.TimeZone), row.EnabledAt, version);

    private static void Range(List<string> problems, int value, int min, int max, string problem)
    {
        if (value < min || value > max)
        {
            problems.Add(problem);
        }
    }

    /// <summary>Changes the row (made with the defaults if missing) unless the change finds problems, then puts it in effect.</summary>
    /// <remarks>
    /// A save that turns the logs on from off asks the tailer to start: at the logs' end, or (the
    /// first time statistics come on, if asked) at what they already hold.
    /// </remarks>
    private async Task<TrafficSaveResult> SaveAsync(Func<CoreDbContext, TrafficSetting, Task<List<string>>> change, string by, CancellationToken cancellationToken, Func<bool>? readExisting = null)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await using var db = await contexts.CreateDbContextAsync(cancellationToken);
            var row = await db.TrafficSettings.FirstOrDefaultAsync(s => s.Id == TrafficSetting.SingletonId, cancellationToken);
            if (row is null)
            {
                row = Defaults();
                db.TrafficSettings.Add(row);
            }

            var wasTailing = row.Enabled || row.AttackEnabled;
            var excludedBefore = TrafficMapper.ReadStrings(row.ExcludedSites).ToHashSet(StringComparer.Ordinal);
            var problems = await change(db, row);
            if (problems.Count > 0)
            {
                return new TrafficSaveResult([.. problems]);
            }

            // Every log's starting point is taken here, before the save returns, so a line written
            // the moment after is counted, not skipped by a start taken on the tailer's next tick.
            var starting = !wasTailing && (row.Enabled || row.AttackEnabled);
            var existing = starting && (readExisting?.Invoke() ?? false);
            var recorded = new List<TrafficCursorState>();
            if (_logs is { } logs && (row.Enabled || row.AttackEnabled) && !existing)
            {
                var excluded = TrafficMapper.ReadStrings(row.ExcludedSites).ToHashSet(StringComparer.Ordinal);
                foreach (var (id, _, _) in await SitesAsync(db, cancellationToken))
                {
                    // On start every site; while reading, a site let back in.
                    if (!excluded.Contains(id) && (starting || excludedBefore.Contains(id)))
                    {
                        recorded.Add(await StartOfAsync(logs.Machine, logs.Layout.AccessLog(id), id, cancellationToken));
                    }
                }

                await SaveCursorsAsync(db, recorded, cancellationToken);
            }

            row.ChangedAt = time.GetUtcNow().ToUnixTimeMilliseconds();
            row.ChangedBy = by;
            await db.SaveChangesAsync(cancellationToken);
            lock (_startGate)
            {
                foreach (var cursor in recorded)
                {
                    _pendingCursors[cursor.SiteId] = cursor;
                }

                if (starting)
                {
                    _start = (existing, _logs is not null && !existing);
                }
            }

            _current = Configure(row, _current.Version + 1);
        }
        finally
        {
            _gate.Release();
        }

        return new TrafficSaveResult([], await StatusAsync(cancellationToken));
    }
}
