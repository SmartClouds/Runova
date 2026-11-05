namespace Runova.Website.Data.Accounts;

/// <summary>
/// Something that happened to an account or a team (E48): a sign-in, a new device, a changed
/// password, a team change. Written in the same transaction as the change. Never holds a secret.
/// </summary>
public class AccountActivity
{
    public long Id { get; set; }

    public long UserId { get; set; }

    /// <summary>Set for team events, which the team's Owners and Admins can read too.</summary>
    public long? TeamId { get; set; }

    /// <summary>One of <c>ActivityActions</c>.</summary>
    public string Action { get; set; } = "";

    public long? SessionId { get; set; }

    public string? Ip { get; set; }

    /// <summary>The browser or computer, as a short name.</summary>
    public string? Device { get; set; }

    public DateTimeOffset At { get; set; }

    /// <summary>A small JSON object with what the action needs to be read, with no secret in it.</summary>
    public string? Details { get; set; }
}
