using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Api.Http;
using Runova.Website.Core.Users;
using Runova.Website.Data;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Users;

/// <summary>
/// Issues and redeems one-time links: setting a password (an invitation or a reset) and confirming
/// an email. 32 random bytes in base64url, stored only as their SHA-256, for one use. Staff links
/// open the admin, account links the account panel; an account reset lasts an hour, the rest 24.
/// </summary>
internal sealed class SetupLinks(AppDbContext db, TimeProvider time, IConfiguration configuration)
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromHours(24);

    public static readonly TimeSpan AccountResetLifetime = TimeSpan.FromHours(1);

    /// <summary>
    /// Replaces any link the user has with a new one. The new link is added to the context, so the
    /// caller saves it with the rest of the change.
    /// </summary>
    public async Task<SetupLinkDto> IssueAsync(AppUser user, string purpose)
    {
        await db.SetupLinks.Where(l => l.UserId == user.Id).ExecuteDeleteAsync();

        var token = Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32));
        var now = time.GetUtcNow();
        var lifetime = purpose == SetupLinkPurposes.AccountReset ? AccountResetLifetime : Lifetime;
        var link = new SetupLink { UserId = user.Id, Purpose = purpose, TokenHash = Hash(token), CreatedAt = now, ExpiresAt = now + lifetime };
        db.SetupLinks.Add(link);

        return new SetupLinkDto($"{SiteUrl.From(configuration)}{PagePath(purpose)}#token={token}", link.ExpiresAt);
    }

    /// <summary>The site page a link of this purpose opens.</summary>
    public static string PagePath(string purpose) => purpose switch
    {
        SetupLinkPurposes.AccountReset => "/account/reset-password",
        SetupLinkPurposes.EmailVerification => "/account/verify-email",
        _ => "/admin/set-password",
    };

    /// <summary>The link a token belongs to while it has not expired and has one of the purposes, or null.</summary>
    public Task<SetupLink?> FindAsync(string token, IReadOnlySet<string> purposes)
    {
        var hash = Hash(token);
        var now = time.GetUtcNow();
        var allowed = purposes.ToList();
        return db.SetupLinks.SingleOrDefaultAsync(l => l.TokenHash == hash && l.ExpiresAt > now && allowed.Contains(l.Purpose));
    }

    /// <summary>Deletes a link; false when another request used it first.</summary>
    public async Task<bool> UseAsync(SetupLink link) =>
        await db.SetupLinks.Where(l => l.Id == link.Id).ExecuteDeleteAsync() == 1;

    private static byte[] Hash(string token) => SHA256.HashData(Encoding.ASCII.GetBytes(token));
}
