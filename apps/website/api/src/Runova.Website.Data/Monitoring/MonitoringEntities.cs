namespace Runova.Website.Data.Monitoring;

/// <summary>What a monitoring node is doing, as the API last saw it.</summary>
public static class NodeStatuses
{
    /// <summary>Made by an Admin, not enrolled yet.</summary>
    public const string Pending = "pending";

    /// <summary>Its stream is open and its heartbeats arrive.</summary>
    public const string Online = "online";

    /// <summary>Enrolled, but no heartbeat for a while.</summary>
    public const string Offline = "offline";

    /// <summary>Its certificates are refused for good.</summary>
    public const string Revoked = "revoked";

    public static readonly string[] All = [Pending, Online, Offline, Revoked];
}

/// <summary>
/// A server that runs online checks (E54). It enrolls once with a one-time token, then connects to
/// the gateway with the client certificate it got.
/// </summary>
public sealed class MonitoringNode
{
    public long Id { get; set; }

    public required string Name { get; set; }

    /// <summary>A short place name such as <c>eu-central</c>; nodes in different regions confirm each other.</summary>
    public required string Region { get; set; }

    /// <summary>How much this node can take next to the others (100 is a normal node).</summary>
    public int Capacity { get; set; } = 100;

    public string Status { get; set; } = NodeStatuses.Pending;

    /// <summary>An Admin is taking it out of service: it stays connected but gets no monitors.</summary>
    public bool Draining { get; set; }

    /// <summary>SHA-256 of the one-time enrollment token. Null once used.</summary>
    public byte[]? EnrollmentTokenHash { get; set; }

    public DateTimeOffset? EnrollmentTokenExpiresAt { get; set; }

    /// <summary>Addresses (CIDR) the node may connect from; empty means any.</summary>
    public string[] AllowedAddresses { get; set; } = [];

    public DateTimeOffset? EnrolledAt { get; set; }

    public string? SoftwareVersion { get; set; }

    /// <summary>The gateway holding its stream, while it is connected.</summary>
    public string? GatewayId { get; set; }

    public string? RemoteAddress { get; set; }

    public DateTimeOffset? ConnectedAt { get; set; }

    public DateTimeOffset? LastSeenAt { get; set; }

    public int Monitors { get; set; }

    public int ChecksLastMinute { get; set; }

    public int QueuedResults { get; set; }

    public int LagMs { get; set; }

    /// <summary>Goes up each time the monitors given to this node change.</summary>
    public long AssignmentVersion { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public long? CreatedBy { get; set; }

    public DateTimeOffset? RevokedAt { get; set; }

    public uint Version { get; set; }
}

/// <summary>A client certificate the Node CA signed. Kept so a revoked node's certificates can be refused.</summary>
public sealed class NodeCertificate
{
    /// <summary>The serial number in upper-case hex, as .NET prints it.</summary>
    public required string Serial { get; set; }

    public long NodeId { get; set; }

    /// <summary>SHA-256 of the certificate's SubjectPublicKeyInfo, so a renewal must keep the key.</summary>
    public required byte[] PublicKeyHash { get; set; }

    public DateTimeOffset NotBefore { get; set; }

    public DateTimeOffset NotAfter { get; set; }

    public DateTimeOffset? RevokedAt { get; set; }
}

/// <summary>The private Node CA. One row, made the first time a node enrolls.</summary>
public sealed class NodeAuthority
{
    public const int SingletonId = 1;

    public int Id { get; set; } = SingletonId;

    /// <summary>The CA certificate, DER encoded.</summary>
    public required byte[] Certificate { get; set; }

    /// <summary>The CA's private key (PKCS#8), sealed with Data Protection. It never leaves the API.</summary>
    public required string SealedPrivateKey { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
}
