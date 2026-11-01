using Microsoft.AspNetCore.Identity;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Users;

/// <summary>The password rules of Identity's validators, for the endpoints that set a password.</summary>
internal static class PasswordRules
{
    /// <summary>What the validators say against the password, as one message; empty when it is accepted.</summary>
    public static async Task<string> ProblemsAsync(UserManager<AppUser> users, AppUser user, string password)
    {
        var problems = new List<string>();
        foreach (var validator in users.PasswordValidators)
        {
            problems.AddRange((await validator.ValidateAsync(users, user, password)).Errors.Select(e => e.Description));
        }

        return string.Join(" ", problems);
    }
}
