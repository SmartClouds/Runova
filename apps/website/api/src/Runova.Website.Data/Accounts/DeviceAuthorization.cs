namespace Runova.Website.Data.Accounts;

/// <summary>
/// A computer the person approved in the browser, waiting for the desktop app to trade its code
/// (E48.5). Only the code's SHA-256 is kept, with the PKCE challenge it must answer. A code is good
/// for two minutes and one use.
/// </summary>
public class DeviceAuthorization
{
    public long Id { get; set; }

    public long UserId { get; set; }

    public byte[] CodeHash { get; set; } = [];

    /// <summary>Base64url SHA-256 of the app's verifier (PKCE S256).</summary>
    public string CodeChallenge { get; set; } = "";

    public string RedirectUri { get; set; } = "";

    public string DeviceName { get; set; } = "";

    public string Platform { get; set; } = "";

    public string? AppVersion { get; set; }

    public Guid? DeviceId { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public DateTimeOffset ExpiresAt { get; set; }

    public DateTimeOffset? UsedAt { get; set; }
}
