using System.Globalization;
using Riok.Mapperly.Abstractions;
using Runova.Website.Data.Analytics;

namespace Runova.Website.Api.Analytics;

/// <summary>The analytics settings as an Admin sees them.</summary>
public sealed record AnalyticsSettingsDto(
    bool TagsEnabled,
    string[] GoogleAnalyticsIds,
    string[] GoogleAdsIds,
    string? GoogleTagManagerId,
    string? ClarityProjectId,
    string? BingUetTagId,
    string? GoogleSiteVerification,
    string? BingSiteVerification,
    bool ConsentBannerEnabled,
    DateTimeOffset? UpdatedAt,
    string Version);

/// <summary>A merge patch of the settings. null or empty removes a value; a list is replaced whole.</summary>
public sealed record AnalyticsSettingsPatch(
    bool? TagsEnabled,
    string[]? GoogleAnalyticsIds,
    string[]? GoogleAdsIds,
    string? GoogleTagManagerId,
    string? ClarityProjectId,
    string? BingUetTagId,
    string? GoogleSiteVerification,
    string? BingSiteVerification,
    bool? ConsentBannerEnabled);

/// <summary>
/// What the public site reads: the tags to load (empty while they are off), whether to ask the
/// visitor first, and the verification codes, which are served whether the tags are on or not.
/// </summary>
public sealed record SiteAnalyticsDto(
    string[] GoogleAnalyticsIds,
    string[] GoogleAdsIds,
    string? GoogleTagManagerId,
    string? ClarityProjectId,
    string? BingUetTagId,
    bool ConsentRequired,
    string? GoogleSiteVerification,
    string? BingSiteVerification);

/// <summary>The settings an Admin can change, as a patch is checked against them.</summary>
internal sealed record AnalyticsValues(
    bool TagsEnabled,
    string[] GoogleAnalyticsIds,
    string[] GoogleAdsIds,
    string? GoogleTagManagerId,
    string? ClarityProjectId,
    string? BingUetTagId,
    string? GoogleSiteVerification,
    string? BingSiteVerification,
    bool ConsentBannerEnabled)
{
    /// <summary>Whether any tracking tag is set; the verifications are not tags.</summary>
    public bool HasTag =>
        GoogleAnalyticsIds.Length > 0 || GoogleAdsIds.Length > 0 || GoogleTagManagerId is not null || ClarityProjectId is not null || BingUetTagId is not null;

    /// <summary>The names of the fields that differ, for the audit entry.</summary>
    public List<string> ChangedFrom(AnalyticsValues before)
    {
        var changed = new List<string>();
        if (TagsEnabled != before.TagsEnabled) changed.Add("tagsEnabled");
        if (!GoogleAnalyticsIds.SequenceEqual(before.GoogleAnalyticsIds, StringComparer.Ordinal)) changed.Add("googleAnalyticsIds");
        if (!GoogleAdsIds.SequenceEqual(before.GoogleAdsIds, StringComparer.Ordinal)) changed.Add("googleAdsIds");
        if (GoogleTagManagerId != before.GoogleTagManagerId) changed.Add("googleTagManagerId");
        if (ClarityProjectId != before.ClarityProjectId) changed.Add("clarityProjectId");
        if (BingUetTagId != before.BingUetTagId) changed.Add("bingUetTagId");
        if (GoogleSiteVerification != before.GoogleSiteVerification) changed.Add("googleSiteVerification");
        if (BingSiteVerification != before.BingSiteVerification) changed.Add("bingSiteVerification");
        if (ConsentBannerEnabled != before.ConsentBannerEnabled) changed.Add("consentBannerEnabled");
        return changed;
    }
}

[Mapper(RequiredMappingStrategy = RequiredMappingStrategy.Target)]
internal static partial class AnalyticsMapper
{
    public static partial AnalyticsSettingsDto ToDto(AnalyticsSettings settings);

    /// <summary>The public answer: the tags only while they are on and there is one, the verifications always.</summary>
    [MapPropertyFromSource(nameof(SiteAnalyticsDto.GoogleAnalyticsIds), Use = nameof(LiveGoogleAnalyticsIds))]
    [MapPropertyFromSource(nameof(SiteAnalyticsDto.GoogleAdsIds), Use = nameof(LiveGoogleAdsIds))]
    [MapPropertyFromSource(nameof(SiteAnalyticsDto.GoogleTagManagerId), Use = nameof(LiveGoogleTagManagerId))]
    [MapPropertyFromSource(nameof(SiteAnalyticsDto.ClarityProjectId), Use = nameof(LiveClarityProjectId))]
    [MapPropertyFromSource(nameof(SiteAnalyticsDto.BingUetTagId), Use = nameof(LiveBingUetTagId))]
    [MapPropertyFromSource(nameof(SiteAnalyticsDto.ConsentRequired), Use = nameof(ConsentRequired))]
    public static partial SiteAnalyticsDto ToSiteDto(AnalyticsSettings settings);

    public static partial AnalyticsValues ToValues(AnalyticsSettings settings);

    [MapperIgnoreTarget(nameof(AnalyticsSettings.Id))]
    [MapperIgnoreTarget(nameof(AnalyticsSettings.UpdatedAt))]
    [MapperIgnoreTarget(nameof(AnalyticsSettings.Version))]
    public static partial void ApplyTo(AnalyticsValues values, AnalyticsSettings settings);

    private static bool IsLive(AnalyticsSettings settings) => settings.TagsEnabled && ToValues(settings).HasTag;

    private static string[] LiveGoogleAnalyticsIds(AnalyticsSettings settings) => IsLive(settings) ? settings.GoogleAnalyticsIds : [];

    private static string[] LiveGoogleAdsIds(AnalyticsSettings settings) => IsLive(settings) ? settings.GoogleAdsIds : [];

    private static string? LiveGoogleTagManagerId(AnalyticsSettings settings) => IsLive(settings) ? settings.GoogleTagManagerId : null;

    private static string? LiveClarityProjectId(AnalyticsSettings settings) => IsLive(settings) ? settings.ClarityProjectId : null;

    private static string? LiveBingUetTagId(AnalyticsSettings settings) => IsLive(settings) ? settings.BingUetTagId : null;

    private static bool ConsentRequired(AnalyticsSettings settings) => IsLive(settings) && settings.ConsentBannerEnabled;

    private static string VersionToString(uint version) => version.ToString(CultureInfo.InvariantCulture);
}
