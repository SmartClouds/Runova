using System.Globalization;
using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Google;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Accounts;
using Runova.Website.Core.Problems;
using Runova.Website.Data;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Accounts;

public sealed record SignInProvidersDto(IReadOnlyList<string> Items);

public sealed record TwoFactorSignInRequest(string? Code, string? RecoveryCode);

/// <summary>Google sign-in settings, from <c>Authentication__Google__*</c>. Without both, Google is off.</summary>
internal static class GoogleSignIn
{
    public const string Provider = "google";
    public const string CallbackPath = "/api/oauth/google/callback";

    public static bool IsConfigured(IConfiguration configuration) =>
        !string.IsNullOrWhiteSpace(configuration["Authentication:Google:ClientId"])
        && !string.IsNullOrWhiteSpace(configuration["Authentication:Google:ClientSecret"]);

    /// <summary>
    /// The Google handler, always registered and configured when first used, so settings a host adds
    /// late are still seen. Google signs in to Identity's external cookie only; the endpoints below
    /// turn that into an account session. Only a verified email is ever trusted.
    /// </summary>
    public static IServiceCollection AddGoogleSignIn(this IServiceCollection services)
    {
        services.AddAuthentication().AddGoogle(_ => { });
        services.AddOptions<GoogleOptions>(GoogleDefaults.AuthenticationScheme).Configure<IConfiguration>((options, configuration) =>
        {
            options.ClientId = configuration["Authentication:Google:ClientId"] ?? "not-configured";
            options.ClientSecret = configuration["Authentication:Google:ClientSecret"] ?? "not-configured";
            options.CallbackPath = CallbackPath;
            options.SignInScheme = IdentityConstants.ExternalScheme;
            options.SaveTokens = false;
            options.ClaimActions.MapJsonKey("email_verified", "email_verified");
            options.ClaimActions.MapJsonKey("email_verified", "verified_email");

            // Pressing Cancel at Google, or a failed exchange, lands on the sign-in page with a reason.
            options.Events.OnRemoteFailure = context =>
            {
                context.Response.Redirect("/account/sign-in?error=google-failed");
                context.HandleResponse();
                return Task.CompletedTask;
            };
        });
        return services;
    }
}

/// <summary>
/// "Continue with Google" for Runova accounts (E48.3), as browser redirects. A Google login is
/// never linked to an existing account by email alone: an account with that address that someone
/// confirmed must sign in with its password and link Google from Security. An address nobody
/// confirmed goes to the Google owner, and the password it was registered with stops working.
/// Two-factor still applies after Google.
/// </summary>
internal static class ExternalSignInEndpoints
{
    private const string SignInPage = "/account/sign-in";
    private const string DefaultReturn = "/account";

    /// <summary>Identity's own item for the user a link is for, checked by GetExternalLoginInfoAsync.</summary>
    private const string LinkItem = "XsrfId";

    public static RouteGroupBuilder MapExternalSignIns(this RouteGroupBuilder api)
    {
        api.MapGet("/sign-in-providers", ListProviders).AllowAnonymous();
        api.MapGet("/external-sign-ins/{provider}", StartAsync).AllowAnonymous().Produces(StatusCodes.Status302Found);
        api.MapGet("/external-sign-ins/current", FinishAsync).AllowAnonymous().Produces(StatusCodes.Status302Found);
        api.MapPost("/two-factor-sign-ins", TwoFactorAsync).AllowAnonymous().WithMetadata(RequiresAntiforgery.Instance).RequireRateLimiting(AuthRateLimits.Policy);
        api.MapDelete("/accounts/me/logins/{provider}", UnlinkAsync).RequireAuthorization(Policies.Account);
        return api;
    }

    private static Ok<SignInProvidersDto> ListProviders(IConfiguration configuration) =>
        TypedResults.Ok(new SignInProvidersDto(GoogleSignIn.IsConfigured(configuration) ? [GoogleSignIn.Provider] : []));

    /// <summary>A path on this site, or the account page. Never another origin.</summary>
    internal static string SafeReturn(string? returnUrl) =>
        returnUrl is { Length: > 0 and < 512 } path
        && path[0] == '/'
        && !path.StartsWith("//", StringComparison.Ordinal)
        && !path.StartsWith("/\\", StringComparison.Ordinal)
        && !path.Contains("://", StringComparison.Ordinal)
            ? path
            : DefaultReturn;

    private static async Task<Results<ChallengeHttpResult, ProblemHttpResult>> StartAsync(
        string provider, string? returnUrl, bool? link, HttpContext http, IConfiguration configuration, SignInManager<AppUser> signIn, UserManager<AppUser> users)
    {
        if (provider != GoogleSignIn.Provider || !GoogleSignIn.IsConfigured(configuration))
        {
            return ApiProblems.Of(ProblemTypes.NotFound, "That sign-in provider is not available here.");
        }

        var back = SafeReturn(returnUrl);
        var userId = link == true && await users.GetUserAsync(http.User) is { } user
            ? user.Id.ToString(CultureInfo.InvariantCulture)
            : null;
        var finish = $"/api/v1/external-sign-ins/current?returnUrl={Uri.EscapeDataString(back)}";
        var properties = signIn.ConfigureExternalAuthenticationProperties(GoogleDefaults.AuthenticationScheme, finish, userId);
        return TypedResults.Challenge(properties, [GoogleDefaults.AuthenticationScheme]);
    }

    private static async Task<RedirectHttpResult> FinishAsync(
        string? returnUrl,
        HttpContext http,
        SignInManager<AppUser> signIn,
        UserManager<AppUser> users,
        AppDbContext db,
        ActivityLog activity,
        TimeProvider time)
    {
        var back = SafeReturn(returnUrl);
        var external = await http.AuthenticateAsync(IdentityConstants.ExternalScheme);
        var linking = external.Properties?.Items.ContainsKey(LinkItem) == true;

        // A link started by one account finishes only for that account, still signed in here.
        var linkFor = linking ? users.GetUserId(http.User) : null;
        var info = linking && linkFor is null ? null : await signIn.GetExternalLoginInfoAsync(linkFor);
        await http.SignOutAsync(IdentityConstants.ExternalScheme);
        if (info is null)
        {
            return Fail("google-failed");
        }

        var email = info.Principal.FindFirstValue(ClaimTypes.Email);
        var verified = string.Equals(info.Principal.FindFirstValue("email_verified"), "true", StringComparison.OrdinalIgnoreCase);
        var name = info.Principal.FindFirstValue(ClaimTypes.Name);
        var owner = await users.FindByLoginAsync(info.LoginProvider, info.ProviderKey);

        if (linkFor is not null)
        {
            var me = await users.FindByIdAsync(linkFor);
            if (me is null)
            {
                return Fail("google-failed");
            }

            if (owner is not null && owner.Id != me.Id)
            {
                return TypedResults.Redirect(WithQuery(back, "error=login-taken"));
            }

            if (owner is null)
            {
                Succeeded(await users.AddLoginAsync(me, info));
                activity.Add(me.Id, ActivityActions.LoginLinked, new { provider = GoogleSignIn.Provider });
                await db.SaveChangesAsync();
                await signIn.RefreshSignInAsync(me);
            }

            return TypedResults.Redirect(WithQuery(back, "linked=google"));
        }

        if (owner is null)
        {
            if (!verified || string.IsNullOrWhiteSpace(email))
            {
                return Fail("email-unverified");
            }

            var existing = await users.FindByEmailAsync(email);
            if (existing is { EmailConfirmed: true })
            {
                return Fail("link-needed");
            }

            await using var transaction = await db.Database.BeginTransactionAsync();
            owner = existing ?? new AppUser { UserName = email, Email = email, CreatedAt = time.GetUtcNow() };
            owner.EmailConfirmed = true;
            owner.DisplayName = string.IsNullOrWhiteSpace(name) ? email.Split('@')[0] : name.Trim()[..Math.Min(name.Trim().Length, AccountEndpoints.DisplayNameMax)];
            if (existing is null)
            {
                Succeeded(await users.CreateAsync(owner));
            }
            else
            {
                // Whoever typed this address in never proved it; the Google owner just did.
                if (await users.HasPasswordAsync(owner))
                {
                    Succeeded(await users.RemovePasswordAsync(owner));
                }

                await db.SetupLinks.Where(l => l.UserId == owner.Id).ExecuteDeleteAsync();
                Succeeded(await users.UpdateAsync(owner));
            }

            Succeeded(await users.AddLoginAsync(owner, info));
            activity.Add(owner.Id, ActivityActions.LoginLinked, new { provider = GoogleSignIn.Provider });
            await db.SaveChangesAsync();
            await transaction.CommitAsync();
        }

        if (owner.DisabledAt is not null)
        {
            return Fail("disabled");
        }

        var result = await signIn.ExternalLoginSignInAsync(info.LoginProvider, info.ProviderKey, isPersistent: true, bypassTwoFactor: false);
        if (result.RequiresTwoFactor)
        {
            return TypedResults.Redirect($"{SignInPage}?step=two-factor&returnUrl={Uri.EscapeDataString(back)}");
        }

        if (!result.Succeeded)
        {
            return Fail(result.IsLockedOut ? "locked" : "google-failed");
        }

        await activity.MarkSignedInAsync(owner.Id);
        await activity.SaveNowAsync(owner.Id, ActivityActions.SignIn, new { method = GoogleSignIn.Provider });
        return TypedResults.Redirect(back);
    }

    /// <summary>The second step after Google for an account with two-factor on.</summary>
    private static async Task<Results<NoContent, ProblemHttpResult>> TwoFactorAsync(
        TwoFactorSignInRequest request, HttpContext http, SignInManager<AppUser> signIn, UserManager<AppUser> users, AppDbContext db, ActivityLog activity)
    {
        if (await signIn.GetTwoFactorAuthenticationUserAsync() is not { } user)
        {
            return ApiProblems.Of(ProblemTypes.Unauthorized, "Start signing in again.");
        }

        var result = request switch
        {
            { Code: { Length: > 0 } code } => await signIn.TwoFactorAuthenticatorSignInAsync(code.Replace(" ", "", StringComparison.Ordinal), isPersistent: true, rememberClient: false),
            { RecoveryCode: { Length: > 0 } recovery } => await signIn.TwoFactorRecoveryCodeSignInAsync(recovery.Replace(" ", "", StringComparison.Ordinal)),
            _ => null,
        };

        if (result is not { Succeeded: true })
        {
            await activity.SaveNowAsync(user.Id, ActivityActions.SignInFailed, new { reason = "two-factor" });
            return result is { IsLockedOut: true }
                ? ApiProblems.Of(ProblemTypes.AccountLocked, "Too many failed sign-ins in a row. Try again later.")
                : ApiProblems.Of(ProblemTypes.TwoFactorRequired, "The code is not right or was already used.");
        }

        await activity.SaveNowAsync(user.Id, ActivityActions.SignIn, new { method = GoogleSignIn.Provider });
        http.User = await signIn.CreateUserPrincipalAsync(user);
        AntiforgeryCheck.IssueToken(http);
        return TypedResults.NoContent();
    }

    private static async Task<Results<NoContent, ProblemHttpResult, UnauthorizedHttpResult>> UnlinkAsync(
        string provider, HttpContext http, UserManager<AppUser> users, SignInManager<AppUser> signIn, AppDbContext db, ActivityLog activity)
    {
        if (await users.GetUserAsync(http.User) is not { } user)
        {
            return TypedResults.Unauthorized();
        }

        var logins = await users.GetLoginsAsync(user);
        var login = logins.FirstOrDefault(l => string.Equals(l.LoginProvider, provider, StringComparison.OrdinalIgnoreCase));
        if (login is null)
        {
            return ApiProblems.Of(ProblemTypes.NotFound, "That sign-in is not linked to your account.");
        }

        if (!await users.HasPasswordAsync(user) && logins.Count <= 1)
        {
            return ApiProblems.Of(ProblemTypes.Conflict, "This is your only way to sign in. Set a password first, then unlink it.");
        }

        Succeeded(await users.RemoveLoginAsync(user, login.LoginProvider, login.ProviderKey));
        activity.Add(user.Id, ActivityActions.LoginUnlinked, new { provider = provider.ToLowerInvariant() });
        await db.SaveChangesAsync();
        await signIn.RefreshSignInAsync(user);
        return TypedResults.NoContent();
    }

    private static RedirectHttpResult Fail(string error) => TypedResults.Redirect($"{SignInPage}?error={error}");

    private static string WithQuery(string path, string query) => path + (path.Contains('?', StringComparison.Ordinal) ? "&" : "?") + query;

    private static void Succeeded(IdentityResult result)
    {
        if (!result.Succeeded)
        {
            throw new InvalidOperationException(string.Join(" ", result.Errors.Select(e => $"{e.Code}: {e.Description}")));
        }
    }
}
