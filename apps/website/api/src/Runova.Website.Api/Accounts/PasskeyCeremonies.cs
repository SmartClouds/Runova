using System.Buffers.Text;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Core.Accounts;
using Runova.Website.Data;
using Runova.Website.Data.Accounts;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Accounts;

internal static class PasskeyPurposes
{
    public const string SignIn = "sign-in";
    public const string Register = "register";
    public const string StepUp = "step-up";

    public static bool IsKnown(string? purpose) => purpose is SignIn or Register or StepUp;
}

/// <summary>
/// Passkey ceremonies (E115) on Identity's passkey handler. The handler's state is kept in a
/// <see cref="PasskeyChallenge"/> row rather than a cookie, so the same flow serves the website
/// and the phone, and each challenge is good for five minutes and one answer, for its own purpose
/// and its own user.
/// </summary>
internal sealed class PasskeyCeremonies(AppDbContext db, IPasskeyHandler<AppUser> handler, UserManager<AppUser> users, TimeProvider time)
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(5);

    /// <summary>
    /// New options: creation options for <c>register</c>, request options naming the user's passkeys
    /// for <c>step-up</c>, and request options naming none for <c>sign-in</c>, so the browser offers
    /// whichever passkeys it holds for the site.
    /// </summary>
    public async Task<PasskeyChallengeDto> StartAsync(string purpose, AppUser? user, HttpContext http)
    {
        string options, state;
        if (purpose == PasskeyPurposes.Register)
        {
            var entity = new PasskeyUserEntity
            {
                Id = await users.GetUserIdAsync(user!),
                Name = user!.Email ?? user.UserName ?? "",
                DisplayName = user.DisplayName,
            };
            var created = await handler.MakeCreationOptionsAsync(entity, http);
            (options, state) = (created.CreationOptionsJson, created.AttestationState ?? "");
        }
        else
        {
            var requested = await handler.MakeRequestOptionsAsync(purpose == PasskeyPurposes.StepUp ? user : null, http);
            (options, state) = (requested.RequestOptionsJson, requested.AssertionState ?? "");
        }

        var id = Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32));
        var now = time.GetUtcNow();
        db.PasskeyChallenges.Add(new PasskeyChallenge
        {
            IdHash = Hash(id),
            Purpose = purpose,
            UserId = purpose == PasskeyPurposes.SignIn ? null : user!.Id,
            State = state,
            CreatedAt = now,
            ExpiresAt = now + Lifetime,
        });
        await db.PasskeyChallenges.Where(c => c.ExpiresAt < now).ExecuteDeleteAsync();
        await db.SaveChangesAsync();

        using var document = JsonDocument.Parse(options);
        return new PasskeyChallengeDto(id, document.RootElement.Clone(), now + Lifetime);
    }

    /// <summary>
    /// Checks an answer to a <c>sign-in</c> (no user) or <c>step-up</c> (the signed-in user)
    /// challenge, and on success saves the sign count the passkey reported. Null when the challenge
    /// is not one this answer may use.
    /// </summary>
    public async Task<PasskeyAssertionResult<AppUser>?> AssertAsync(string? challengeId, JsonElement? credential, string purpose, AppUser? user, HttpContext http)
    {
        if (credential is not { ValueKind: JsonValueKind.Object } answer || await TakeAsync(challengeId, purpose, user?.Id) is not { } challenge)
        {
            return null;
        }

        var result = await handler.PerformAssertionAsync(new PasskeyAssertionContext
        {
            HttpContext = http,
            CredentialJson = answer.GetRawText(),
            AssertionState = challenge.State,
        });
        if (!result.Succeeded || (user is not null && result.User.Id != user.Id))
        {
            return result.Succeeded ? null : result;
        }

        var saved = await users.AddOrUpdatePasskeyAsync(result.User, result.Passkey);
        return saved.Succeeded ? result : null;
    }

    /// <summary>Checks an answer to the user's <c>register</c> challenge. Null when the challenge is not one this answer may use.</summary>
    public async Task<PasskeyAttestationResult?> AttestAsync(string? challengeId, JsonElement? credential, AppUser user, HttpContext http)
    {
        if (credential is not { ValueKind: JsonValueKind.Object } answer || await TakeAsync(challengeId, PasskeyPurposes.Register, user.Id) is not { } challenge)
        {
            return null;
        }

        var result = await handler.PerformAttestationAsync(new PasskeyAttestationContext
        {
            HttpContext = http,
            CredentialJson = answer.GetRawText(),
            AttestationState = challenge.State,
        });
        return result.Succeeded && result.UserEntity.Id != user.Id.ToString(CultureInfo.InvariantCulture) ? null : result;
    }

    /// <summary>
    /// The account whose stored passkey an answer names, if any, so a failed answer can be logged
    /// on that account. An answer naming a passkey nobody has is logged nowhere.
    /// </summary>
    public async Task<AppUser?> OwnerAsync(JsonElement? credential)
    {
        if (credential is not { ValueKind: JsonValueKind.Object } answer
            || !answer.TryGetProperty("rawId", out var rawId)
            || rawId.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        try
        {
            return await users.FindByPasskeyIdAsync(Base64Url.DecodeFromChars(rawId.GetString()));
        }
        catch (FormatException)
        {
            return null;
        }
    }

    // One use, even when two answers race for it.
    private async Task<PasskeyChallenge?> TakeAsync(string? id, string purpose, long? userId)
    {
        if (string.IsNullOrEmpty(id) || id.Length > 64)
        {
            return null;
        }

        var hash = Hash(id);
        var now = time.GetUtcNow();
        var challenge = await db.PasskeyChallenges.AsNoTracking().SingleOrDefaultAsync(c => c.IdHash == hash);
        if (challenge is null || challenge.UsedAt is not null || challenge.ExpiresAt <= now || challenge.Purpose != purpose || challenge.UserId != userId)
        {
            return null;
        }

        var taken = await db.PasskeyChallenges.Where(c => c.Id == challenge.Id && c.UsedAt == null)
            .ExecuteUpdateAsync(c => c.SetProperty(x => x.UsedAt, now));
        return taken == 1 ? challenge : null;
    }

    private static byte[] Hash(string id) => SHA256.HashData(Encoding.ASCII.GetBytes(id));
}
