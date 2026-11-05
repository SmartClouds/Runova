using System.Net.Mail;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Identity;
using Runova.Website.Api.Email;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Problems;
using Runova.Website.Api.Users;
using Runova.Website.Core.Accounts;
using Runova.Website.Core.Email;
using Runova.Website.Core.Identity;
using Runova.Website.Core.Problems;
using Runova.Website.Data;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Accounts;

/// <summary>
/// Signing up for a Runova account, confirming its email, resetting a forgotten password, and the
/// account itself. Every anonymous route answers the same way whether or not an address has an
/// account, so none of them tells a stranger who is registered.
/// </summary>
internal static class AccountEndpoints
{
    public const int DisplayNameMax = 100;

    public static RouteGroupBuilder MapAccounts(this RouteGroupBuilder api)
    {
        api.MapPost("/accounts", RegisterAsync).AllowAnonymous().WithMetadata(RequiresAntiforgery.Instance).RequireRateLimiting(AuthRateLimits.Policy);
        api.MapPost("/email-verifications", VerifyAsync).AllowAnonymous().WithMetadata(RequiresAntiforgery.Instance).RequireRateLimiting(AuthRateLimits.Policy);
        api.MapPost("/verification-emails", ResendVerificationAsync).AllowAnonymous().WithMetadata(RequiresAntiforgery.Instance).RequireRateLimiting(AuthRateLimits.Policy);
        api.MapPost("/password-resets", RequestResetAsync).AllowAnonymous().WithMetadata(RequiresAntiforgery.Instance).RequireRateLimiting(AuthRateLimits.Policy);

        var me = api.MapGroup("/accounts/me").RequireAuthorization(Policies.Account);
        me.MapGet("", GetAsync);
        me.MapPatch("", UpdateAsync).Accepts<AccountPatch>("application/merge-patch+json");
        return api;
    }

    /// <summary>
    /// A new account, or a fresh link for one that was never confirmed (its password is replaced,
    /// so whoever started it first can not sign in with theirs). A confirmed address gets an email
    /// saying so instead, and its password is left alone.
    /// </summary>
    private static async Task<Results<Accepted, ValidationProblem>> RegisterAsync(
        RegisterRequest request,
        UserManager<AppUser> users,
        AppDbContext db,
        SetupLinks links,
        EmailOutbox outbox,
        IConfiguration configuration,
        TimeProvider time)
    {
        var errors = new Dictionary<string, string[]>();
        var email = request.Email?.Trim() ?? "";
        if (!IsEmail(email))
        {
            errors["email"] = ["Enter an email address, like sam@example.com."];
        }

        var displayName = request.DisplayName?.Trim() ?? "";
        if (displayName.Length is 0 or > DisplayNameMax)
        {
            errors["displayName"] = [$"Enter your name, up to {DisplayNameMax} characters."];
        }

        if (string.IsNullOrEmpty(request.Password))
        {
            errors["password"] = ["Enter a password."];
        }
        else if (await PasswordRules.ProblemsAsync(users, new AppUser { Email = email, UserName = email }, request.Password) is { Length: > 0 } problems)
        {
            errors["password"] = [problems];
        }

        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        await using var transaction = await db.Database.BeginTransactionAsync();
        var existing = await users.FindByEmailAsync(email);
        if (existing is { EmailConfirmed: true })
        {
            // As long as a new account takes, so the answer's timing tells nothing either.
            users.PasswordHasher.HashPassword(existing, request.Password!);
            var site = SiteUrl.From(configuration);
            outbox.Add(existing.Email!, EmailTemplates.AlreadyRegistered(existing.DisplayName, $"{site}/account/sign-in", $"{site}/account/forgot-password"));
        }
        else
        {
            var user = existing ?? new AppUser { UserName = email, Email = email, CreatedAt = time.GetUtcNow() };
            user.DisplayName = displayName;
            if (existing is null)
            {
                Succeeded(await users.CreateAsync(user, request.Password!));
            }
            else
            {
                if (await users.HasPasswordAsync(user))
                {
                    Succeeded(await users.RemovePasswordAsync(user));
                }

                Succeeded(await users.AddPasswordAsync(user, request.Password!));
            }

            var link = await links.IssueAsync(user, SetupLinkPurposes.EmailVerification);
            outbox.Add(email, EmailTemplates.VerifyEmail(displayName, link.Url));
        }

        await db.SaveChangesAsync();
        await transaction.CommitAsync();
        outbox.SendSoon();
        return TypedResults.Accepted((string?)null);
    }

    /// <summary>
    /// Confirms the email a link was sent to, and signs in when the account has no two-factor (a
    /// new one never has). With two-factor on, the person signs in as usual.
    /// </summary>
    private static async Task<Results<Ok<EmailVerificationDto>, ValidationProblem, ProblemHttpResult>> VerifyAsync(
        TokenRequest request,
        UserManager<AppUser> users,
        SignInManager<AppUser> signIn,
        AppDbContext db,
        SetupLinks links,
        TimeProvider time,
        HttpContext http)
    {
        if (string.IsNullOrEmpty(request.Token))
        {
            return ApiProblems.Invalid("token", "The link has no token. Open the link from the email again.");
        }

        await using var transaction = await db.Database.BeginTransactionAsync();
        var link = await links.FindAsync(request.Token, _emailVerificationPurpose);
        var user = link is null ? null : await users.FindByIdAsync(link.UserId.ToString(System.Globalization.CultureInfo.InvariantCulture));
        if (link is null || user is null || !await links.UseAsync(link))
        {
            return ApiProblems.Of(ProblemTypes.NotFound, "This link is not valid. It may have been used or expired. Ask for a new one.");
        }

        user.EmailConfirmed = true;
        var signedIn = !user.TwoFactorEnabled && user.DisabledAt is null;
        if (signedIn)
        {
            user.LastSignInAt = time.GetUtcNow();
        }

        Succeeded(await users.UpdateAsync(user));
        await db.SaveChangesAsync();
        await transaction.CommitAsync();

        if (signedIn)
        {
            await signIn.SignInAsync(user, isPersistent: true);
            http.User = await signIn.CreateUserPrincipalAsync(user);
            AntiforgeryCheck.IssueToken(http);
        }

        return TypedResults.Ok(new EmailVerificationDto(signedIn));
    }

    private static readonly IReadOnlySet<string> _emailVerificationPurpose = new HashSet<string>(StringComparer.Ordinal) { SetupLinkPurposes.EmailVerification };

    private static async Task<Results<Accepted, ValidationProblem>> ResendVerificationAsync(
        EmailRequest request, UserManager<AppUser> users, AppDbContext db, SetupLinks links, EmailOutbox outbox)
    {
        var email = request.Email?.Trim() ?? "";
        if (!IsEmail(email))
        {
            return ApiProblems.Invalid("email", "Enter an email address, like sam@example.com.");
        }

        await using var transaction = await db.Database.BeginTransactionAsync();
        if (await users.FindByEmailAsync(email) is { EmailConfirmed: false, DisabledAt: null } user)
        {
            var link = await links.IssueAsync(user, SetupLinkPurposes.EmailVerification);
            outbox.Add(user.Email!, EmailTemplates.VerifyEmail(user.DisplayName, link.Url));
        }

        await db.SaveChangesAsync();
        await transaction.CommitAsync();
        outbox.SendSoon();
        return TypedResults.Accepted((string?)null);
    }

    /// <summary>A reset link for an account that exists and is not disabled; the same answer otherwise.</summary>
    private static async Task<Results<Accepted, ValidationProblem>> RequestResetAsync(
        EmailRequest request, UserManager<AppUser> users, AppDbContext db, SetupLinks links, EmailOutbox outbox)
    {
        var email = request.Email?.Trim() ?? "";
        if (!IsEmail(email))
        {
            return ApiProblems.Invalid("email", "Enter an email address, like sam@example.com.");
        }

        await using var transaction = await db.Database.BeginTransactionAsync();
        if (await users.FindByEmailAsync(email) is { DisabledAt: null } user)
        {
            var link = await links.IssueAsync(user, SetupLinkPurposes.AccountReset);
            outbox.Add(user.Email!, EmailTemplates.ResetPassword(user.DisplayName, link.Url));
        }

        await db.SaveChangesAsync();
        await transaction.CommitAsync();
        outbox.SendSoon();
        return TypedResults.Accepted((string?)null);
    }

    private static async Task<Results<Ok<AccountDto>, UnauthorizedHttpResult>> GetAsync(
        HttpContext http, UserManager<AppUser> users)
    {
        if (await users.GetUserAsync(http.User) is not { } user)
        {
            return TypedResults.Unauthorized();
        }

        var dto = await users.ToAccountDtoAsync(user);
        Versions.SetETag(http.Response, user.Version);
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(dto);
    }

    private static async Task<Results<Ok<AccountDto>, ValidationProblem, ProblemHttpResult, UnauthorizedHttpResult>> UpdateAsync(
        HttpContext http, UserManager<AppUser> users)
    {
        if (await users.GetUserAsync(http.User) is not { } user)
        {
            return TypedResults.Unauthorized();
        }

        if (Versions.CheckIfMatch(http.Request, user.Version) is { } precondition)
        {
            return precondition;
        }

        JsonObject? body;
        try
        {
            body = await JsonNode.ParseAsync(http.Request.Body, cancellationToken: http.RequestAborted) as JsonObject;
        }
        catch (JsonException)
        {
            body = null;
        }

        if (body is null)
        {
            return ApiProblems.Invalid("body", "Send a JSON merge patch object.");
        }

        foreach (var (field, value) in body)
        {
            if (field != "displayName")
            {
                return ApiProblems.Invalid(field, "Only displayName can be changed here.");
            }

            var name = value is JsonValue text && text.TryGetValue<string>(out var s) ? s.Trim() : "";
            if (name.Length is 0 or > DisplayNameMax)
            {
                return ApiProblems.Invalid("displayName", $"Enter your name, up to {DisplayNameMax} characters.");
            }

            user.DisplayName = name;
        }

        Succeeded(await users.UpdateAsync(user));
        Versions.SetETag(http.Response, user.Version);
        return TypedResults.Ok(await users.ToAccountDtoAsync(user));
    }

    internal static async Task<AccountDto> ToAccountDtoAsync(this UserManager<AppUser> users, AppUser user)
    {
        var roles = await users.GetRolesAsync(user);
        var logins = await users.GetLoginsAsync(user);
        return new AccountDto(
            user.Id,
            user.Email ?? "",
            user.DisplayName,
            user.EmailConfirmed,
            await users.HasPasswordAsync(user),
            user.TwoFactorEnabled,
            [.. logins.Select(l => l.LoginProvider.ToLowerInvariant()).Order(StringComparer.Ordinal)],
            roles.Contains(Roles.Admin) || roles.Contains(Roles.Editor),
            user.CreatedAt,
            user.LastSignInAt,
            user.Version.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }

    /// <summary>A plain address with an @ and a dot in the domain, as MailAddress reads it, and nothing else around it.</summary>
    internal static bool IsEmail(string email) =>
        email.Length is > 3 and <= 254
        && MailAddress.TryCreate(email, out var parsed)
        && parsed.Address == email
        && parsed.Host.Contains('.', StringComparison.Ordinal);

    private static void Succeeded(IdentityResult result)
    {
        if (!result.Succeeded)
        {
            throw new InvalidOperationException(string.Join(" ", result.Errors.Select(e => $"{e.Code}: {e.Description}")));
        }
    }
}

/// <summary>What an account may change about itself with a merge patch.</summary>
public sealed record AccountPatch(string? DisplayName);
