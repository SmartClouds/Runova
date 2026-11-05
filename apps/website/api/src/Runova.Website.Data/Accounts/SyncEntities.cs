namespace Runova.Website.Data.Accounts;

/// <summary>
/// Where an account's or a team's synced data lives (E48.6). Each push takes the next revisions
/// from <see cref="LatestRevision"/> under the row's lock, so revisions never repeat or go back.
/// The end-to-end key is kept only wrapped (its envelope), which the server can not open. The epoch
/// changes when the cloud copy is reset, telling every computer to start that scope again.
/// </summary>
public class SyncScope
{
    public long Id { get; set; }

    /// <summary>One of <see cref="SyncScopeKinds"/>.</summary>
    public string Kind { get; set; } = "";

    /// <summary>The account of a personal scope.</summary>
    public long? UserId { get; set; }

    /// <summary>The team of a team scope.</summary>
    public long? TeamId { get; set; }

    public long LatestRevision { get; set; }

    public int Epoch { get; set; } = 1;

    public int? KeyVersion { get; set; }

    /// <summary>The wrapped key as the desktop made it (JSON), or null when there is none.</summary>
    public string? KeyEnvelope { get; set; }

    public DateTimeOffset? KeySetAt { get; set; }

    public long? KeySetBy { get; set; }

    public bool EncryptServers { get; set; }

    public bool EncryptEnvironments { get; set; }

    public bool EncryptEverything { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>PostgreSQL's <c>xmin</c>.</summary>
    public uint Version { get; set; }
}

public static class SyncScopeKinds
{
    public const string Personal = "personal";
    public const string Team = "team";
}

/// <summary>One synced item: its newest content as the last computer pushed it, or a tombstone.</summary>
public class SyncRecord
{
    public long Id { get; set; }

    public long ScopeId { get; set; }

    public string Collection { get; set; } = "";

    public string ItemId { get; set; } = "";

    public long Revision { get; set; }

    public bool Deleted { get; set; }

    /// <summary><c>none</c> or <c>e2ee</c>.</summary>
    public string Encryption { get; set; } = "none";

    public int? KeyVersion { get; set; }

    /// <summary>The payload exactly as pushed; never read or logged by the server.</summary>
    public string? Payload { get; set; }

    public int Size { get; set; }

    public DateTimeOffset UpdatedAt { get; set; }

    public long? UpdatedBy { get; set; }
}
