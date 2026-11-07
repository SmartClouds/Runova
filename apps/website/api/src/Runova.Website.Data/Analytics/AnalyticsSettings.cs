namespace Runova.Website.Data.Analytics;

/// <summary>
/// The Admin's tracking tags and site verifications for the public site (E59): Google Analytics,
/// Google Ads, Google Tag Manager, Microsoft Clarity and the Microsoft Ads (Bing) UET tag, the
/// Search Console and Bing Webmaster verification codes, and the cookie consent banner. One row,
/// id 1, made by the migration. Nothing here is secret: every value ends up in public pages.
/// </summary>
public sealed class AnalyticsSettings
{
    public const int SingletonId = 1;

    public const int MaxIds = 5;
    public const int MaxGoogleAnalyticsId = 22;
    public const int MaxGoogleAdsId = 18;
    public const int MaxGoogleTagManagerId = 16;
    public const int MaxClarityProjectId = 20;
    public const int MaxBingUetTagId = 12;
    public const int MaxGoogleSiteVerification = 60;
    public const int MaxBingSiteVerification = 64;

    public int Id { get; set; } = SingletonId;

    /// <summary>Whether the public pages load the tracking tags. The verifications are served either way.</summary>
    public bool TagsEnabled { get; set; }

    /// <summary>Google Analytics 4 measurement IDs, such as <c>G-ABC123XYZ9</c>.</summary>
    public string[] GoogleAnalyticsIds { get; set; } = [];

    /// <summary>Google Ads tags, such as <c>AW-123456789</c>.</summary>
    public string[] GoogleAdsIds { get; set; } = [];

    /// <summary>A Google Tag Manager container, such as <c>GTM-ABC1234</c>.</summary>
    public string? GoogleTagManagerId { get; set; }

    /// <summary>A Microsoft Clarity project ID, in lower case.</summary>
    public string? ClarityProjectId { get; set; }

    /// <summary>A Microsoft Advertising UET tag ID, digits only.</summary>
    public string? BingUetTagId { get; set; }

    /// <summary>The name of Search Console's HTML verification file without <c>.html</c>, such as <c>google1234567890abcdef</c>.</summary>
    public string? GoogleSiteVerification { get; set; }

    /// <summary>The Bing Webmaster Tools code that <c>/BingSiteAuth.xml</c> carries.</summary>
    public string? BingSiteVerification { get; set; }

    /// <summary>Whether the public pages ask each visitor first and load no tag until they allow it.</summary>
    public bool ConsentBannerEnabled { get; set; }

    public DateTimeOffset? UpdatedAt { get; set; }

    public uint Version { get; set; }
}
