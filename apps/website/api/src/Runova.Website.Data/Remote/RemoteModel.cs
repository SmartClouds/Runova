using Microsoft.EntityFrameworkCore;
using Runova.Website.Data.Accounts;
using Runova.Website.Data.Identity;

namespace Runova.Website.Data.Remote;

internal static class RemoteModel
{
    public static void ConfigureRemote(this ModelBuilder builder)
    {
        builder.Entity<RemoteDevice>(device =>
        {
            device.Property(d => d.RemoteId).HasMaxLength(9);
            device.Property(d => d.Kind).HasMaxLength(8);
            device.Property(d => d.Name).HasMaxLength(100);
            device.Property(d => d.Platform).HasMaxLength(32);
            device.Property(d => d.IdentityKey).HasMaxLength(64);
            device.Property(d => d.AgentIdentityKey).HasMaxLength(64);
            device.Property(d => d.AgentSecretHash).HasMaxLength(32);
            device.HasIndex(d => d.RemoteId).IsUnique();
            device.HasIndex(d => new { d.UserId, d.DeviceId, d.Kind }).IsUnique().HasFilter("\"RevokedAt\" IS NULL");
            device.HasOne<AppUser>().WithMany().HasForeignKey(d => d.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<RemoteDeviceTeam>(link =>
        {
            link.HasKey(l => new { l.RemoteDeviceId, l.TeamId });
            link.HasIndex(l => l.TeamId);
            link.HasOne<RemoteDevice>().WithMany().HasForeignKey(l => l.RemoteDeviceId).OnDelete(DeleteBehavior.Cascade);
            link.HasOne<Team>().WithMany().HasForeignKey(l => l.TeamId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<RemoteSessionRecord>(record =>
        {
            record.Property(r => r.Mode).HasMaxLength(16);
            record.Property(r => r.Transport).HasMaxLength(16);
            record.HasIndex(r => new { r.HostUserId, r.StartedAt });
            record.HasIndex(r => new { r.ControllerUserId, r.StartedAt });
            record.HasIndex(r => r.StartedAt);
            record.HasOne<RemoteDevice>().WithMany().HasForeignKey(r => r.HostDeviceId).OnDelete(DeleteBehavior.Cascade);
            record.HasOne<AppUser>().WithMany().HasForeignKey(r => r.HostUserId).OnDelete(DeleteBehavior.Cascade);
            record.HasOne<AppUser>().WithMany().HasForeignKey(r => r.ControllerUserId).OnDelete(DeleteBehavior.Cascade);
        });
    }
}
