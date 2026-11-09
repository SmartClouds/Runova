using Microsoft.EntityFrameworkCore;
using Runova.Website.Data.Email;
using Runova.Website.Data.Identity;

namespace Runova.Website.Data.Accounts;

/// <summary>The tables behind Runova accounts (E48): the email outbox, sessions, activity, sync and teams.</summary>
internal static class AccountsModel
{
    public static void ConfigureAccounts(this ModelBuilder builder)
    {
        builder.Entity<SignInSettings>(settings =>
        {
            settings.Property(s => s.Id).ValueGeneratedNever();
            settings.ToTable(t => t.HasCheckConstraint("CK_SignInSettings_Singleton", $"\"Id\" = {SignInSettings.SingletonId}"));
            settings.Property(s => s.TurnstileSiteKey).HasMaxLength(100);
            settings.Property(s => s.GoogleClientId).HasMaxLength(300);
            settings.Property(s => s.Version).IsRowVersion();
            settings.HasData(new SignInSettings());
        });

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

        builder.Entity<Team>(team =>
        {
            team.Property(t => t.Name).HasMaxLength(80);
            team.Property(t => t.Version).IsRowVersion();
        });

        builder.Entity<TeamMember>(member =>
        {
            member.HasKey(m => new { m.TeamId, m.UserId });
            member.Property(m => m.Role).HasMaxLength(16);
            member.HasIndex(m => m.UserId);
            member.HasOne<Team>().WithMany().HasForeignKey(m => m.TeamId).OnDelete(DeleteBehavior.Cascade);
            member.HasOne<AppUser>().WithMany().HasForeignKey(m => m.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<TeamInvitation>(invitation =>
        {
            invitation.Property(i => i.Email).HasMaxLength(320);
            invitation.Property(i => i.NormalizedEmail).HasMaxLength(320);
            invitation.Property(i => i.Role).HasMaxLength(16);
            invitation.HasIndex(i => new { i.NormalizedEmail, i.ExpiresAt });
            invitation.HasIndex(i => i.TeamId);
            invitation.HasOne<Team>().WithMany().HasForeignKey(i => i.TeamId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<SyncScope>(scope =>
        {
            scope.HasOne<Team>().WithMany().HasForeignKey(s => s.TeamId).OnDelete(DeleteBehavior.Cascade);
            scope.Property(s => s.Kind).HasMaxLength(16);
            scope.Property(s => s.KeyEnvelope).HasColumnType("jsonb");
            scope.Property(s => s.Version).IsRowVersion();
            scope.HasIndex(s => s.UserId).IsUnique().HasFilter("\"Kind\" = 'personal'");
            scope.HasIndex(s => s.TeamId).IsUnique().HasFilter("\"Kind\" = 'team'");
            scope.HasOne<AppUser>().WithMany().HasForeignKey(s => s.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<UserEncryptionPreference>(preference =>
        {
            preference.HasKey(p => new { p.UserId, p.Item });
            preference.Property(p => p.Item).HasMaxLength(32);
            preference.HasOne<AppUser>().WithMany().HasForeignKey(p => p.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<SyncRecord>(record =>
        {
            record.Property(r => r.Collection).HasMaxLength(40);
            record.Property(r => r.ItemId).HasMaxLength(64);
            record.Property(r => r.Encryption).HasMaxLength(8);
            record.HasIndex(r => new { r.ScopeId, r.Collection, r.ItemId }).IsUnique();
            record.HasIndex(r => new { r.ScopeId, r.Revision });
            record.HasIndex(r => new { r.Deleted, r.UpdatedAt });
            record.HasOne<SyncScope>().WithMany().HasForeignKey(r => r.ScopeId).OnDelete(DeleteBehavior.Cascade);
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
