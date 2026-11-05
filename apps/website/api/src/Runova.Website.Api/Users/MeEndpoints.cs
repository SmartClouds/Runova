using System.Globalization;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Runova.Website.Api.Accounts;
using Runova.Website.Api.Audit;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Accounts;
using Runova.Website.Core.Audit;
using Runova.Website.Core.Problems;
using Runova.Website.Core.Users;
using Runova.Website.Data;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Users;

public sealed record TwoFactorStatusDto(bool Enabled, int RecoveryCodesLeft);

public sealed record TwoFactorSetupDto(string SharedKey, string AuthenticatorUri);

public sealed record TwoFactorConfirmRequest(string? Code);

public sealed record RecoveryCodesDto(IReadOnlyList<string> RecoveryCodes);

public sealed record PasswordChangeRequest(string? CurrentPassword, string? NewPassword);

public sealed record TwoFactorOffRequest(string? Password);

/// <summary>
/// The signed-in user: their password and their two-factor setup. A change that could lock the
/// owner out (a new password, two-factor off) needs the current password, and new recovery codes
/// need a code from the authenticator. Passwords and codes never reach an audit entry or a log.
/// </summary>
internal static class MeEndpoints
{
    private const string Issuer = "Runova";
    private const int RecoveryCodeCount = 10;

    public static RouteGroupBuilder MapMe(this RouteGroupBuilder api)
    {
        var me = api.MapGroup("/users/me").RequireAuthorization(Policies.Account);
        me.MapGet("", GetMeAsync);
        me.MapGet("/two-factor", GetTwoFactorAsync);
        me.MapPost("/two-factor", StartTwoFactorAsync);
        me.MapPut("/two-factor", ConfirmTwoFactorAsync);
        me.MapPut("/password", ChangePasswordAsync);
        me.MapDelete("/two-factor", TurnOffTwoFactorAsync);
        me.MapPost("/two-factor/recovery-codes", RenewRecoveryCodesAsync);
        return api;
    }

    private static async Task<Results<Ok<UserDto>, UnauthorizedHttpResult>> GetMeAsync(
        HttpContext http, UserManager<AppUser> users, TimeProvider time)
    {
        if (await users.GetUserAsync(http.User) is not { } user)
        {
            return TypedResults.Unauthorized();
        }

        return TypedResults.Ok(await users.ToDtoAsync(user, time));
    }

    private static async Task<Results<Ok<TwoFactorStatusDto>, UnauthorizedHttpResult>> GetTwoFactorAsync(
        HttpContext http, UserManager<AppUser> users)
    {
        if (await users.GetUserAsync(http.User) is not { } user)
        {
            return TypedResults.Unauthorized();
        }

        return TypedResults.Ok(new TwoFactorStatusDto(user.TwoFactorEnabled, await users.CountRecoveryCodesAsync(user)));
    }

    /// <summary>
    /// Makes a new authenticator key. Two-factor stays off until a code from it is confirmed, and
    /// a user who has it on already must turn it off first, so a running setup is never replaced.
    /// </summary>
    private static async Task<Results<Ok<TwoFactorSetupDto>, ProblemHttpResult, UnauthorizedHttpResult>> StartTwoFactorAsync(
        HttpContext http, UserManager<AppUser> users, SignInManager<AppUser> signIn)
    {
        if (await users.GetUserAsync(http.User) is not { } user)
        {
            return TypedResults.Unauthorized();
        }

        if (user.TwoFactorEnabled)
        {
            return ApiProblems.Of(ProblemTypes.Conflict, "Two-factor is on already. Turn it off before setting it up again.");
        }

        // A new key starts a new sequence of codes.
        user.LastTotpTimeStep = null;
        await users.ResetAuthenticatorKeyAsync(user);
        await signIn.RefreshSignInAsync(user);

        var key = (await users.GetAuthenticatorKeyAsync(user))!;
        var label = Uri.EscapeDataString($"{Issuer}:{user.Email}");
        var uri = string.Create(
            CultureInfo.InvariantCulture,
            $"otpauth://totp/{label}?secret={key}&issuer={Issuer}&digits=6&period=30");
        return TypedResults.Ok(new TwoFactorSetupDto(key, uri));
    }

    private static async Task<Results<Ok<RecoveryCodesDto>, ValidationProblem, UnauthorizedHttpResult>> ConfirmTwoFactorAsync(
        TwoFactorConfirmRequest request, HttpContext http, UserManager<AppUser> users, SignInManager<AppUser> signIn, ActivityLog activity, AppDbContext db)
    {
        if (await users.GetUserAsync(http.User) is not { } user)
        {
            return TypedResults.Unauthorized();
        }

        if (string.IsNullOrWhiteSpace(request.Code)
            || !await users.VerifyTwoFactorTokenAsync(user, users.Options.Tokens.AuthenticatorTokenProvider, request.Code))
        {
            return ApiProblems.Invalid("code", "The code is not right. Enter the current code from your authenticator app.");
        }

        await users.SetTwoFactorEnabledAsync(user, true);
        var codes = await users.GenerateNewTwoFactorRecoveryCodesAsync(user, RecoveryCodeCount);
        activity.Add(user.Id, ActivityActions.TwoFactorOn);
        await db.SaveChangesAsync();
        await signIn.RefreshSignInAsync(user);
        return TypedResults.Ok(new RecoveryCodesDto([.. codes!]));
    }

    /// <summary>
    /// Changes the password when the current one is right. The security stamp changes with it,
    /// so other sessions end at their next check while this one is signed in again.
    /// </summary>
    private static async Task<Results<NoContent, ValidationProblem, UnauthorizedHttpResult>> ChangePasswordAsync(
        PasswordChangeRequest request,
        HttpContext http,
        UserManager<AppUser> users,
        SignInManager<AppUser> signIn,
        AppDbContext db,
        AuditLog audit,
        AccountSessions sessions,
        ActivityLog activity)
    {
        if (await users.GetUserAsync(http.User) is not { } user)
        {
            return TypedResults.Unauthorized();
        }

        var errors = new Dictionary<string, string[]>();
        if (string.IsNullOrEmpty(request.CurrentPassword))
        {
            errors["currentPassword"] = ["Enter your current password."];
        }
        else if (!await users.CheckPasswordAsync(user, request.CurrentPassword))
        {
            errors["currentPassword"] = ["The current password is not right."];
        }

        if (string.IsNullOrEmpty(request.NewPassword))
        {
            errors["newPassword"] = ["Enter a new password."];
        }
        else if (await PasswordRules.ProblemsAsync(users, user, request.NewPassword) is { Length: > 0 } problems)
        {
            errors["newPassword"] = [problems];
        }

        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        await using var transaction = await db.Database.BeginTransactionAsync();
        Succeeded(await users.ChangePasswordAsync(user, request.CurrentPassword!, request.NewPassword!));
        audit.Add(AuditActions.UserUpdate, AuditTargetTypes.User, user.Id, new { passwordChanged = true });
        activity.Add(user.Id, ActivityActions.PasswordChanged);
        await db.SaveChangesAsync();
        await transaction.CommitAsync();

        // Every other browser and computer signs in again with the new password.
        await sessions.RevokeAllAsync(user.Id, AccountSessions.SessionId(http.User));
        await signIn.RefreshSignInAsync(user);
        return TypedResults.NoContent();
    }

    /// <summary>Turns two-factor off when the password is right; the authenticator key and recovery codes go with it.</summary>
    private static async Task<Results<NoContent, ValidationProblem, UnauthorizedHttpResult>> TurnOffTwoFactorAsync(
        [FromBody] TwoFactorOffRequest request,
        HttpContext http,
        UserManager<AppUser> users,
        SignInManager<AppUser> signIn,
        AppDbContext db,
        AuditLog audit,
        ActivityLog activity)
    {
        if (await users.GetUserAsync(http.User) is not { } user)
        {
            return TypedResults.Unauthorized();
        }

        if (string.IsNullOrEmpty(request.Password) || !await users.CheckPasswordAsync(user, request.Password))
        {
            return ApiProblems.Invalid("password", "The password is not right.");
        }

        await using var transaction = await db.Database.BeginTransactionAsync();
        await users.ClearTwoFactorAsync(user);
        audit.Add(AuditActions.UserTwoFactorReset, AuditTargetTypes.User, user.Id);
        activity.Add(user.Id, ActivityActions.TwoFactorOff);
        await db.SaveChangesAsync();
        await transaction.CommitAsync();
        await signIn.RefreshSignInAsync(user);
        return TypedResults.NoContent();
    }

    /// <summary>
    /// Ten new recovery codes for a code from the authenticator. The old ones stop working, and
    /// the new ones are shown in this response only.
    /// </summary>
    private static async Task<Results<Created<RecoveryCodesDto>, ValidationProblem, UnauthorizedHttpResult>> RenewRecoveryCodesAsync(
        TwoFactorConfirmRequest request,
        HttpContext http,
        UserManager<AppUser> users,
        AppDbContext db,
        AuditLog audit)
    {
        if (await users.GetUserAsync(http.User) is not { } user)
        {
            return TypedResults.Unauthorized();
        }

        if (!user.TwoFactorEnabled)
        {
            return ApiProblems.Invalid("code", "Two-factor is off. Recovery codes come with turning it on.");
        }

        if (string.IsNullOrWhiteSpace(request.Code)
            || !await users.VerifyTwoFactorTokenAsync(user, users.Options.Tokens.AuthenticatorTokenProvider, request.Code))
        {
            return ApiProblems.Invalid("code", "The code is not right. Enter the current code from your authenticator app.");
        }

        await using var transaction = await db.Database.BeginTransactionAsync();
        var codes = await users.GenerateNewTwoFactorRecoveryCodesAsync(user, RecoveryCodeCount);
        audit.Add(AuditActions.UserUpdate, AuditTargetTypes.User, user.Id, new { recoveryCodesRenewed = true });
        await db.SaveChangesAsync();
        await transaction.CommitAsync();
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Created((string?)null, new RecoveryCodesDto([.. codes!]));
    }

    /// <summary>Two-factor off, with no authenticator key or recovery codes left. The caller adds the audit entry and commits.</summary>
    internal static async Task ClearTwoFactorAsync(this UserManager<AppUser> users, AppUser user)
    {
        Succeeded(await users.SetTwoFactorEnabledAsync(user, false));
        await users.GenerateNewTwoFactorRecoveryCodesAsync(user, 0);
        user.LastTotpTimeStep = null;
        Succeeded(await users.ResetAuthenticatorKeyAsync(user));
    }

    private static void Succeeded(IdentityResult result)
    {
        if (!result.Succeeded)
        {
            throw new InvalidOperationException(string.Join("; ", result.Errors.Select(e => e.Code)));
        }
    }
}
