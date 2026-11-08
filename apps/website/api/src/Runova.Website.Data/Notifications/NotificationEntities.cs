namespace Runova.Website.Data.Notifications;

/// <summary>
/// A phone's push token for one signed-in session (E82). It lives and dies with the session, so a
/// phone that signs out stops being pushed to, and a token is held by one session at a time: the
/// phone that signs in as someone else takes it over.
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

    public DateTimeOffset UpdatedAt { get; set; }
}

/// <summary>One notification category an account turned off or back on. No row means on.</summary>
public class NotificationPreference
{
    public long UserId { get; set; }

    public string Category { get; set; } = "";

    public bool Enabled { get; set; }
}
