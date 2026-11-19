namespace Runova.Website.Data.Notifications;

/// <summary>
/// A phone's push token for one signed-in session (E82). It lives and dies with the session, so a
/// phone that signs out stops being pushed to. Several accounts signed in on one phone (E118) each
/// hold the same token under their own session, and the tag tells the phone which account a push
/// is for. One account holds a token once: signing in again on that phone takes it over from the
/// earlier session.
/// </summary>
public class PushDevice
{
    public long Id { get; set; }

    public long UserId { get; set; }

    public long SessionId { get; set; }

    /// <summary><c>android</c> (FCM) or <c>ios</c> (APNs).</summary>
    public string Platform { get; set; } = "";

    /// <summary>The token the push service knows the phone by. Never returned by the API.</summary>
    public string PushToken { get; set; } = "";

    /// <summary>Which sealed copy of a notification is this phone's (E92), or null when it has not said.</summary>
    public string? SealKeyId { get; set; }

    /// <summary>
    /// An opaque name the phone chose for this account (E118), sent back with every push so it knows
    /// whose it is. Null when the phone did not send one.
    /// </summary>
    public string? AccountTag { get; set; }

    public DateTimeOffset UpdatedAt { get; set; }
}

/// <summary>One notification category an account turned off or back on. No row means on.</summary>
public class NotificationPreference
{
    public long UserId { get; set; }

    public string Category { get; set; } = "";

    public bool Enabled { get; set; }
}
