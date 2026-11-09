using Microsoft.EntityFrameworkCore;
using Runova.Website.Data.Accounts;
using Runova.Website.Data.Identity;

namespace Runova.Website.Data.Dependencies;

/// <summary>The tables behind dependency alerts (E51): inventories, registry caches, findings, settings, notifications and Telegram.</summary>
internal static class DependenciesModel
{
    public static void ConfigureDependencies(this ModelBuilder builder)
    {
        builder.Entity<PackageInventory>(inventory =>
        {
            inventory.Property(i => i.ItemId).HasMaxLength(64);
            inventory.Property(i => i.ProjectName).HasMaxLength(200);
            inventory.Property(i => i.ContentHash).HasMaxLength(64);
            inventory.Property(i => i.Version).IsRowVersion();
            inventory.HasIndex(i => new { i.ScopeId, i.ItemId }).IsUnique();
            inventory.HasIndex(i => i.NextCheckAt);
            inventory.HasOne<SyncScope>().WithMany().HasForeignKey(i => i.ScopeId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<InventoryPackage>(package =>
        {
            package.Property(p => p.Ecosystem).HasMaxLength(8);
            package.Property(p => p.Name).HasMaxLength(214);
            package.Property(p => p.Version).HasMaxLength(100);
            package.HasIndex(p => p.InventoryId);
            package.HasOne<PackageInventory>().WithMany().HasForeignKey(p => p.InventoryId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<PackageFacts>(facts =>
        {
            facts.Property(f => f.Ecosystem).HasMaxLength(8);
            facts.Property(f => f.Name).HasMaxLength(214);
            facts.Property(f => f.LatestVersion).HasMaxLength(100);
            facts.Property(f => f.Deprecated).HasMaxLength(500);
            facts.HasIndex(f => new { f.Ecosystem, f.Name }).IsUnique();
        });

        builder.Entity<AdvisoryLookup>(lookup =>
        {
            lookup.Property(l => l.Ecosystem).HasMaxLength(8);
            lookup.Property(l => l.Name).HasMaxLength(214);
            lookup.Property(l => l.Version).HasMaxLength(100);
            lookup.Property(l => l.Advisories).HasColumnType("jsonb");
            lookup.HasIndex(l => new { l.Ecosystem, l.Name, l.Version }).IsUnique();
        });

        builder.Entity<DependencyFinding>(finding =>
        {
            finding.Property(f => f.Ecosystem).HasMaxLength(8);
            finding.Property(f => f.Name).HasMaxLength(214);
            finding.Property(f => f.Kind).HasMaxLength(16);
            finding.Property(f => f.CurrentVersion).HasMaxLength(100);
            finding.Property(f => f.TargetVersion).HasMaxLength(100);
            finding.Property(f => f.AdvisoryId).HasMaxLength(64);
            finding.Property(f => f.Severity).HasMaxLength(16);
            finding.Property(f => f.Summary).HasMaxLength(500);
            finding.Property(f => f.Key).HasMaxLength(400);
            finding.HasIndex(f => new { f.InventoryId, f.Key }).IsUnique();
            finding.HasOne<PackageInventory>().WithMany().HasForeignKey(f => f.InventoryId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<DependencyAlertSettings>(settings =>
        {
            settings.HasKey(s => s.UserId);
            settings.Property(s => s.SecurityMinSeverity).HasMaxLength(16);
            settings.Property(s => s.Version).IsRowVersion();
            settings.HasOne<AppUser>().WithMany().HasForeignKey(s => s.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<MutedProject>(muted =>
        {
            muted.HasKey(m => new { m.UserId, m.InventoryId });
            muted.HasOne<AppUser>().WithMany().HasForeignKey(m => m.UserId).OnDelete(DeleteBehavior.Cascade);
            muted.HasOne<PackageInventory>().WithMany().HasForeignKey(m => m.InventoryId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<DependencyAlertDelivery>(delivery =>
        {
            delivery.HasKey(d => new { d.UserId, d.Key });
            delivery.Property(d => d.Key).HasMaxLength(400);
            delivery.HasOne<AppUser>().WithMany().HasForeignKey(d => d.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<UserNotification>(notification =>
        {
            notification.Property(n => n.Kind).HasMaxLength(32);
            notification.Property(n => n.Title).HasMaxLength(300);
            notification.Property(n => n.Severity).HasMaxLength(16);
            notification.Property(n => n.ItemId).HasMaxLength(64);
            notification.Property(n => n.Sealed).HasColumnType("jsonb");
            notification.HasIndex(n => new { n.UserId, n.CreatedAt });
            notification.HasIndex(n => new { n.UserId, n.ReadAt });
            notification.HasOne<AppUser>().WithMany().HasForeignKey(n => n.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<TelegramLink>(link =>
        {
            link.HasKey(l => l.UserId);
            link.Property(l => l.ChatName).HasMaxLength(100);
            link.HasIndex(l => l.ChatId);
            link.HasOne<AppUser>().WithMany().HasForeignKey(l => l.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<TelegramLinkCode>(code =>
        {
            code.Property(c => c.CodeHash).HasMaxLength(64);
            code.HasIndex(c => c.CodeHash).IsUnique();
            code.HasIndex(c => c.ExpiresAt);
            code.HasOne<AppUser>().WithMany().HasForeignKey(c => c.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<TelegramMessage>(message =>
        {
            message.Property(m => m.LastError).HasMaxLength(500);
            message.HasIndex(m => new { m.SentAt, m.NextAttemptAt });
        });
    }
}
