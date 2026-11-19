using System.Security.Claims;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Core.Accounts;
using Runova.Website.Data;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Accounts;

/// <summary>The account a provider's login belongs to, or why there is none (an error code the pages know).</summary>
internal sealed record ExternalAccount(AppUser? Owner, string? Error);

/// <summary>
/// The rules that turn a provider's login into a Runova account, shared by the browser sign-in and
/// the phone's <c>id_token</c> grant. A login is never linked to an existing account by email
/// alone: an account with that address that someone confirmed must sign in another way and link
/// the provider from Security. An address nobody confirmed goes to whoever proved it with the
/// provider, and the password it was registered with stops working. Only an email the provider
/// says is verified (the <c>email_verified</c> claim set to <c>true</c>) is ever trusted.
/// </summary>
internal sealed class ExternalAccounts(UserManager<AppUser> users, AppDbContext db, ActivityLog activity, TimeProvider time)
{
    public const string EmailVerifiedClaim = "email_verified";

    public async Task<ExternalAccount> ResolveAsync(ExternalLoginInfo info, ExternalProvider provider)
    {
        if (await users.FindByLoginAsync(info.LoginProvider, info.ProviderKey) is { } known)
        {
            return new ExternalAccount(known, null);
        }

        var email = info.Principal.FindFirstValue(ClaimTypes.Email);
        var verified = string.Equals(info.Principal.FindFirstValue(EmailVerifiedClaim), "true", StringComparison.OrdinalIgnoreCase);
        if (!verified || string.IsNullOrWhiteSpace(email))
        {
            return new ExternalAccount(null, "email-unverified");
        }

        var existing = await users.FindByEmailAsync(email);
        if (existing is { EmailConfirmed: true })
        {
            return new ExternalAccount(null, "link-needed");
        }

        var name = info.Principal.FindFirstValue(ClaimTypes.Name)?.Trim();
        await using var transaction = await db.Database.BeginTransactionAsync();
        var owner = existing ?? new AppUser { UserName = email, Email = email, CreatedAt = time.GetUtcNow() };
        owner.EmailConfirmed = true;
        owner.DisplayName = string.IsNullOrWhiteSpace(name) ? email.Split('@')[0] : name[..Math.Min(name.Length, AccountEndpoints.DisplayNameMax)];
        if (existing is null)
        {
            Succeeded(await users.CreateAsync(owner));
        }
        else
        {
            // Whoever typed this address in never proved it; the provider's owner just did.
            if (await users.HasPasswordAsync(owner))
            {
                Succeeded(await users.RemovePasswordAsync(owner));
            }

            await db.SetupLinks.Where(l => l.UserId == owner.Id).ExecuteDeleteAsync();
            Succeeded(await users.UpdateAsync(owner));
        }

        Succeeded(await users.AddLoginAsync(owner, info));
        activity.Add(owner.Id, ActivityActions.LoginLinked, new { provider = provider.Name });
        await db.SaveChangesAsync();
        await transaction.CommitAsync();
        return new ExternalAccount(owner, null);
    }

    internal static void Succeeded(IdentityResult result)
    {
        if (!result.Succeeded)
        {
            throw new InvalidOperationException(string.Join(" ", result.Errors.Select(e => $"{e.Code}: {e.Description}")));
        }
    }
}
