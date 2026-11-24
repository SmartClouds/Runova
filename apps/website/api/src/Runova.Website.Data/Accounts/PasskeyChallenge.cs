namespace Runova.Website.Data.Accounts;

/// <summary>
/// One passkey ceremony in progress (E115): the options the server sent and the state it needs to
/// check the answer. The browser or the phone names it by an id that is kept only as a SHA-256.
/// It is good for five minutes and one use.
/// </summary>
public class PasskeyChallenge
{
    public long Id { get; set; }

    public byte[] IdHash { get; set; } = [];

    /// <summary>
    /// <c>sign-in</c>, <c>register</c> or <c>step-up</c>, or <c>link</c> for a grant to link a
    /// provider login after step-up proof, which no ceremony accepts.
    /// </summary>
    public string Purpose { get; set; } = "";

    /// <summary>The signed-in user who asked, for <c>register</c> and <c>step-up</c>.</summary>
    public long? UserId { get; set; }

    /// <summary>The attestation or assertion state Identity's passkey handler returned, or for <c>link</c> the session it is for.</summary>
    public string State { get; set; } = "";

    public DateTimeOffset CreatedAt { get; set; }

    public DateTimeOffset ExpiresAt { get; set; }

    public DateTimeOffset? UsedAt { get; set; }
}
