namespace Runova.Website.Data.Accounts;

/// <summary>
/// A nonce the phone app hands Google's or Apple's own sign-in sheet (E117), which puts it in the
/// ID token the app then sends. Kept only as a SHA-256, for one provider, five minutes and one use.
/// </summary>
public class SignInNonce
{
    public long Id { get; set; }

    public byte[] NonceHash { get; set; } = [];

    /// <summary><c>google</c> or <c>apple</c>.</summary>
    public string Provider { get; set; } = "";

    public DateTimeOffset CreatedAt { get; set; }

    public DateTimeOffset ExpiresAt { get; set; }

    public DateTimeOffset? UsedAt { get; set; }
}
