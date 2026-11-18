using System.Text.Json;
using Riok.Mapperly.Abstractions;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Traffic;

/// <summary>
/// Traffic settings (E109, E110) between their row and the app's records, and attack events and
/// blocks as the app shows them. Lists are kept in the row as JSON arrays.
/// </summary>
[Mapper]
internal static partial class TrafficMapper
{
    /// <summary>ReadExistingLogs only means something on the save that turns statistics on.</summary>
    [MapProperty(nameof(TrafficSetting.ExcludedSites), nameof(TrafficSettings.ExcludedSites), Use = nameof(ReadStrings))]
    [MapValue(nameof(TrafficSettings.ReadExistingLogs), false)]
    public static partial TrafficSettings ToSettings(TrafficSetting row);

    [MapProperty(nameof(TrafficSetting.AttackEnabled), nameof(AttackSettings.Enabled))]
    [MapPropertyFromSource(nameof(AttackSettings.Thresholds), Use = nameof(ToThresholds))]
    [MapProperty(nameof(TrafficSetting.Allowlist), nameof(AttackSettings.Allowlist), Use = nameof(ReadStrings))]
    public static partial AttackSettings ToAttacks(TrafficSetting row);

    [MapProperty(nameof(TrafficSetting.AutoBlockEnabled), nameof(AutoBlockSettings.Enabled))]
    [MapProperty(nameof(TrafficSetting.AutoBlockKinds), nameof(AutoBlockSettings.Kinds), Use = nameof(ReadKinds))]
    [MapProperty(nameof(TrafficSetting.AutoBlockMinutes), nameof(AutoBlockSettings.Minutes))]
    [MapProperty(nameof(TrafficSetting.AutoBlockMaxBlocked), nameof(AutoBlockSettings.MaxBlocked))]
    public static partial AutoBlockSettings ToAutoBlock(TrafficSetting row);

    /// <summary>The settings row with what only the caller knows: each site, the country file and the storage used.</summary>
    [MapPropertyFromSource(nameof(TrafficStatus.Settings), Use = nameof(ToSettings))]
    [MapPropertyFromSource(nameof(TrafficStatus.Attacks), Use = nameof(ToAttacks))]
    [MapPropertyFromSource(nameof(TrafficStatus.AutoBlock), Use = nameof(ToAutoBlock))]
    [MapProperty(nameof(TrafficSetting.EnabledAt), nameof(TrafficStatus.CollectingSinceUnixMs))]
    [MapProperty(nameof(TrafficSetting.ChangedAt), nameof(TrafficStatus.ChangedAtUnixMs))]
    public static partial TrafficStatus ToStatus(
        TrafficSetting row,
        TrafficSiteStatus[] sites,
        bool geoDatabaseReady,
        long storageBytes,
        string defaultTimeZone,
        long? geoDatabaseUpdatedAtUnixMs,
        string? geoDatabaseProblem);

    [MapperRequiredMapping(RequiredMappingStrategy.Source)]
    [MapperIgnoreSource(nameof(TrafficSettings.ReadExistingLogs))]
    [MapProperty(nameof(TrafficSettings.ExcludedSites), nameof(TrafficSetting.ExcludedSites), Use = nameof(WriteStrings))]
    public static partial void Apply(TrafficSettings source, TrafficSetting target);

    [MapperRequiredMapping(RequiredMappingStrategy.Source)]
    [MapperIgnoreTarget(nameof(TrafficSetting.Enabled))]
    [MapProperty(nameof(AttackSettings.Enabled), nameof(TrafficSetting.AttackEnabled))]
    [MapNestedProperties(nameof(AttackSettings.Thresholds))]
    [MapProperty(nameof(AttackSettings.Allowlist), nameof(TrafficSetting.Allowlist), Use = nameof(WriteStrings))]
    public static partial void Apply(AttackSettings source, TrafficSetting target);

    [MapperRequiredMapping(RequiredMappingStrategy.Source)]
    [MapperIgnoreTarget(nameof(TrafficSetting.Enabled))]
    [MapProperty(nameof(AutoBlockSettings.Enabled), nameof(TrafficSetting.AutoBlockEnabled))]
    [MapProperty(nameof(AutoBlockSettings.Kinds), nameof(TrafficSetting.AutoBlockKinds), Use = nameof(WriteKinds))]
    [MapProperty(nameof(AutoBlockSettings.Minutes), nameof(TrafficSetting.AutoBlockMinutes))]
    [MapProperty(nameof(AutoBlockSettings.MaxBlocked), nameof(TrafficSetting.AutoBlockMaxBlocked))]
    public static partial void Apply(AutoBlockSettings source, TrafficSetting target);

    [MapProperty(nameof(AttackEvent.FirstSeenAt), nameof(AttackEventInfo.FirstSeenAtUnixMs))]
    [MapProperty(nameof(AttackEvent.LastSeenAt), nameof(AttackEventInfo.LastSeenAtUnixMs))]
    [MapProperty(nameof(AttackEvent.SamplePaths), nameof(AttackEventInfo.SamplePaths), Use = nameof(ReadStrings))]
    public static partial AttackEventInfo ToInfo(AttackEvent row);

    /// <summary>CreatedBy is the name of whoever blocked it; automatic blocks have none.</summary>
    [MapProperty(nameof(BlockedAddress.CreatedAt), nameof(BlockedAddressInfo.CreatedAtUnixMs))]
    [MapProperty(nameof(BlockedAddress.ExpiresAt), nameof(BlockedAddressInfo.ExpiresAtUnixMs))]
    public static partial BlockedAddressInfo ToInfo(BlockedAddress row);

    /// <summary>The flat threshold columns as the app's record.</summary>
    private static partial AttackThresholds ToThresholds(TrafficSetting row);

    public static string[] ReadStrings(string json) =>
        string.IsNullOrEmpty(json) ? [] : JsonSerializer.Deserialize<string[]>(json, CoreJson.Options) ?? [];

    public static string WriteStrings(string[] values) => JsonSerializer.Serialize(values ?? [], CoreJson.Options);

    private static AttackKind[] ReadKinds(string json) =>
        string.IsNullOrEmpty(json) ? [] : JsonSerializer.Deserialize<AttackKind[]>(json, CoreJson.Options) ?? [];

    private static string WriteKinds(AttackKind[] kinds) => JsonSerializer.Serialize(kinds ?? [], CoreJson.Options);
}
