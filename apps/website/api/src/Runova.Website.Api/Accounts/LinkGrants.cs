using System.Globalization;
using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Data;
using Runova.Website.Data.Accounts;

namespace Runova.Website.Api.Accounts;

/// <summary>
/// Leave to link a Google, Apple or Microsoft login, given after step-up proof. Linking is a chain of
/// browser redirects that can not carry the proof itself, so the Security page proves it is the
/// owner first and the start of the link takes the grant. A grant is good for one link, for
/// <see cref="Lifetime"/>, and only for the browser session that asked for it. It is kept as a
/// <see cref="PasskeyChallenge"/> row of its own purpose, which no passkey ceremony accepts.
/// </summary>
internal sealed class LinkGrants(AppDbContext db, TimeProvider time)
{
    public const string Purpose = "link";

    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(2);

    public async Task IssueAsync(long userId, long sessionId)
    {
        var now = time.GetUtcNow();
        db.PasskeyChallenges.Add(new PasskeyChallenge
        {
            // Never handed out: the session finds its grant, so the id only has to be unique.
            IdHash = SHA256.HashData(RandomNumberGenerator.GetBytes(32)),
            Purpose = Purpose,
            UserId = userId,
            State = sessionId.ToString(CultureInfo.InvariantCulture),
            CreatedAt = now,
            ExpiresAt = now + Lifetime,
        });
        await db.PasskeyChallenges.Where(c => c.ExpiresAt < now).ExecuteDeleteAsync();
        await db.SaveChangesAsync();
    }

    /// <summary>Uses up the session's newest live grant; false when it has none. One use, even when two starts race for it.</summary>
    public async Task<bool> TakeAsync(long userId, long sessionId)
    {
        var now = time.GetUtcNow();
        var session = sessionId.ToString(CultureInfo.InvariantCulture);
        var id = await db.PasskeyChallenges.AsNoTracking()
            .Where(c => c.Purpose == Purpose && c.UserId == userId && c.State == session && c.UsedAt == null && c.ExpiresAt > now)
            .OrderByDescending(c => c.Id)
            .Select(c => (long?)c.Id)
            .FirstOrDefaultAsync();
        if (id is null)
        {
            return false;
        }

        var taken = await db.PasskeyChallenges.Where(c => c.Id == id && c.UsedAt == null)
            .ExecuteUpdateAsync(c => c.SetProperty(x => x.UsedAt, now));
        return taken == 1;
    }
}
