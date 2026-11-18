using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Traffic;

namespace Runova.ServerCore.Tests.Mapping;

/// <summary>E109 and E110: the settings row to and from the app's settings, attack events and blocks to what the app shows.</summary>
public sealed class TrafficMapperTests
{
    private static TrafficSetting Row() => new()
    {
        Enabled = false,
        Countries = false,
        ExcludedSites = "[\"blog\",\"shop\"]",
        HourlyRetentionDays = 30,
        DailyRetentionDays = 365,
        TimeZone = "Europe/Berlin",
        EnabledAt = 1_000,
        AttackEnabled = true,
        DetectionChosen = true,
        ScanProbes = 11,
        ScanNotFound = 12,
        ScanWindowMinutes = 3,
        BruteForceAttempts = 14,
        BruteForceWindowMinutes = 4,
        FloodRequestsPerMinute = 900,
        InjectionHits = 6,
        InjectionWindowMinutes = 7,
        Allowlist = "[\"203.0.113.0/24\"]",
        EventRetentionDays = 45,
        AutoBlockEnabled = true,
        AutoBlockKinds = "[\"scan\",\"flood\"]",
        AutoBlockMinutes = 120,
        AutoBlockMaxBlocked = 50,
        ChangedAt = 2_000,
        ChangedBy = "maria",
    };

    [Fact]
    public void The_row_gives_the_statistics_settings_without_the_one_time_read_flag()
    {
        var settings = TrafficMapper.ToSettings(Row());

        Assert.Equal((false, false, 30, 365, "Europe/Berlin", false), (settings.Enabled, settings.Countries, settings.HourlyRetentionDays, settings.DailyRetentionDays, settings.TimeZone, settings.ReadExistingLogs));
        Assert.Equal(["blog", "shop"], settings.ExcludedSites);
    }

    [Fact]
    public void The_row_gives_detection_with_its_thresholds_and_allowlist()
    {
        var attacks = TrafficMapper.ToAttacks(Row());

        Assert.True(attacks.Enabled);
        Assert.Equal(new AttackThresholds(11, 12, 3, 14, 4, 900, 6, 7), attacks.Thresholds);
        Assert.Equal(["203.0.113.0/24"], attacks.Allowlist);
        Assert.Equal(45, attacks.EventRetentionDays);
    }

    [Fact]
    public void The_row_gives_auto_block()
    {
        var block = TrafficMapper.ToAutoBlock(Row());

        Assert.Equal((true, 120, 50), (block.Enabled, block.Minutes, block.MaxBlocked));
        Assert.Equal([AttackKind.Scan, AttackKind.Flood], block.Kinds);
    }

    [Fact]
    public void The_status_carries_the_row_and_what_the_caller_knows()
    {
        TrafficSiteStatus[] sites = [new("app", ["app.example.com"], false, true, 5_000)];

        var status = TrafficMapper.ToStatus(Row(), sites, true, 4096, "Etc/UTC", 3_000, "late");

        Assert.Same(sites, status.Sites);
        Assert.Equal((true, 4096L, "Etc/UTC", 1_000L, 3_000L, "late", 2_000L, "maria"), (status.GeoDatabaseReady, status.StorageBytes, status.DefaultTimeZone, status.CollectingSinceUnixMs, status.GeoDatabaseUpdatedAtUnixMs, status.GeoDatabaseProblem, status.ChangedAtUnixMs, status.ChangedBy));
        Assert.Equal("Europe/Berlin", status.Settings.TimeZone);
        Assert.Equal(900, status.Attacks.Thresholds.FloodRequestsPerMinute);
        Assert.Equal(120, status.AutoBlock.Minutes);
    }

    [Fact]
    public void Saved_settings_go_back_into_the_row_and_leave_the_rest()
    {
        var row = Row();

        TrafficMapper.Apply(new TrafficSettings(false, true, ["api"], 14, 60, "UTC", ReadExistingLogs: true), row);
        TrafficMapper.Apply(new AttackSettings(true, new AttackThresholds(1, 2, 3, 4, 5, 6, 7, 8), ["198.51.100.7"], 10), row);
        TrafficMapper.Apply(new AutoBlockSettings(false, [AttackKind.Injection], 0, 9), row);

        Assert.Equal((false, true, "[\"api\"]", 14, 60, "UTC"), (row.Enabled, row.Countries, row.ExcludedSites, row.HourlyRetentionDays, row.DailyRetentionDays, row.TimeZone));
        Assert.Equal((true, 1, 2, 3, 4, 5, 6, 7, 8), (row.AttackEnabled, row.ScanProbes, row.ScanNotFound, row.ScanWindowMinutes, row.BruteForceAttempts, row.BruteForceWindowMinutes, row.FloodRequestsPerMinute, row.InjectionHits, row.InjectionWindowMinutes));
        Assert.Equal(("[\"198.51.100.7\"]", 10), (row.Allowlist, row.EventRetentionDays));
        TrafficMapper.Apply(new AutoBlockSettings(true, [AttackKind.Injection], 0, 9), row);
        Assert.False(row.Enabled);
        Assert.Equal((true, "[\"injection\"]", 0, 9), (row.AutoBlockEnabled, row.AutoBlockKinds, row.AutoBlockMinutes, row.AutoBlockMaxBlocked));
        Assert.Equal((1_000L, true, "maria"), (row.EnabledAt, row.DetectionChosen, row.ChangedBy));
    }

    [Fact]
    public void An_attack_event_reaches_the_app_with_its_sample_paths()
    {
        var info = TrafficMapper.ToInfo(new AttackEvent
        {
            Id = 4,
            SiteId = "app",
            Kind = AttackKind.Scan,
            Address = "203.0.113.7",
            Country = "DE",
            FirstSeenAt = 10,
            LastSeenAt = 20,
            Count = 33,
            SamplePaths = "[\"/.env\",\"/.git/config\"]",
            Blocked = true,
        });

        Assert.Equal((4L, "app", AttackKind.Scan, "203.0.113.7", 10L, 20L, 33, true, "DE"), (info.Id, info.SiteId, info.Kind, info.Address, info.FirstSeenAtUnixMs, info.LastSeenAtUnixMs, info.Count, info.Blocked, info.Country));
        Assert.Equal(["/.env", "/.git/config"], info.SamplePaths);
    }

    [Fact]
    public void A_block_reaches_the_app()
    {
        var info = TrafficMapper.ToInfo(new BlockedAddress
        {
            Id = 9,
            Network = "198.51.100.0/24",
            Reason = "Scan on app.example.com",
            Automatic = true,
            CreatedAt = 100,
            SiteId = "app",
            ExpiresAt = 200,
        });

        Assert.Equal(new BlockedAddressInfo(9, "198.51.100.0/24", "Scan on app.example.com", true, 100, "app", null, 200), info);
    }
}
