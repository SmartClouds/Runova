using Microsoft.EntityFrameworkCore;
using Runova.Website.Data.Accounts;
using Runova.Website.Data.Identity;

namespace Runova.Website.Data.Notifications;

/// <summary>The tables behind push notifications (E82): each session's phone and each account's categories.</summary>
internal static class NotificationsModel
{
    public static void ConfigureNotifications(this ModelBuilder builder)
    {
        builder.Entity<PushDevice>(device =>
        {
            device.Property(d => d.Platform).HasMaxLength(16);
            device.Property(d => d.PushToken).HasMaxLength(1024);
            device.HasIndex(d => d.SessionId).IsUnique();
            device.HasIndex(d => d.PushToken).IsUnique();
            device.HasIndex(d => d.UserId);
            device.HasOne<AppUser>().WithMany().HasForeignKey(d => d.UserId).OnDelete(DeleteBehavior.Cascade);
            device.HasOne<AccountSession>().WithMany().HasForeignKey(d => d.SessionId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<NotificationPreference>(preference =>
        {
            preference.HasKey(p => new { p.UserId, p.Category });
            preference.Property(p => p.Category).HasMaxLength(32);
            preference.HasOne<AppUser>().WithMany().HasForeignKey(p => p.UserId).OnDelete(DeleteBehavior.Cascade);
        });
    }
}
