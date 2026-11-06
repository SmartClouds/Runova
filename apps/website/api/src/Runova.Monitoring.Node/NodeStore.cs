using Microsoft.EntityFrameworkCore;

namespace Runova.Monitoring.Node;

/// <summary>What the node keeps about itself after enrolling. The private key is a file next to it.</summary>
public sealed class NodeState
{
    public int Id { get; set; } = 1;

    public long NodeId { get; set; }

    /// <summary>The client certificate, DER.</summary>
    public required byte[] Certificate { get; set; }

    /// <summary>The Node CA, DER.</summary>
    public required byte[] CaCertificate { get; set; }

    public required string GatewayAddress { get; set; }

    public DateTimeOffset NotAfter { get; set; }
}

/// <summary>A result waiting for the gateway's ack. <see cref="BatchId"/> is set while it is in flight.</summary>
public sealed class OutboxResult
{
    public Guid Id { get; set; }

    public long MonitorId { get; set; }

    /// <summary>The serialized <c>CheckResult</c>.</summary>
    public required byte[] Payload { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public string? BatchId { get; set; }

    public DateTimeOffset? SentAt { get; set; }
}

/// <summary>The node's SQLite file. Small and private to one node, so it is made with EnsureCreated.</summary>
public sealed class NodeDb(DbContextOptions<NodeDb> options) : DbContext(options)
{
    public DbSet<NodeState> State => Set<NodeState>();

    public DbSet<OutboxResult> Outbox => Set<OutboxResult>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<NodeState>().Property(s => s.Id).ValueGeneratedNever();
        modelBuilder.Entity<NodeState>().Property(s => s.NotAfter).HasConversion(v => v.ToUnixTimeMilliseconds(), v => DateTimeOffset.FromUnixTimeMilliseconds(v));
        modelBuilder.Entity<OutboxResult>(result =>
        {
            result.Property(r => r.Id).ValueGeneratedNever();
            result.Property(r => r.CreatedAt).HasConversion(v => v.ToUnixTimeMilliseconds(), v => DateTimeOffset.FromUnixTimeMilliseconds(v));
            result.Property(r => r.SentAt).HasConversion(
                v => v.HasValue ? v.Value.ToUnixTimeMilliseconds() : (long?)null,
                v => v.HasValue ? DateTimeOffset.FromUnixTimeMilliseconds(v.Value) : null);
            result.HasIndex(r => r.BatchId);
            result.HasIndex(r => r.CreatedAt);
        });
    }
}
