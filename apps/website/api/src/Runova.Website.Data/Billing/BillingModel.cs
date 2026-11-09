using Microsoft.EntityFrameworkCore;
using Runova.Website.Data.Identity;

namespace Runova.Website.Data.Billing;

/// <summary>The tables behind account types and payments (E53).</summary>
internal static class BillingModel
{
    // Fixed stamps, so the seed does not change from one migration to the next.
    private static readonly DateTimeOffset _seededAt = new(2026, 11, 6, 0, 0, 0, TimeSpan.Zero);

    public static void ConfigureBilling(this ModelBuilder builder)
    {
        builder.Entity<AccountType>(type =>
        {
            // The seed takes ids 1 to 4; types an Admin adds start after them.
            type.Property(t => t.Id).HasIdentityOptions(startValue: 100);
            type.Property(t => t.Key).HasMaxLength(32);
            type.Property(t => t.Name).HasMaxLength(60);
            type.Property(t => t.Description).HasMaxLength(500);
            type.Property(t => t.Currency).HasMaxLength(3);
            type.Property(t => t.StripeProductId).HasMaxLength(100);
            type.Property(t => t.StripeMonthlyPriceId).HasMaxLength(100);
            type.Property(t => t.StripeYearlyPriceId).HasMaxLength(100);
            type.Property(t => t.Version).IsRowVersion();
            type.HasIndex(t => t.Key).IsUnique();
            type.HasIndex(t => t.IsFree).IsUnique().HasFilter("\"IsFree\"");
            type.HasData(Seed());
        });

        builder.Entity<Subscription>(subscription =>
        {
            subscription.Property(s => s.Provider).HasMaxLength(16);
            subscription.Property(s => s.ProviderRef).HasMaxLength(100);
            subscription.Property(s => s.Status).HasMaxLength(16);
            subscription.Property(s => s.Version).IsRowVersion();
            // At most one subscription that gives an account its type.
            subscription.HasIndex(s => s.UserId).IsUnique().HasFilter("\"Status\" IN ('active', 'past_due')");
            subscription.HasIndex(s => new { s.Provider, s.ProviderRef }).IsUnique().HasFilter("\"ProviderRef\" IS NOT NULL");
            subscription.HasIndex(s => new { s.Status, s.CurrentPeriodEnd });
            subscription.HasOne<AppUser>().WithMany().HasForeignKey(s => s.UserId).OnDelete(DeleteBehavior.Cascade);
            subscription.HasOne<AccountType>().WithMany().HasForeignKey(s => s.AccountTypeId).OnDelete(DeleteBehavior.Restrict);
        });

        builder.Entity<BillingCustomer>(customer =>
        {
            customer.HasKey(c => c.UserId);
            customer.Property(c => c.StripeCustomerId).HasMaxLength(100);
            customer.HasIndex(c => c.StripeCustomerId).IsUnique();
            customer.HasOne<AppUser>().WithMany().HasForeignKey(c => c.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<Payment>(payment =>
        {
            payment.Property(p => p.Provider).HasMaxLength(16);
            payment.Property(p => p.OrderId).HasMaxLength(64);
            payment.Property(p => p.ProviderPaymentId).HasMaxLength(100);
            payment.Property(p => p.Currency).HasMaxLength(3);
            payment.Property(p => p.Status).HasMaxLength(16);
            payment.Property(p => p.ProviderStatus).HasMaxLength(32);
            payment.Property(p => p.InvoiceUrl).HasMaxLength(500);
            payment.HasIndex(p => p.OrderId).IsUnique();
            payment.HasIndex(p => new { p.Provider, p.ProviderPaymentId }).IsUnique().HasFilter("\"ProviderPaymentId\" IS NOT NULL");
            payment.HasIndex(p => new { p.UserId, p.CreatedAt });
            payment.HasOne<AppUser>().WithMany().HasForeignKey(p => p.UserId).OnDelete(DeleteBehavior.Cascade);
            payment.HasOne<AccountType>().WithMany().HasForeignKey(p => p.AccountTypeId).OnDelete(DeleteBehavior.Restrict);
        });

        builder.Entity<ProcessedPaymentEvent>(processed =>
        {
            processed.HasKey(e => new { e.Provider, e.EventId });
            processed.Property(e => e.Provider).HasMaxLength(16);
            processed.Property(e => e.EventId).HasMaxLength(100);
        });

        builder.Entity<PaymentSettings>(settings =>
        {
            settings.Property(s => s.Id).ValueGeneratedNever();
            settings.ToTable(t => t.HasCheckConstraint("CK_PaymentSettings_Singleton", $"\"Id\" = {PaymentSettings.SingletonId}"));
            settings.Property(s => s.StripePublishableKey).HasMaxLength(200);
            settings.Property(s => s.Version).IsRowVersion();
            settings.HasData(new PaymentSettings());
        });
    }

    private static AccountType[] Seed() =>
    [
        new()
        {
            Id = AccountType.FreeId, Key = "free", Name = "Free", SortOrder = 0, IsFree = true,
            Description = "Try online monitoring on one endpoint.",
            Features = ["1 online monitor", "Checks every 5 minutes", "7 days of detailed history", "Alerts in the app and on Telegram"],
            MaxCloudMonitors = 1, MinIntervalSec = 300, HistoryDays = 7, CreatedAt = _seededAt,
        },
        new()
        {
            Id = 2, Key = "go", Name = "Go", SortOrder = 1,
            Description = "For a few projects that should never go quiet.",
            Features = ["10 online monitors", "Checks every 5 minutes", "30 days of detailed history", "Alerts in the app and on Telegram"],
            MaxCloudMonitors = 10, MinIntervalSec = 300, HistoryDays = 30, EncryptedItems = true, MonthlyPriceCents = 500, YearlyPriceCents = 5000, CreatedAt = _seededAt,
        },
        new()
        {
            Id = 3, Key = "pro", Name = "Pro", SortOrder = 2, Highlight = true,
            Description = "Every project you run, checked every minute.",
            Features = ["50 online monitors", "Checks every minute", "90 days of detailed history", "Second opinion from another region"],
            MaxCloudMonitors = 50, MinIntervalSec = 60, HistoryDays = 90, EncryptedItems = true, MonthlyPriceCents = 1500, YearlyPriceCents = 15000, CreatedAt = _seededAt,
        },
        new()
        {
            Id = 4, Key = "ultra", Name = "Ultra", SortOrder = 3,
            Description = "No limits, and the fastest checks Runova makes.",
            Features = ["Unlimited online monitors", "Checks every 30 seconds", "A year of detailed history", "Second opinion from another region"],
            MaxCloudMonitors = null, MinIntervalSec = 30, HistoryDays = 365, EncryptedItems = true, MonthlyPriceCents = 4900, YearlyPriceCents = 49000, CreatedAt = _seededAt,
        },
    ];
}
