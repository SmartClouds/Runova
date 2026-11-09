namespace Runova.Website.Data.Accounts;

/// <summary>
/// A sign-in by QR code. A signed-in desktop app or browser shows the code, the Runova app on
/// another device scans it, and the signed-in side approves that device after checking the match
/// code both screens show. Only the code's SHA-256 is kept.
/// </summary>
public class QrSignIn
{
    public long Id { get; set; }

    public long UserId { get; set; }

    public byte[] CodeHash { get; set; } = [];

    /// <summary>Base64url SHA-256 of the scanning app's verifier (PKCE S256). Set by the scan.</summary>
    public string? CodeChallenge { get; set; }

    /// <summary>Four digits shown on both screens, so the person approves the device in their hand.</summary>
    public string? MatchCode { get; set; }

    public string? Platform { get; set; }

    public string? AppVersion { get; set; }

    public Guid? DeviceId { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public DateTimeOffset ExpiresAt { get; set; }

    public DateTimeOffset? ClaimedAt { get; set; }

    public DateTimeOffset? ApprovedAt { get; set; }

    public DateTimeOffset? DeclinedAt { get; set; }

    /// <summary>When the scanning app was handed its one sign-in code.</summary>
    public DateTimeOffset? DeliveredAt { get; set; }
}
