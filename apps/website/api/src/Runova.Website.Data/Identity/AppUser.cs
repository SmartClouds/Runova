using Microsoft.AspNetCore.Identity;
using Runova.Website.Core.Users;

namespace Runova.Website.Data.Identity;

/// <summary>
/// A user: a Runova account made by signing up (E48), or a staff user made by an Admin or the CLI.
/// Staff are the users with the Admin or Editor role.
/// </summary>
public class AppUser : IdentityUser<long>, IStaffUser
{
    public string DisplayName { get; set; } = "";

    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>Set when an Admin disables the user; a disabled user can not sign in.</summary>
    public DateTimeOffset? DisabledAt { get; set; }

    public DateTimeOffset? LastSignInAt { get; set; }

    /// <summary>
    /// The last TOTP time step a code was accepted for. A code from that step or an earlier one is
    /// refused, so each code works once.
    /// </summary>
    public long? LastTotpTimeStep { get; set; }

    /// <summary>PostgreSQL's <c>xmin</c>, the row version behind the ETag.</summary>
    public uint Version { get; set; }

    string IStaffUser.Email => Email ?? "";
}
