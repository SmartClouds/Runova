using Runova.Website.Api.Analytics;
using Runova.Website.Data.Analytics;

namespace Runova.Website.IntegrationTests.Analytics;

/// <summary>The analytics mapper on its own, with no host or database.</summary>
public sealed class AnalyticsMapperTests
{
    private static AnalyticsSettings Row(bool tagsEnabled = true) => new()
    {
        TagsEnabled = tagsEnabled,
        GoogleAnalyticsIds = ["G-ABC123XYZ9"],
        GoogleAdsIds = ["AW-123456789"],
        GoogleTagManagerId = "GTM-ABC1234",
        ClarityProjectId = "abcd1234ef",
        BingUetTagId = "187654321",
        GoogleSiteVerification = "google1234567890abcdef",
        BingSiteVerification = "0123456789ABCDEF",
        ConsentBannerEnabled = true,
        UpdatedAt = new DateTimeOffset(2026, 11, 7, 10, 0, 0, TimeSpan.Zero),
        Version = 1234,
    };

    [Fact]
    public void The_admin_dto_has_every_setting_and_the_version_as_text()
    {
        var dto = AnalyticsMapper.ToDto(Row());

        Assert.True(dto.TagsEnabled);
        Assert.Equal(["G-ABC123XYZ9"], dto.GoogleAnalyticsIds);
        Assert.Equal(["AW-123456789"], dto.GoogleAdsIds);
        Assert.Equal("GTM-ABC1234", dto.GoogleTagManagerId);
        Assert.Equal("abcd1234ef", dto.ClarityProjectId);
        Assert.Equal("187654321", dto.BingUetTagId);
        Assert.Equal("google1234567890abcdef", dto.GoogleSiteVerification);
        Assert.Equal("0123456789ABCDEF", dto.BingSiteVerification);
        Assert.True(dto.ConsentBannerEnabled);
        Assert.Equal(new DateTimeOffset(2026, 11, 7, 10, 0, 0, TimeSpan.Zero), dto.UpdatedAt);
        Assert.Equal("1234", dto.Version);
    }

    [Fact]
    public void The_site_gets_the_tags_and_the_consent_switch_while_they_are_on()
    {
        var dto = AnalyticsMapper.ToSiteDto(Row());

        Assert.Equal(["G-ABC123XYZ9"], dto.GoogleAnalyticsIds);
        Assert.Equal(["AW-123456789"], dto.GoogleAdsIds);
        Assert.Equal("GTM-ABC1234", dto.GoogleTagManagerId);
        Assert.Equal("abcd1234ef", dto.ClarityProjectId);
        Assert.Equal("187654321", dto.BingUetTagId);
        Assert.True(dto.ConsentRequired);
        Assert.Equal("google1234567890abcdef", dto.GoogleSiteVerification);
        Assert.Equal("0123456789ABCDEF", dto.BingSiteVerification);
    }

    [Fact]
    public void With_the_tags_off_the_site_gets_only_the_verifications()
    {
        var dto = AnalyticsMapper.ToSiteDto(Row(tagsEnabled: false));

        Assert.Empty(dto.GoogleAnalyticsIds);
        Assert.Empty(dto.GoogleAdsIds);
        Assert.Null(dto.GoogleTagManagerId);
        Assert.Null(dto.ClarityProjectId);
        Assert.Null(dto.BingUetTagId);
        Assert.False(dto.ConsentRequired);
        Assert.Equal("google1234567890abcdef", dto.GoogleSiteVerification);
        Assert.Equal("0123456789ABCDEF", dto.BingSiteVerification);
    }

    [Fact]
    public void Values_round_trip_onto_a_row_and_leave_its_id_time_and_version_alone()
    {
        var values = AnalyticsMapper.ToValues(Row()) with { ClarityProjectId = null, GoogleAdsIds = [] };
        var row = new AnalyticsSettings { UpdatedAt = null, Version = 7 };

        AnalyticsMapper.ApplyTo(values, row);

        Assert.Equal(AnalyticsSettings.SingletonId, row.Id);
        Assert.Null(row.UpdatedAt);
        Assert.Equal(7u, row.Version);
        Assert.Equal(values, AnalyticsMapper.ToValues(row));
        Assert.Equal(["clarityProjectId", "googleAdsIds"], values.ChangedFrom(AnalyticsMapper.ToValues(Row())).Order(StringComparer.Ordinal));
    }
}
