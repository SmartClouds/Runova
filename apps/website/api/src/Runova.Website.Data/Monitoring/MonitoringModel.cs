using Microsoft.EntityFrameworkCore;

namespace Runova.Website.Data.Monitoring;

/// <summary>The tables behind monitoring nodes and their certificates (E54).</summary>
internal static class MonitoringModel
{
    public static void ConfigureMonitoring(this ModelBuilder builder)
    {
        builder.Entity<MonitoringNode>(node =>
        {
            node.Property(n => n.Name).HasMaxLength(60);
            node.Property(n => n.Region).HasMaxLength(32);
            node.Property(n => n.Status).HasMaxLength(16);
            node.Property(n => n.EnrollmentTokenHash).HasMaxLength(32);
            node.Property(n => n.SoftwareVersion).HasMaxLength(40);
            node.Property(n => n.GatewayId).HasMaxLength(100);
            node.Property(n => n.RemoteAddress).HasMaxLength(64);
            node.Property(n => n.Version).IsRowVersion();
            node.HasIndex(n => n.Name).IsUnique();
            node.HasIndex(n => n.EnrollmentTokenHash).IsUnique().HasFilter("\"EnrollmentTokenHash\" IS NOT NULL");
            node.HasIndex(n => n.Status);
            node.ToTable(t => t.HasCheckConstraint(
                "CK_MonitoringNodes_Status",
                "\"Status\" IN ('pending', 'online', 'offline', 'revoked')"));
        });

        builder.Entity<NodeCertificate>(certificate =>
        {
            certificate.HasKey(c => c.Serial);
            certificate.Property(c => c.Serial).HasMaxLength(64);
            certificate.Property(c => c.PublicKeyHash).HasMaxLength(32);
            certificate.HasIndex(c => c.NodeId);
            certificate.HasOne<MonitoringNode>().WithMany().HasForeignKey(c => c.NodeId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<NodeAuthority>(authority =>
        {
            authority.Property(a => a.Id).ValueGeneratedNever();
            authority.ToTable(t => t.HasCheckConstraint("CK_NodeAuthority_Singleton", "\"Id\" = 1"));
        });
    }
}
