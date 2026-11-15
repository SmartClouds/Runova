using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Data;

// Cloudflare on the server (E14): DNS tokens for DNS-01, keys waiting for an Origin CA
// certificate, and the origin lock with the ranges it was built from.

/// <summary>A zone-scoped DNS token, sealed with Data Protection. One per zone.</summary>
internal sealed class DnsCredential
{
    /// <summary>The zone's name, lowercase ASCII (example.com).</summary>
    public required string Zone { get; set; }

    public required string ZoneId { get; set; }

    public required string Provider { get; set; }

    public required string ProtectedToken { get; set; }

    public string? TokenId { get; set; }

    public long CreatedAt { get; set; }

    public long UpdatedAt { get; set; }

    public string? CreatedBy { get; set; }

    public long? LastUsedAt { get; set; }

    public string? LastError { get; set; }
}

/// <summary>The key made for a site's Origin CA certificate, until the certificate comes back.</summary>
internal sealed class OriginCertificateKey
{
    public required string SiteId { get; set; }

    public required string ProtectedKey { get; set; }

    /// <summary>The names asked for, as a JSON array.</summary>
    public required string Hostnames { get; set; }

    public long CreatedAt { get; set; }
}

/// <summary>The origin lock: one row, made on first use.</summary>
internal sealed class OriginLockSetting
{
    public const int SingletonId = 1;

    public int Id { get; set; } = SingletonId;

    public bool Enabled { get; set; }

    public bool AuthenticatedOriginPulls { get; set; }

    /// <summary>JSON arrays of CIDR networks.</summary>
    public string Ipv4 { get; set; } = "[]";

    public string Ipv6 { get; set; } = "[]";

    public long? RangesFetchedAt { get; set; }

    public long? LastRefreshAt { get; set; }

    public string? LastRefreshError { get; set; }

    /// <summary>The firewall change that last turned the lock on or off, or brought it up to date.</summary>
    public Guid? ChangeSetId { get; set; }

    public long UpdatedAt { get; set; }
}

/// <summary>
/// The Cloudflare Tunnel (E95): one row, made when the app first starts a tunnel. The token is
/// sealed with Data Protection and never leaves the core but into cloudflared's environment file.
/// </summary>
internal sealed class CloudflareTunnelSetting
{
    public const int SingletonId = 1;

    public int Id { get; set; } = SingletonId;

    public bool Enabled { get; set; }

    public Guid? TunnelId { get; set; }

    public string? TunnelName { get; set; }

    public string? AccountTag { get; set; }

    public string? SshHostname { get; set; }

    public string? ProtectedToken { get; set; }

    public TunnelSshMode SshMode { get; set; }

    /// <summary>nginx's loopback listener for cloudflared (on 127.0.0.2), and cloudflared's metrics port (on 127.0.0.1).</summary>
    public int TunnelPort { get; set; }

    public int MetricsPort { get; set; }

    public bool BreakGlassEnabled { get; set; }

    public int BreakGlassDelayMinutes { get; set; } = 30;

    /// <summary>Whether the core's own break-glass rule is in the firewall now.</summary>
    public bool BreakGlassOpen { get; set; }

    public Guid? SetupJobId { get; set; }

    /// <summary>The firewall change the tunnel last made, and what it was for ("web", "ssh", "off").</summary>
    public Guid? ChangeSetId { get; set; }

    public string? ChangeKind { get; set; }

    /// <summary>The SSH mode the pending change set brings (it becomes SshMode once confirmed).</summary>
    public TunnelSshMode? PendingSshMode { get; set; }

    /// <summary>Whether the pending "off" change set hands the web ports to the origin lock.</summary>
    public bool OffForOriginLock { get; set; }

    public bool WebClosed { get; set; }

    public string? MeshAddress { get; set; }

    public string? LastError { get; set; }

    public long? LastConnectedAt { get; set; }

    public long? DownSince { get; set; }

    public long UpdatedAt { get; set; }
}

internal static class CloudflareModel
{
    public static void Configure(ModelBuilder builder)
    {
        builder.Entity<DnsCredential>(credential =>
        {
            credential.HasKey(c => c.Zone);
            credential.Property(c => c.Zone).HasMaxLength(253);
            credential.Property(c => c.ZoneId).HasMaxLength(64);
            credential.Property(c => c.Provider).HasMaxLength(40);
            credential.Property(c => c.TokenId).HasMaxLength(64);
            credential.Property(c => c.CreatedBy).HasMaxLength(256);
            credential.Property(c => c.LastError).HasMaxLength(1000);
        });

        builder.Entity<OriginCertificateKey>(key =>
        {
            key.HasKey(k => k.SiteId);
            key.Property(k => k.SiteId).HasMaxLength(63);
        });

        builder.Entity<OriginLockSetting>(setting =>
        {
            setting.HasKey(s => s.Id);
            setting.Property(s => s.Id).ValueGeneratedNever();
            setting.Property(s => s.LastRefreshError).HasMaxLength(1000);
        });

        builder.Entity<CloudflareTunnelSetting>(setting =>
        {
            setting.ToTable("CloudflareTunnel");
            setting.HasKey(s => s.Id);
            setting.Property(s => s.Id).ValueGeneratedNever();
            setting.Property(s => s.TunnelName).HasMaxLength(200);
            setting.Property(s => s.AccountTag).HasMaxLength(64);
            setting.Property(s => s.SshHostname).HasMaxLength(253);
            setting.Property(s => s.ProtectedToken).HasMaxLength(16384);
            setting.Property(s => s.SshMode).HasConversion<string>().HasMaxLength(20);
            setting.Property(s => s.PendingSshMode).HasConversion<string>().HasMaxLength(20);
            setting.Property(s => s.ChangeKind).HasMaxLength(10);
            setting.Property(s => s.MeshAddress).HasMaxLength(64);
            setting.Property(s => s.LastError).HasMaxLength(1000);
        });
    }
}
