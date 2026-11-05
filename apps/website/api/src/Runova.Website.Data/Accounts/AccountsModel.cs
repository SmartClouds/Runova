using Microsoft.EntityFrameworkCore;
using Runova.Website.Data.Email;
using Runova.Website.Data.Identity;

namespace Runova.Website.Data.Accounts;

/// <summary>The tables behind Runova accounts (E48): the email outbox, sessions, activity, sync and teams.</summary>
internal static class AccountsModel
{
    public static void ConfigureAccounts(this ModelBuilder builder)
    {
        builder.Entity<EmailMessage>(message =>
        {
            message.Property(m => m.To).HasMaxLength(320);
            message.Property(m => m.Kind).HasMaxLength(32);
            message.Property(m => m.Subject).HasMaxLength(200);
            message.Property(m => m.LastError).HasMaxLength(500);
            message.HasIndex(m => new { m.SentAt, m.NextAttemptAt });
            message.HasIndex(m => m.To);
        });

        builder.Entity<AccountSession>(session =>
        {
            session.Property(s => s.Kind).HasMaxLength(16);
            session.Property(s => s.DeviceName).HasMaxLength(100);
            session.Property(s => s.Platform).HasMaxLength(32);
            session.Property(s => s.AppVersion).HasMaxLength(32);
            session.Property(s => s.UserAgent).HasMaxLength(300);
            session.Property(s => s.CreatedIp).HasMaxLength(45);
            session.Property(s => s.LastIp).HasMaxLength(45);
            session.HasIndex(s => new { s.UserId, s.RevokedAt });
            session.HasIndex(s => s.RefreshTokenHash).IsUnique();
            session.HasIndex(s => s.PreviousRefreshTokenHash);
            session.HasOne<AppUser>().WithMany().HasForeignKey(s => s.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<DeviceAuthorization>(approval =>
        {
            approval.Property(a => a.CodeChallenge).HasMaxLength(128);
            approval.Property(a => a.RedirectUri).HasMaxLength(200);
            approval.Property(a => a.DeviceName).HasMaxLength(100);
            approval.Property(a => a.Platform).HasMaxLength(32);
            approval.Property(a => a.AppVersion).HasMaxLength(32);
            approval.HasIndex(a => a.CodeHash).IsUnique();
            approval.HasIndex(a => a.ExpiresAt);
            approval.HasOne<AppUser>().WithMany().HasForeignKey(a => a.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<AccountActivity>(activity =>
        {
            activity.Property(a => a.Action).HasMaxLength(48);
            activity.Property(a => a.Ip).HasMaxLength(45);
            activity.Property(a => a.Device).HasMaxLength(100);
            activity.Property(a => a.Details).HasColumnType("jsonb");
            activity.HasIndex(a => new { a.UserId, a.At });
            activity.HasIndex(a => new { a.TeamId, a.At });
            activity.HasOne<AppUser>().WithMany().HasForeignKey(a => a.UserId).OnDelete(DeleteBehavior.Cascade);
        });
    }
}
