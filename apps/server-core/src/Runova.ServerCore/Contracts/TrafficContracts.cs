using Tapper;

namespace Runova.ServerCore.Contracts;

// Website traffic statistics (E109) and attack detection (E110). The core reads the access logs
// nginx writes for each site, keeps hourly and daily totals, and watches the same lines for
// attacks. Times are Unix milliseconds. A null SiteId means every site on the server.

[TranspilationSource]
public enum TrafficGranularity
{
    Hour,
    Day,
    Week,
    Month,
}

/// <summary>What a breakdown counts. Pages and entry pages count page views and visits; the rest count visitors' page views.</summary>
[TranspilationSource]
public enum TrafficDimension
{
    Page,
    EntryPage,
    Referrer,
    Browser,
    OperatingSystem,
    Device,
    Country,
    City,
    StatusCode,
    Bot,
}

/// <summary>The figures for one range. Visitors is an estimate (HyperLogLog, about 1.6%).</summary>
[TranspilationSource]
public sealed record TrafficTotals(
    long Visitors,
    long Visits,
    long PageViews,
    long Requests,
    long BotRequests,
    long Bytes,
    long Bounces,
    long VisitSeconds,
    long Status2xx,
    long Status3xx,
    long Status4xx,
    long Status5xx,
    double AverageResponseMs,
    double P95ResponseMs);

/// <summary>One bucket of the series, starting at StartUnixMs (an hour, or a day, week or month in the report's time zone).</summary>
[TranspilationSource]
public sealed record TrafficPoint(
    long StartUnixMs,
    long Visitors,
    long Visits,
    long PageViews,
    long Requests,
    long BotRequests,
    long Bytes,
    long Status4xx,
    long Status5xx);

[TranspilationSource]
public sealed record TrafficCount(string Value, long Count);

/// <summary>The top values of one dimension, and the total they are a share of.</summary>
[TranspilationSource]
public sealed record TrafficBreakdown(TrafficDimension Dimension, TrafficCount[] Top, long Total);

/// <summary>How many page views had their country from Cloudflare's headers, from DB-IP, or from neither.</summary>
[TranspilationSource]
public sealed record TrafficCountrySources(long Cloudflare, long DbIp, long Unknown);

/// <summary>
/// A report for one site or all of them. From is inclusive, To exclusive. Hour granularity reads
/// hourly rows, so it covers only the hourly retention. Compare adds the period of the same length
/// just before.
/// </summary>
[TranspilationSource]
public sealed record TrafficReportRequest(
    string? SiteId,
    long FromUnixMs,
    long ToUnixMs,
    TrafficGranularity Granularity,
    bool Compare = true);

/// <summary>
/// HourOfWeek is 168 page view counts, Monday 00:00 first, in the report's time zone. Breakdowns
/// hold the top 50 of each dimension. CollectingSinceUnixMs is when statistics were last turned on.
/// </summary>
[TranspilationSource]
public sealed record TrafficReport(
    string? SiteId,
    long FromUnixMs,
    long ToUnixMs,
    TrafficGranularity Granularity,
    string TimeZone,
    TrafficTotals Totals,
    TrafficPoint[] Series,
    TrafficBreakdown[] Breakdowns,
    long[] HourOfWeek,
    TrafficCountrySources CountrySources,
    bool Enabled,
    long? CollectingSinceUnixMs = null,
    TrafficTotals? Previous = null,
    TrafficPoint[]? PreviousSeries = null);

/// <summary>Every value of one dimension over a range, a page at a time, optionally only values containing Search.</summary>
[TranspilationSource]
public sealed record TrafficDimensionRequest(
    string? SiteId,
    long FromUnixMs,
    long ToUnixMs,
    TrafficDimension Dimension,
    int Offset = 0,
    int Limit = 100,
    string? Search = null);

/// <summary>Total is the sum over every value; TotalItems how many values there are.</summary>
[TranspilationSource]
public sealed record TrafficDimensionPage(TrafficDimension Dimension, TrafficCount[] Items, long Total, int TotalItems);

[TranspilationSource]
public sealed record TrafficLiveRequest(string? SiteId);

/// <summary>Visitors seen in the last five minutes, requests in the last minute, and the pages being looked at.</summary>
[TranspilationSource]
public sealed record TrafficLive(long AtUnixMs, int VisitorsNow, int RequestsLastMinute, TrafficCount[] PagesNow);

/// <summary>
/// The statistics side. TimeZone is an IANA name; days, weeks (from Monday) and months follow it.
/// ExcludedSites are not counted. ReadExistingLogs, when turning statistics on, also reads what the
/// logs already hold (up to 200 MB a site) instead of starting at their end.
/// </summary>
[TranspilationSource]
public sealed record TrafficSettings(
    bool Enabled,
    bool Countries,
    string[] ExcludedSites,
    int HourlyRetentionDays,
    int DailyRetentionDays,
    string TimeZone,
    bool ReadExistingLogs = false);

[TranspilationSource]
public enum AttackKind
{
    /// <summary>Probe paths (/.env, /.git/, /phpmyadmin...) or many 404s from one address.</summary>
    Scan,

    /// <summary>Many POSTs to login paths from one address.</summary>
    BruteForce,

    /// <summary>One address over a request rate, or a site far above its normal rate.</summary>
    Flood,

    /// <summary>SQL injection, XSS, path traversal, command injection or Log4Shell patterns.</summary>
    Injection,
}

/// <summary>When each kind counts as an attack: so many hits from one address within the window.</summary>
[TranspilationSource]
public sealed record AttackThresholds(
    int ScanProbes,
    int ScanNotFound,
    int ScanWindowMinutes,
    int BruteForceAttempts,
    int BruteForceWindowMinutes,
    int FloodRequestsPerMinute,
    int InjectionHits,
    int InjectionWindowMinutes);

/// <summary>
/// Detection, which works with statistics on or off. Allowlist holds addresses and CIDR ranges that
/// are never flagged or blocked. EventRetentionDays is how long attack events (with addresses) are kept.
/// </summary>
[TranspilationSource]
public sealed record AttackSettings(
    bool Enabled,
    AttackThresholds Thresholds,
    string[] Allowlist,
    int EventRetentionDays);

/// <summary>
/// Blocking addresses by itself (Owner, with a step-up). Kinds are the attacks that block; Minutes
/// is how long a block lasts, 0 for good; MaxBlocked caps how many addresses are blocked at once.
/// </summary>
[TranspilationSource]
public sealed record AutoBlockSettings(bool Enabled, AttackKind[] Kinds, int Minutes, int MaxBlocked);

/// <summary>A site as statistics see it. LoggingOff: its snippet turns access_log off somewhere, so that traffic is missed.</summary>
[TranspilationSource]
public sealed record TrafficSiteStatus(
    string SiteId,
    string[] Domains,
    bool Excluded,
    bool LoggingOff,
    long? LastLineAtUnixMs = null);

/// <summary>
/// Everything about statistics and detection on this server. GeoDatabase* say how DB-IP's country
/// file stands. StorageBytes is roughly what the statistics take on disk.
/// </summary>
[TranspilationSource]
public sealed record TrafficStatus(
    TrafficSettings Settings,
    AttackSettings Attacks,
    AutoBlockSettings AutoBlock,
    TrafficSiteStatus[] Sites,
    bool GeoDatabaseReady,
    long StorageBytes,
    string DefaultTimeZone,
    long? CollectingSinceUnixMs = null,
    long? GeoDatabaseUpdatedAtUnixMs = null,
    string? GeoDatabaseProblem = null,
    long? ChangedAtUnixMs = null,
    string? ChangedBy = null);

/// <summary>Saved when Problems is empty (Status then says how it stands); otherwise nothing was saved.</summary>
[TranspilationSource]
public sealed record TrafficSaveResult(string[] Problems, TrafficStatus? Status = null);

/// <summary>An address that attacked a site, with what it did. Country is ISO 3166 alpha-2 when known.</summary>
[TranspilationSource]
public sealed record AttackEventInfo(
    long Id,
    string SiteId,
    AttackKind Kind,
    string Address,
    long FirstSeenAtUnixMs,
    long LastSeenAtUnixMs,
    int Count,
    string[] SamplePaths,
    bool Blocked,
    string? Country = null);

/// <summary>Newest first. A null range means the last 7 days.</summary>
[TranspilationSource]
public sealed record AttackQuery(string? SiteId, long? FromUnixMs = null, long? ToUnixMs = null, int Limit = 200);

/// <summary>Attacks per hour (or per day over more than three days), per kind.</summary>
[TranspilationSource]
public sealed record AttackPoint(long StartUnixMs, int Scan, int BruteForce, int Flood, int Injection);

[TranspilationSource]
public sealed record AttackSummary(AttackEventInfo[] Events, AttackPoint[] Series, int Addresses, int Blocked);

/// <summary>Automatic blocks have no CreatedBy. A null ExpiresAtUnixMs is for good.</summary>
[TranspilationSource]
public sealed record BlockedAddressInfo(
    long Id,
    string Network,
    string Reason,
    bool Automatic,
    long CreatedAtUnixMs,
    string? SiteId = null,
    string? CreatedBy = null,
    long? ExpiresAtUnixMs = null);

/// <summary>An address or CIDR range to block on every site. Minutes null or 0 blocks it for good.</summary>
[TranspilationSource]
public sealed record BlockAddressRequest(string Network, string? Reason = null, int? Minutes = null, string? SiteId = null);

/// <summary>Blocked when Problems is empty.</summary>
[TranspilationSource]
public sealed record BlockAddressResult(string[] Problems, BlockedAddressInfo? Blocked = null);
