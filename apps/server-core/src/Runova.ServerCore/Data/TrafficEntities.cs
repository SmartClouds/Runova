using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Data;

// Website traffic (E109) and attack detection (E110). Statistics are kept per site and, under
// TrafficSites.All, for every site together, so a report reads the same few rows either way. No
// statistics row holds a visitor's address; attack events and blocks do, since blocking needs them.

/// <summary>One site's traffic in one hour (UTC). The counters only ever grow by what each flush adds.</summary>
internal sealed class TrafficHour
{
    public required string SiteId { get; set; }

    public long HourUnixMs { get; set; }

    public long Requests { get; set; }

    public long PageViews { get; set; }

    public long Visits { get; set; }

    public long Bounces { get; set; }

    public long VisitSeconds { get; set; }

    /// <summary>An estimate for the hour, from a small sketch kept while the hour is open.</summary>
    public long Visitors { get; set; }

    public long Bytes { get; set; }

    public long BotRequests { get; set; }

    public long Status2xx { get; set; }

    public long Status3xx { get; set; }

    public long Status4xx { get; set; }

    public long Status5xx { get; set; }

    public long ResponseMsTotal { get; set; }

    public long ResponseCount { get; set; }

    /// <summary>Requests per response time bucket (<see cref="Traffic.ResponseHistogram"/>).</summary>
    public byte[] ResponseHistogram { get; set; } = [];
}

/// <summary>One site's traffic on one day of the report's time zone, with the sketch of its visitors.</summary>
internal sealed class TrafficDay
{
    public required string SiteId { get; set; }

    /// <summary>Days since 0001-01-01 (DateOnly.DayNumber) in the time zone of the day's first flush.</summary>
    public int Day { get; set; }

    /// <summary>When the day began, in UTC.</summary>
    public long StartUnixMs { get; set; }

    public long Requests { get; set; }

    public long PageViews { get; set; }

    public long Visits { get; set; }

    public long Bounces { get; set; }

    public long VisitSeconds { get; set; }

    public long Bytes { get; set; }

    public long BotRequests { get; set; }

    public long Status2xx { get; set; }

    public long Status3xx { get; set; }

    public long Status4xx { get; set; }

    public long Status5xx { get; set; }

    public long ResponseMsTotal { get; set; }

    public long ResponseCount { get; set; }

    public byte[] ResponseHistogram { get; set; } = [];

    /// <summary>Page views placed by Cloudflare's header, by DB-IP, or not placed.</summary>
    public long CountryCloudflare { get; set; }

    public long CountryDbIp { get; set; }

    public long CountryUnknown { get; set; }

    /// <summary>The day's visitors as a HyperLogLog sketch (4 KB), merged for any range.</summary>
    public byte[] Sketch { get; set; } = [];
}

/// <summary>How often one value of one dimension came up on one day; the top 500 a day, the rest as "Other".</summary>
internal sealed class TrafficDimensionDay
{
    public required string SiteId { get; set; }

    public int Day { get; set; }

    public long StartUnixMs { get; set; }

    public TrafficDimension Dimension { get; set; }

    public required string Value { get; set; }

    public long Count { get; set; }
}

/// <summary>How far the tailer has read a site's access log, and the file it was reading then.</summary>
internal sealed class TrafficLogCursor
{
    public required string SiteId { get; set; }

    public long Offset { get; set; }

    /// <summary>A hash of the file's first bytes (up to <see cref="FingerprintLength"/>), which a rotated file no longer has.</summary>
    public string Fingerprint { get; set; } = string.Empty;

    public int FingerprintLength { get; set; }

    public long? LastLineAt { get; set; }

    public long UpdatedAt { get; set; }
}

/// <summary>Statistics, detection and auto-block settings: one row, made on first use.</summary>
internal sealed class TrafficSetting
{
    public const int SingletonId = 1;

    public int Id { get; set; } = SingletonId;

    public bool Enabled { get; set; }

    public bool Countries { get; set; } = true;

    /// <summary>JSON array of site ids.</summary>
    public string ExcludedSites { get; set; } = "[]";

    public int HourlyRetentionDays { get; set; } = 90;

    public int DailyRetentionDays { get; set; } = 730;

    public string TimeZone { get; set; } = "UTC";

    /// <summary>When statistics were last turned on.</summary>
    public long? EnabledAt { get; set; }

    public bool AttackEnabled { get; set; }

    /// <summary>Whether a person has set detection themselves; until then turning statistics on turns it on too.</summary>
    public bool DetectionChosen { get; set; }

    public int ScanProbes { get; set; } = 20;

    public int ScanNotFound { get; set; } = 50;

    public int ScanWindowMinutes { get; set; } = 5;

    public int BruteForceAttempts { get; set; } = 20;

    public int BruteForceWindowMinutes { get; set; } = 5;

    public int FloodRequestsPerMinute { get; set; } = 600;

    public int InjectionHits { get; set; } = 5;

    public int InjectionWindowMinutes { get; set; } = 10;

    /// <summary>JSON array of addresses and CIDR networks never flagged or blocked.</summary>
    public string Allowlist { get; set; } = "[]";

    public int EventRetentionDays { get; set; } = 30;

    public bool AutoBlockEnabled { get; set; }

    /// <summary>JSON array of attack kinds that block.</summary>
    public string AutoBlockKinds { get; set; } = "[\"scan\",\"bruteForce\",\"flood\",\"injection\"]";

    public int AutoBlockMinutes { get; set; } = 60;

    public int AutoBlockMaxBlocked { get; set; } = 1000;

    public long? ChangedAt { get; set; }

    public string? ChangedBy { get; set; }
}

/// <summary>One address attacking one site in one way, while it goes on. Here addresses are kept: blocking needs them.</summary>
internal sealed class AttackEvent
{
    public long Id { get; set; }

    public required string SiteId { get; set; }

    public AttackKind Kind { get; set; }

    public required string Address { get; set; }

    public string? Country { get; set; }

    public long FirstSeenAt { get; set; }

    public long LastSeenAt { get; set; }

    public int Count { get; set; }

    /// <summary>JSON array of up to five paths it asked for.</summary>
    public string SamplePaths { get; set; } = "[]";

    public bool Blocked { get; set; }
}

/// <summary>An address or network nginx refuses on every site.</summary>
internal sealed class BlockedAddress
{
    public long Id { get; set; }

    public required string Network { get; set; }

    public required string Reason { get; set; }

    public bool Automatic { get; set; }

    public long CreatedAt { get; set; }

    public string? CreatedBy { get; set; }

    public string? SiteId { get; set; }

    public long? ExpiresAt { get; set; }
}

internal static class TrafficModel
{
    public static void Configure(ModelBuilder builder)
    {
        builder.Entity<TrafficHour>(hour =>
        {
            hour.HasKey(h => new { h.SiteId, h.HourUnixMs });
            hour.Property(h => h.SiteId).HasMaxLength(63);
            hour.HasIndex(h => h.HourUnixMs);
        });

        builder.Entity<TrafficDay>(day =>
        {
            day.HasKey(d => new { d.SiteId, d.Day });
            day.Property(d => d.SiteId).HasMaxLength(63);
            day.HasIndex(d => new { d.SiteId, d.StartUnixMs });
            day.HasIndex(d => d.StartUnixMs);
        });

        builder.Entity<TrafficDimensionDay>(dimension =>
        {
            dimension.HasKey(d => new { d.SiteId, d.Day, d.Dimension, d.Value });
            dimension.Property(d => d.SiteId).HasMaxLength(63);
            dimension.Property(d => d.Dimension).HasConversion<string>().HasMaxLength(20);
            dimension.Property(d => d.Value).HasMaxLength(300);
            dimension.HasIndex(d => new { d.SiteId, d.Dimension, d.StartUnixMs });
            dimension.HasIndex(d => d.StartUnixMs);
        });

        builder.Entity<TrafficLogCursor>(cursor =>
        {
            cursor.HasKey(c => c.SiteId);
            cursor.Property(c => c.SiteId).HasMaxLength(63);
            cursor.Property(c => c.Fingerprint).HasMaxLength(64);
        });

        builder.Entity<TrafficSetting>(setting =>
        {
            setting.HasKey(s => s.Id);
            setting.Property(s => s.Id).ValueGeneratedNever();
            setting.Property(s => s.ExcludedSites).HasMaxLength(40_000);
            setting.Property(s => s.TimeZone).HasMaxLength(64);
            setting.Property(s => s.Allowlist).HasMaxLength(40_000);
            setting.Property(s => s.AutoBlockKinds).HasMaxLength(200);
            setting.Property(s => s.ChangedBy).HasMaxLength(256);
        });

        builder.Entity<AttackEvent>(attack =>
        {
            attack.HasKey(a => a.Id);
            attack.Property(a => a.SiteId).HasMaxLength(63);
            attack.Property(a => a.Kind).HasConversion<string>().HasMaxLength(20);
            attack.Property(a => a.Address).HasMaxLength(64);
            attack.Property(a => a.Country).HasMaxLength(2);
            attack.Property(a => a.SamplePaths).HasMaxLength(4000);
            attack.HasIndex(a => a.LastSeenAt);
            attack.HasIndex(a => new { a.SiteId, a.LastSeenAt });
        });

        builder.Entity<BlockedAddress>(blocked =>
        {
            blocked.HasKey(b => b.Id);
            blocked.Property(b => b.Network).HasMaxLength(64);
            blocked.HasIndex(b => b.Network).IsUnique();
            blocked.Property(b => b.Reason).HasMaxLength(200);
            blocked.Property(b => b.CreatedBy).HasMaxLength(256);
            blocked.Property(b => b.SiteId).HasMaxLength(63);
            blocked.HasIndex(b => b.ExpiresAt);
        });
    }
}
