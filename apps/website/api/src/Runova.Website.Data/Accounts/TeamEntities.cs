namespace Runova.Website.Data.Accounts;

/// <summary>A team of Runova accounts that share items through its sync scope (E48.7).</summary>
public class Team
{
    public long Id { get; set; }

    public string Name { get; set; } = "";

    public DateTimeOffset CreatedAt { get; set; }

    public long? CreatedBy { get; set; }

    /// <summary>PostgreSQL's <c>xmin</c>.</summary>
    public uint Version { get; set; }
}

/// <summary>An account in a team, with its role. A team always keeps at least one Owner.</summary>
public class TeamMember
{
    public long TeamId { get; set; }

    public long UserId { get; set; }

    /// <summary>One of <see cref="TeamRoles"/>.</summary>
    public string Role { get; set; } = "";

    public DateTimeOffset JoinedAt { get; set; }
}

/// <summary>
/// An invitation to an email address. Only an account with that address confirmed can see and
/// accept it, so the email's link needs no secret of its own. Good for 7 days.
/// </summary>
public class TeamInvitation
{
    public long Id { get; set; }

    public long TeamId { get; set; }

    public string Email { get; set; } = "";

    /// <summary>Upper case, as Identity normalizes emails, for matching.</summary>
    public string NormalizedEmail { get; set; } = "";

    public string Role { get; set; } = "";

    public long InvitedBy { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public DateTimeOffset ExpiresAt { get; set; }
}

public static class TeamRoles
{
    public const string Owner = "owner";
    public const string Admin = "admin";
    public const string Member = "member";
    public const string Viewer = "viewer";

    public static readonly IReadOnlyList<string> All = [Owner, Admin, Member, Viewer];

    public static bool CanManage(string role) => role is Owner or Admin;

    public static bool CanWrite(string role) => role is not Viewer;
}
