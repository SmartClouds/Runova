namespace Runova.Website.Data.Accounts;

/// <summary>
/// One browser or computer signed in to an account (E48). A browser's cookie names its session, and
/// a computer's tokens do too; a session that is ended (revoked) stops working at its next request.
/// A desktop session also holds the SHA-256 of its refresh token and of the one before it, so a token
/// used twice can be told from a lost one.
/// </summary>
public class AccountSession
{
    public long Id { get; set; }

    public long UserId { get; set; }

    /// <summary>One of <see cref="AccountSessionKinds"/>.</summary>
    public string Kind { get; set; } = "";

    /// <summary>What the person sees: "Firefox on Windows", or the computer's name.</summary>
    public string DeviceName { get; set; } = "";

    public string Platform { get; set; } = "";

    public string? AppVersion { get; set; }

    /// <summary>The desktop app's own id for the computer, so a second sign-in there replaces the first.</summary>
    public Guid? DeviceId { get; set; }

    public string? UserAgent { get; set; }

    public string? CreatedIp { get; set; }

    public string? LastIp { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public DateTimeOffset LastSeenAt { get; set; }

    public DateTimeOffset? RevokedAt { get; set; }

    public byte[]? RefreshTokenHash { get; set; }

    public byte[]? PreviousRefreshTokenHash { get; set; }

    public DateTimeOffset? RefreshRotatedAt { get; set; }

    public DateTimeOffset? RefreshExpiresAt { get; set; }
}

public static class AccountSessionKinds
{
    public const string Web = "web";
    public const string Desktop = "desktop";
    public const string Mobile = "mobile";
}
