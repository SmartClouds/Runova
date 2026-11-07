using Microsoft.EntityFrameworkCore;
using Runova.Website.Data.Accounts;
using Runova.Website.Data.Identity;

namespace Runova.Website.Data.Monitoring;

/// <summary>The tables behind online monitors (E55).</summary>
internal static class CloudMonitorModel
{
    public static void ConfigureCloudMonitors(this ModelBuilder builder)
    {
        builder.Entity<CloudMonitor>(monitor =>
        {
            monitor.Property(m => m.ItemId).HasMaxLength(64);
            monitor.Property(m => m.Name).HasMaxLength(200);
            monitor.Property(m => m.ProjectName).HasMaxLength(200);
            monitor.Property(m => m.EnvironmentName).HasMaxLength(200);
            monitor.Property(m => m.Url).HasMaxLength(2048);
            monitor.Property(m => m.AuthMode).HasMaxLength(16);
            monitor.Property(m => m.SuspendedReason).HasMaxLength(32);
            monitor.Property(m => m.Version).IsRowVersion();
            monitor.HasIndex(m => new { m.ScopeId, m.ItemId }).IsUnique();
            monitor.HasOne<SyncScope>().WithMany().HasForeignKey(m => m.ScopeId).OnDelete(DeleteBehavior.Cascade);
            monitor.ToTable(t =>
            {
                t.HasCheckConstraint("CK_CloudMonitors_AuthMode", "\"AuthMode\" IN ('none', 'bearer', 'basic')");
                t.HasCheckConstraint("CK_CloudMonitors_Interval", "\"IntervalSec\" > 0 AND \"TimeoutSec\" > 0");
            });
        });

        builder.Entity<CloudMonitorStatus>(status =>
        {
            status.HasKey(s => s.MonitorId);
            status.Property(s => s.MonitorId).ValueGeneratedNever();
            status.Property(s => s.State).HasMaxLength(16);
            status.Property(s => s.Confirmed).HasMaxLength(16);
            status.Property(s => s.Problem).HasMaxLength(500);
            status.Property(s => s.LastRegion).HasMaxLength(32);
            status.Property(s => s.SuspectState).HasMaxLength(16);
            status.Property(s => s.SuspectProblem).HasMaxLength(500);
            status.HasIndex(s => s.NodeId);
            status.HasOne<MonitoringNode>().WithMany().HasForeignKey(s => s.NodeId).OnDelete(DeleteBehavior.SetNull);
            status.HasOne<CloudMonitor>().WithOne().HasForeignKey<CloudMonitorStatus>(s => s.MonitorId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<CloudMonitorSample>(sample =>
        {
            sample.Property(s => s.Id).ValueGeneratedNever();
            sample.Property(s => s.State).HasMaxLength(16);
            sample.Property(s => s.Problem).HasMaxLength(500);
            sample.HasIndex(s => new { s.MonitorId, s.CheckedAt });
            // Retention deletes by time across every monitor; a BRIN index is small for that.
            sample.HasIndex(s => s.CheckedAt).HasMethod("brin");
            sample.HasOne<CloudMonitor>().WithMany().HasForeignKey(s => s.MonitorId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<CloudMonitorHour>(hour =>
        {
            hour.ToTable("CloudMonitorHours");
            hour.HasKey(h => new { h.MonitorId, h.Hour });
            hour.HasOne<CloudMonitor>().WithMany().HasForeignKey(h => h.MonitorId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<CloudMonitorIncident>(incident =>
        {
            incident.Property(i => i.State).HasMaxLength(16);
            incident.Property(i => i.Problem).HasMaxLength(500);
            incident.HasIndex(i => new { i.MonitorId, i.OpenedAt });
            incident.HasOne<CloudMonitor>().WithMany().HasForeignKey(i => i.MonitorId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<CloudMonitorMute>(mute =>
        {
            mute.HasKey(m => new { m.MonitorId, m.UserId });
            mute.HasIndex(m => m.UserId);
            mute.HasOne<CloudMonitor>().WithMany().HasForeignKey(m => m.MonitorId).OnDelete(DeleteBehavior.Cascade);
            mute.HasOne<AppUser>().WithMany().HasForeignKey(m => m.UserId).OnDelete(DeleteBehavior.Cascade);
        });
    }
}
