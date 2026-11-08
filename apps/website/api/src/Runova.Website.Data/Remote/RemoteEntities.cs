namespace Runova.Website.Data.Remote;

/// <summary>
/// A computer that can be reached by its Runova ID (E60). The desktop app registers one per
/// install once its owner signs in. The flags here only let the server turn away a request the
/// computer would refuse anyway; the computer itself always makes the final decision.
/// </summary>
public class RemoteDevice
{
    public long Id { get; set; }

    public long UserId { get; set; }

    /// <summary>Nine digits, never starting with 0, shown in groups of three. Never given out again.</summary>
    public string RemoteId { get; set; } = "";

    /// <summary>The desktop app's own id for the computer, so signing in again keeps the same Runova ID.</summary>
    public Guid DeviceId { get; set; }

    /// <summary>One of <see cref="RemoteDeviceKinds"/>.</summary>
    public string Kind { get; set; } = RemoteDeviceKinds.App;

    public string Name { get; set; } = "";

    public string Platform { get; set; } = "";

    /// <summary>
    /// The computer's Ed25519 public key, base64url. Controllers pin it on the first connection,
    /// and the computer signs every session's keys with the private half, which never leaves it.
    /// </summary>
    public string IdentityKey { get; set; } = "";

    /// <summary>The owner's other computers may connect without anyone accepting.</summary>
    public bool AllowOwnDevices { get; set; }

    /// <summary>An unattended-access password is set on the computer. The password itself never leaves it.</summary>
    public bool UnattendedEnabled { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public DateTimeOffset LastSeenAt { get; set; }

    public DateTimeOffset? RevokedAt { get; set; }
}

/// <summary>A team whose members may see the computer and ask to connect to it.</summary>
public class RemoteDeviceTeam
{
    public long RemoteDeviceId { get; set; }

    public long TeamId { get; set; }
}

/// <summary>
/// That a session took place: who, to which computer, how and when. Nothing that was on the
/// screen, typed or copied, and no address. Kept for 30 days, and either side can delete it.
/// </summary>
public class RemoteSessionRecord
{
    public long Id { get; set; }

    public long HostDeviceId { get; set; }

    public long HostUserId { get; set; }

    public long ControllerUserId { get; set; }

    public long? ControllerDeviceId { get; set; }

    /// <summary>One of <see cref="RemoteAccessModes"/>.</summary>
    public string Mode { get; set; } = "";

    /// <summary>One of <see cref="RemoteTransports"/>, once the two computers are connected.</summary>
    public string? Transport { get; set; }

    public DateTimeOffset StartedAt { get; set; }

    public DateTimeOffset? EndedAt { get; set; }
}

public static class RemoteDeviceKinds
{
    /// <summary>The desktop app, while someone is signed in to the computer.</summary>
    public const string App = "app";

    /// <summary>The background service that keeps the computer reachable when no one is signed in.</summary>
    public const string Agent = "agent";
}

public static class RemoteAccessModes
{
    /// <summary>Someone on the computer accepts, or the owner's own computer is let in.</summary>
    public const string Ask = "ask";

    /// <summary>The controller proves it knows the unattended-access password.</summary>
    public const string Password = "password";

    public static readonly IReadOnlyList<string> All = [Ask, Password];
}

public static class RemoteTransports
{
    public const string Direct = "direct";
    public const string Relay = "relay";

    public static readonly IReadOnlyList<string> All = [Direct, Relay];
}
