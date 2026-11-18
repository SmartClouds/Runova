using System.Globalization;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Alerts;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Traffic;

/// <summary>
/// Turns the detectors' hits into alerts, attack events and automatic blocks (E110). Each site and
/// kind has at most one open alert (resource <c>site:&lt;id&gt;</c>), whose message names the busiest
/// addresses with their country and counts; it is raised again at most once a minute while the
/// attack goes on, at once when it gets worse, and resolved after <see cref="QuietToResolve"/> without
/// a hit. Every address's part is kept as an attack event, written once a minute. With auto-block on,
/// each newly flagged address of a chosen kind is blocked, except addresses an app is connected from
/// and the addresses of a site-wide flood (none of which was over the rate alone). Memory is bounded:
/// at most <see cref="MaxAddressesPerIncident"/> addresses per site and kind.
/// </summary>
internal sealed partial class AttackMonitor(
    IDbContextFactory<CoreDbContext> contexts,
    AlertCenter alerts,
    AddressBlocks blocks,
    IAppAddresses app,
    TimeProvider time,
    ILogger<AttackMonitor> logger)
{
    public const string ResourcePrefix = "site:";

    public const int MaxAddressesPerIncident = 1000;

    public const int SamplePaths = 5;

    public const int MaxListed = 1000;

    public static readonly TimeSpan QuietToResolve = TimeSpan.FromMinutes(10);

    public static readonly TimeSpan UpdateEvery = TimeSpan.FromMinutes(1);

    public static readonly TimeSpan DefaultListRange = TimeSpan.FromDays(7);

    private const int TopNamed = 3;

    private const int CriticalAddresses = 5;

    private const int CriticalFactor = 10;

    private const long HourMs = 3_600_000;

    private readonly Lock _gate = new();
    private readonly Dictionary<(string Site, AttackKind Kind), Incident> _incidents = [];
    private readonly HashSet<Activity> _dirty = [];

    public static AlertKind AlertKindOf(AttackKind kind) => kind switch
    {
        AttackKind.BruteForce => AlertKind.WebBruteForce,
        AttackKind.Flood => AlertKind.WebFlood,
        AttackKind.Injection => AlertKind.WebInjection,
        _ => AlertKind.WebScan,
    };

    /// <summary>Takes in the hits of one read of the logs. Cheap: memory only.</summary>
    public void Record(IReadOnlyList<AttackHit> hits, Func<string, string> siteName)
    {
        ArgumentNullException.ThrowIfNull(hits);
        ArgumentNullException.ThrowIfNull(siteName);
        if (hits.Count == 0)
        {
            return;
        }

        var now = time.GetUtcNow();
        lock (_gate)
        {
            foreach (var hit in hits)
            {
                if (!_incidents.TryGetValue((hit.Site, hit.Kind), out var incident))
                {
                    incident = new Incident(hit.Site, hit.Kind, siteName(hit.Site));
                    _incidents[(hit.Site, hit.Kind)] = incident;
                }

                incident.LastActivity = now;
                incident.Dirty = true;
                incident.Total += hit.Count;
                if (!incident.Addresses.TryGetValue(hit.Address, out var activity))
                {
                    if (incident.Addresses.Count >= MaxAddressesPerIncident)
                    {
                        continue;
                    }

                    activity = new Activity(incident, hit.Address, hit.AtUnixMs, hit.SiteWide);
                    incident.Addresses[hit.Address] = activity;
                    if (!hit.SiteWide)
                    {
                        incident.NewlyFlagged.Add(activity);
                    }
                }

                activity.Count += hit.Count;
                activity.First = Math.Min(activity.First, hit.AtUnixMs);
                activity.Last = Math.Max(activity.Last, hit.AtUnixMs);
                activity.Country ??= hit.Country is GeoCountry.Unknown ? null : hit.Country;
                if (activity.Samples.Count < SamplePaths && !activity.Samples.Contains(hit.Path))
                {
                    activity.Samples.Add(hit.Path);
                }

                _dirty.Add(activity);
            }
        }
    }

    /// <summary>
    /// Alerts raised, updated or resolved, and addresses auto-blocked. Called on every tick of the
    /// tailer, with or without new lines, so a quiet attack resolves on time.
    /// </summary>
    public async Task UpdateAsync(TrafficConfig config, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(config);
        var now = time.GetUtcNow();
        var raise = new List<(AlertKind Kind, string Resource, AlertSeverity Severity, string Message)>();
        var resolve = new List<(AlertKind Kind, string Resource)>();
        var candidates = new List<(AutoBlockCandidate Candidate, Activity Activity)>();
        lock (_gate)
        {
            foreach (var (key, incident) in _incidents.ToList())
            {
                if (!config.Attacks.Enabled || now - incident.LastActivity >= QuietToResolve)
                {
                    resolve.Add((AlertKindOf(key.Kind), ResourcePrefix + key.Site));
                    _incidents.Remove(key);
                    continue;
                }

                if (incident.Dirty && incident.Addresses.Count > 0)
                {
                    var severity = SeverityOf(incident, config.Attacks.Thresholds);
                    if (!incident.Raised || severity > incident.Severity || now - incident.RaisedAt >= UpdateEvery)
                    {
                        raise.Add((AlertKindOf(key.Kind), ResourcePrefix + key.Site, severity, MessageOf(incident)));
                        incident.Raised = true;
                        incident.Severity = severity;
                        incident.RaisedAt = now;
                        incident.Dirty = false;
                    }
                }

                if (config.AutoBlock.Enabled && config.AutoBlock.Kinds.Contains(key.Kind))
                {
                    candidates.AddRange(incident.NewlyFlagged.Select(activity => (new AutoBlockCandidate(activity.Address, key.Kind, key.Site, incident.SiteName), activity)));
                }

                incident.NewlyFlagged.Clear();
            }
        }

        foreach (var (kind, resource, severity, message) in raise)
        {
            await SafelyAsync(() => alerts.RaiseAsync(kind, resource, severity, message, cancellationToken));
        }

        foreach (var (kind, resource) in resolve)
        {
            await SafelyAsync(() => alerts.ResolveAsync(kind, resource, cancellationToken));
        }

        if (candidates.Count > 0)
        {
            await SafelyAsync(async () =>
            {
                var blocked = await blocks.AutoBlockAsync([.. candidates.Select(c => c.Candidate)], config.AutoBlock, await app.CurrentAsync(cancellationToken), cancellationToken);
                lock (_gate)
                {
                    foreach (var (_, activity) in candidates.Where(c => blocked.Contains(c.Candidate.Address)))
                    {
                        activity.Blocked = true;
                        _dirty.Add(activity);
                    }
                }
            });
        }
    }

    /// <summary>Alerts still open from before a restart: they resolve like any other once the site has been quiet.</summary>
    public async Task AssumeOpenAsync(CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        foreach (var kind in Enum.GetValues<AttackKind>())
        {
            foreach (var open in await alerts.OpenAsync(AlertKindOf(kind), cancellationToken))
            {
                if (!open.Resource.StartsWith(ResourcePrefix, StringComparison.Ordinal))
                {
                    continue;
                }

                var site = open.Resource[ResourcePrefix.Length..];
                lock (_gate)
                {
                    if (!_incidents.ContainsKey((site, kind)))
                    {
                        _incidents[(site, kind)] = new Incident(site, kind, site) { LastActivity = now, Raised = true, RaisedAt = now, Severity = open.Severity };
                    }
                }
            }
        }
    }

    /// <summary>Writes what changed since the last flush as attack events, carrying on each address's event while its attack lasts.</summary>
    public async Task FlushAsync(CancellationToken cancellationToken)
    {
        List<(Activity Activity, long? EventId, int Count, long First, long Last, string[] Samples, string? Country, bool Blocked)> changes;
        lock (_gate)
        {
            changes = [.. _dirty.Select(a => (a, a.EventId, a.Count, a.First, a.Last, a.Samples.ToArray(), a.Country, a.Blocked))];
            _dirty.Clear();
        }

        if (changes.Count == 0)
        {
            return;
        }

        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        await using var transaction = await Data.CoreDatabase.BeginWriteAsync(db, cancellationToken);
        var ids = changes.Where(c => c.EventId is not null).Select(c => c.EventId!.Value).ToList();
        var rows = await db.AttackEvents.Where(e => ids.Contains(e.Id)).ToDictionaryAsync(e => e.Id, cancellationToken);
        var added = new List<(Activity Activity, AttackEvent Row)>();
        foreach (var change in changes)
        {
            if (change.EventId is not { } id || !rows.TryGetValue(id, out var row))
            {
                row = new AttackEvent { SiteId = change.Activity.Incident.Site, Kind = change.Activity.Incident.Kind, Address = change.Activity.Address.ToString() };
                db.AttackEvents.Add(row);
                added.Add((change.Activity, row));
            }

            row.Country = change.Country;
            row.FirstSeenAt = change.First;
            row.LastSeenAt = change.Last;
            row.Count = change.Count;
            row.SamplePaths = TrafficMapper.WriteStrings(change.Samples);
            row.Blocked |= change.Blocked;
        }

        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        lock (_gate)
        {
            foreach (var (activity, row) in added)
            {
                activity.EventId = row.Id;
            }
        }
    }

    public async Task<int> PruneAsync(int retentionDays, CancellationToken cancellationToken)
    {
        var cutoff = (time.GetUtcNow() - TimeSpan.FromDays(retentionDays)).ToUnixTimeMilliseconds();
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        return await db.AttackEvents.Where(e => e.LastSeenAt < cutoff).ExecuteDeleteAsync(cancellationToken);
    }

    public Task<AttackSummary> ListAsync(AttackQuery query, CancellationToken cancellationToken) =>
        ListAsync(query, TimeZoneInfo.Utc, cancellationToken);

    /// <summary>Events newest first, and how many began each hour (each day of the zone, over more than three days), by kind.</summary>
    public async Task<AttackSummary> ListAsync(AttackQuery query, TimeZoneInfo zone, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        ArgumentNullException.ThrowIfNull(zone);
        // Without an end, up to and including now.
        var to = query.ToUnixMs ?? (time.GetUtcNow().ToUnixTimeMilliseconds() + 1);
        var from = query.FromUnixMs ?? (to - (long)DefaultListRange.TotalMilliseconds);
        if (to <= from || to - from > (long)TrafficStore.MaxRange.TotalMilliseconds)
        {
            throw new ArgumentException("Choose a range that ends after it starts, at most three years long.");
        }

        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var site = query.SiteId;
        var inRange = db.AttackEvents.AsNoTracking().Where(e => (site == null || e.SiteId == site) && e.LastSeenAt >= from && e.FirstSeenAt < to);
        var events = await inRange.OrderByDescending(e => e.LastSeenAt).ThenByDescending(e => e.Id).Take(Math.Clamp(query.Limit, 1, MaxListed)).ToListAsync(cancellationToken);
        var addresses = await inRange.Select(e => e.Address).Distinct().CountAsync(cancellationToken);
        var blocked = await inRange.Where(e => e.Blocked).Select(e => e.Address).Distinct().CountAsync(cancellationToken);
        var hours = await db.AttackEvents.AsNoTracking()
            .Where(e => (site == null || e.SiteId == site) && e.FirstSeenAt >= from && e.FirstSeenAt < to)
            .GroupBy(e => new { Hour = e.FirstSeenAt / HourMs, e.Kind })
            .Select(g => new { g.Key.Hour, g.Key.Kind, Count = g.Count() })
            .ToListAsync(cancellationToken);

        var daily = to - from > 3 * 24 * HourMs;
        var buckets = new List<long>();
        if (daily)
        {
            var first = DateOnly.FromDayNumber(TrafficStore.DayNumber(from, zone));
            for (var date = first; TrafficStore.StartOf(date, zone) < to && buckets.Count < 2000; date = date.AddDays(1))
            {
                buckets.Add(TrafficStore.StartOf(date, zone));
            }
        }
        else
        {
            for (var hour = from - (from % HourMs); hour < to; hour += HourMs)
            {
                buckets.Add(hour);
            }
        }

        var counts = buckets.ToDictionary(start => start, _ => new int[4]);
        foreach (var hour in hours)
        {
            var at = hour.Hour * HourMs;
            var start = daily ? TrafficStore.StartOf(DateOnly.FromDayNumber(TrafficStore.DayNumber(at, zone)), zone) : at;
            if (counts.TryGetValue(start, out var kinds))
            {
                kinds[(int)hour.Kind] += hour.Count;
            }
        }

        return new AttackSummary(
            [.. events.Select(TrafficMapper.ToInfo)],
            [.. buckets.Select(start => new AttackPoint(start, counts[start][(int)AttackKind.Scan], counts[start][(int)AttackKind.BruteForce], counts[start][(int)AttackKind.Flood], counts[start][(int)AttackKind.Injection]))],
            addresses,
            blocked);
    }

    private static AlertSeverity SeverityOf(Incident incident, AttackThresholds thresholds)
    {
        var threshold = incident.Kind switch
        {
            AttackKind.BruteForce => thresholds.BruteForceAttempts,
            AttackKind.Flood => thresholds.FloodRequestsPerMinute,
            AttackKind.Injection => thresholds.InjectionHits,
            _ => thresholds.ScanProbes,
        };
        return incident.Addresses.Count >= CriticalAddresses || incident.Total >= (long)CriticalFactor * threshold
            ? AlertSeverity.Critical
            : AlertSeverity.Warning;
    }

    /// <summary>"198.51.100.7 (DE) probed shop.example.com for files and admin pages 412 times." or the busiest few of many.</summary>
    private static string MessageOf(Incident incident)
    {
        var site = incident.SiteName;
        var addresses = incident.Addresses.Values.OrderByDescending(a => a.Count).ThenBy(a => a.First).ToList();
        if (incident.Kind == AttackKind.Flood && addresses.All(a => a.SiteWide))
        {
            return $"{site} is getting far more requests than usual ({Times(incident.Total)} from {Count(addresses.Count, "address", "addresses")}). Busiest: {string.Join(", ", addresses.Take(TopNamed).Select(Named))}.";
        }

        var what = incident.Kind switch
        {
            AttackKind.BruteForce => $"tried passwords on {site}",
            AttackKind.Flood => $"flooded {site} with requests",
            AttackKind.Injection => $"sent injection probes to {site}",
            _ => $"probed {site} for files and admin pages",
        };
        if (addresses.Count == 1)
        {
            return $"{Who(addresses[0])} {what} {Times(addresses[0].Count)}.";
        }

        var more = addresses.Count > TopNamed ? $" and {addresses.Count - TopNamed} more" : string.Empty;
        return $"{Count(addresses.Count, "address", "addresses")} {what}: {string.Join(", ", addresses.Take(TopNamed).Select(Named))}{more}.";

        static string Who(Activity activity) => activity.Country is { } country ? $"{activity.Address} ({country})" : activity.Address.ToString();

        static string Named(Activity activity) => $"{Who(activity)} {Times(activity.Count)}";
    }

    private static string Times(long count) => count == 1 ? "once" : string.Create(CultureInfo.InvariantCulture, $"{count:N0} times");

    private static string Count(long count, string one, string many) => string.Create(CultureInfo.InvariantCulture, $"{count:N0} {(count == 1 ? one : many)}");

    private async Task SafelyAsync(Func<Task> action)
    {
        try
        {
            await action();
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            LogFailed(logger, error);
        }
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "An attack alert or block could not be recorded; it is tried again on the next read.")]
    private static partial void LogFailed(ILogger logger, Exception error);

    /// <summary>One site under one kind of attack, while it lasts.</summary>
    private sealed class Incident(string site, AttackKind kind, string siteName)
    {
        public string Site { get; } = site;

        public AttackKind Kind { get; } = kind;

        public string SiteName { get; } = siteName;

        public Dictionary<IpKey, Activity> Addresses { get; } = [];

        public List<Activity> NewlyFlagged { get; } = [];

        public long Total { get; set; }

        public DateTimeOffset LastActivity { get; set; }

        public bool Dirty { get; set; }

        public bool Raised { get; set; }

        public DateTimeOffset RaisedAt { get; set; }

        public AlertSeverity Severity { get; set; }
    }

    /// <summary>One address's part in an incident: its attack event.</summary>
    private sealed class Activity(Incident incident, IpKey address, long at, bool siteWide)
    {
        public Incident Incident { get; } = incident;

        public IpKey Address { get; } = address;

        public bool SiteWide { get; } = siteWide;

        public long First { get; set; } = at;

        public long Last { get; set; } = at;

        public int Count { get; set; }

        public string? Country { get; set; }

        public List<string> Samples { get; } = [];

        public bool Blocked { get; set; }

        public long? EventId { get; set; }
    }
}
