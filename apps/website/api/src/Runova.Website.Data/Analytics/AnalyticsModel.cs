using Microsoft.EntityFrameworkCore;

namespace Runova.Website.Data.Analytics;

/// <summary>The table behind the site's analytics settings.</summary>
internal static class AnalyticsModel
{
    public static void ConfigureAnalytics(this ModelBuilder builder)
    {
        builder.Entity<AnalyticsSettings>(settings =>
        {
            settings.Property(s => s.Id).ValueGeneratedNever();
            settings.ToTable(t => t.HasCheckConstraint("CK_AnalyticsSettings_Singleton", $"\"Id\" = {AnalyticsSettings.SingletonId}"));
            settings.Property(s => s.GoogleTagManagerId).HasMaxLength(AnalyticsSettings.MaxGoogleTagManagerId);
            settings.Property(s => s.ClarityProjectId).HasMaxLength(AnalyticsSettings.MaxClarityProjectId);
            settings.Property(s => s.BingUetTagId).HasMaxLength(AnalyticsSettings.MaxBingUetTagId);
            settings.Property(s => s.GoogleSiteVerification).HasMaxLength(AnalyticsSettings.MaxGoogleSiteVerification);
            settings.Property(s => s.BingSiteVerification).HasMaxLength(AnalyticsSettings.MaxBingSiteVerification);
            settings.Property(s => s.Version).IsRowVersion();
            settings.HasData(new AnalyticsSettings());
        });
    }
}
