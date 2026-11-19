using System.Globalization;
using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Google;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Accounts;
using Runova.Website.Core.Problems;
using Runova.Website.Data;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Accounts;

/// <summary>
/// What the sign-in pages show: the providers to offer, and the captcha widget's public key when
/// the captcha is on (null when it is off).
/// </summary>
public sealed record SignInProvidersDto(IReadOnlyList<string> Items, CaptchaDto? Captcha);

public sealed record CaptchaDto(string Provider, string SiteKey);

public sealed record TwoFactorSignInRequest(string? Code, string? RecoveryCode);

/// <summary>
/// Google sign-in, with the keys an Admin saved in the sign-in settings or, without those,
/// <c>Authentication__Google__*</c>. Without both keys, or switched off, Google is off.
/// </summary>
internal static class GoogleSignIn
{
    /// <summary>
    /// The Google handler, always registered and configured when first used. Its options are made
    /// again whenever the sign-in settings change, so new keys work without a restart. Google signs
    /// in to Identity's external cookie only; the endpoints below turn that into an account
    /// session. Only a verified email is ever trusted.
    /// </summary>
    public static IServiceCollection AddGoogleSignIn(this IServiceCollection services)
    {
        services.AddAuthentication().AddGoogle(_ => { });
        services.AddSingleton<IOptionsChangeTokenSource<GoogleOptions>>(provider =>
            new SignInSettingsChangeTokenSource<GoogleOptions>(GoogleDefaults.AuthenticationScheme, provider.GetRequiredService<SignInSettingsStore>()));
        services.AddOptions<GoogleOptions>(GoogleDefaults.AuthenticationScheme).Configure<SignInSettingsStore>((options, store) =>
        {
            var settings = store.Current;
            options.ClientId = settings.GoogleClientId ?? "not-configured";
            options.ClientSecret = settings.GoogleClientSecret ?? "not-configured";
            options.CallbackPath = ExternalProviders.Google.CallbackPath;
            options.SignInScheme = IdentityConstants.ExternalScheme;
            options.SaveTokens = false;
            options.ClaimActions.MapJsonKey("email_verified", "email_verified");
            options.ClaimActions.MapJsonKey("email_verified", "verified_email");

            // Pressing Cancel at Google, or a failed exchange, lands on the sign-in page with a reason.
            options.Events.OnRemoteFailure = context => ExternalProviders.OnRemoteFailure(ExternalProviders.Google, context);
        });
        return services;
    }
}

/// <summary>
/// "Continue with Google", Apple or Microsoft for Runova accounts (E48.3, E116), as browser
/// redirects. <see cref="ExternalAccounts"/> holds the rules for which account a login belongs to.
/// Two-factor still applies after the provider.
/// </summary>
internal static class ExternalSignInEndpoints
{
    internal const string SignInPage = "/account/sign-in";
    internal const string DefaultReturn = "/account";

    /// <summary>The site's page a provider's callback lands on before <c>/external-sign-ins/current</c>.</summary>
    internal const string FinishPage = "/account/external-sign-in";

    /// <summary>Identity's own item for the user a link is for, checked by GetExternalLoginInfoAsync.</summary>
    private const string LinkItem = "XsrfId";

    /// <summary>Identity's own item for the scheme a sign-in started with.</summary>
    private const string LoginProviderItem = "LoginProvider";

    public static RouteGroupBuilder MapExternalSignIns(this RouteGroupBuilder api)
    {
        api.MapGet("/sign-in-providers", ListProvidersAsync).AllowAnonymous();
        api.MapGet("/external-sign-ins/{provider}", StartAsync).AllowAnonymous().Produces(StatusCodes.Status302Found);
        api.MapGet("/external-sign-ins/current", FinishAsync).AllowAnonymous().Produces(StatusCodes.Status302Found);
        api.MapPost("/two-factor-sign-ins", TwoFactorAsync).AllowAnonymous().WithMetadata(RequiresAntiforgery.Instance).RequireRateLimiting(AuthRateLimits.Policy);
        api.MapDelete("/accounts/me/logins/{provider}", UnlinkAsync).RequireAuthorization(Policies.Account);
        return api;
    }

    private static async Task<Ok<SignInProvidersDto>> ListProvidersAsync(SignInSettingsStore store, CancellationToken cancellationToken)
    {
        var settings = await store.GetAsync(cancellationToken);
        return TypedResults.Ok(new SignInProvidersDto(
            [.. ExternalProviders.All.Where(p => p.IsActive(settings)).Select(p => p.Name)],
            settings.CaptchaActive ? new CaptchaDto("turnstile", settings.TurnstileSiteKey!) : null));
    }

    /// <summary>
    /// A path on this site, or the account page. Never another origin: no backslash and no control
    /// character anywhere, since a browser drops tabs and newlines and would read a slash, a tab and
    /// a slash as "//", another site.
    /// </summary>
    internal static string SafeReturn(string? returnUrl) =>
        returnUrl is { Length: > 0 and < 512 } path
        && path[0] == '/'
        && !path.StartsWith("//", StringComparison.Ordinal)
        && !path.Contains('\\', StringComparison.Ordinal)
        && !path.Any(char.IsControl)
        && !path.Contains("://", StringComparison.Ordinal)
            ? path
            : DefaultReturn;

    private static async Task<Results<ChallengeHttpResult, ProblemHttpResult>> StartAsync(
        string provider, string? returnUrl, bool? link, HttpContext http, SignInSettingsStore store, SignInManager<AppUser> signIn, UserManager<AppUser> users)
    {
        if (!ExternalProviders.TryFind(provider, out var found) || !found.IsActive(await store.GetAsync(http.RequestAborted)))
        {
            return ApiProblems.Of(ProblemTypes.NotFound, "That sign-in provider is not available here.");
        }

        var back = SafeReturn(returnUrl);
        var userId = link == true && await users.GetUserAsync(http.User) is { } user
            ? user.Id.ToString(CultureInfo.InvariantCulture)
            : null;
        // The provider comes back from another site, so the browser would leave the SameSite=Strict
        // session cookie off the rest of the chain. The site's hop page moves on to
        // /external-sign-ins/current by script, a navigation of this site's own (E116).
        var finish = $"{FinishPage}?returnUrl={Uri.EscapeDataString(back)}";
        var properties = signIn.ConfigureExternalAuthenticationProperties(found.Scheme, finish, userId);
        return TypedResults.Challenge(properties, [found.Scheme]);
    }

    private static async Task<RedirectHttpResult> FinishAsync(
        string? returnUrl,
        HttpContext http,
        SignInManager<AppUser> signIn,
        UserManager<AppUser> users,
        ExternalAccounts accounts,
        AppleTokens appleTokens,
        SignInSettingsStore store,
        AppDbContext db,
        ActivityLog activity)
    {
        var back = SafeReturn(returnUrl);
        var external = await http.AuthenticateAsync(IdentityConstants.ExternalScheme);
        var linking = external.Properties?.Items.ContainsKey(LinkItem) == true;

        // A link started by one account finishes only for that account, still signed in here.
        var linkFor = linking ? users.GetUserId(http.User) : null;
        var info = linking && linkFor is null ? null : await signIn.GetExternalLoginInfoAsync(linkFor);
        await http.SignOutAsync(IdentityConstants.ExternalScheme);
        var provider = ExternalProviders.ForScheme(info?.LoginProvider ?? external.Properties?.GetString(LoginProviderItem));
        if (info is null || provider is null)
        {
            return Fail((provider ?? ExternalProviders.Google).FailedCode, back);
        }

        if (linkFor is not null)
        {
            var me = await users.FindByIdAsync(linkFor);
            if (me is null)
            {
                return Fail(provider.FailedCode, back);
            }

            var owner = await users.FindByLoginAsync(info.LoginProvider, info.ProviderKey);
            if (owner is not null && owner.Id != me.Id)
            {
                return TypedResults.Redirect(WithQuery(back, "error=login-taken"));
            }

            if (owner is null)
            {
                ExternalAccounts.Succeeded(await users.AddLoginAsync(me, info));
                activity.Add(me.Id, ActivityActions.LoginLinked, new { provider = provider.Name });
                await db.SaveChangesAsync();
                await KeepAppleTokenAsync(me);
                await signIn.RefreshSignInAsync(me);
            }

            return TypedResults.Redirect(WithQuery(back, $"linked={provider.Name}"));
        }

        var account = await accounts.ResolveAsync(info, provider);
        if (account.Owner is not { } found)
        {
            return Fail(account.Error!, back);
        }

        if (found.DisabledAt is not null)
        {
            return Fail("disabled", back);
        }

        await KeepAppleTokenAsync(found);

        var result = await signIn.ExternalLoginSignInAsync(info.LoginProvider, info.ProviderKey, isPersistent: true, bypassTwoFactor: false);
        if (result.RequiresTwoFactor)
        {
            return TypedResults.Redirect($"{SignInPage}?step=two-factor&returnUrl={Uri.EscapeDataString(back)}");
        }

        if (!result.Succeeded)
        {
            return Fail(result.IsLockedOut ? "locked" : provider.FailedCode, back);
        }

        await activity.MarkSignedInAsync(found.Id);
        await activity.SaveNowAsync(found.Id, ActivityActions.SignIn, new { method = provider.Name });
        return TypedResults.Redirect(back);

        // Apple's refresh token, kept sealed so it can be revoked when the account goes (E116).
        async Task KeepAppleTokenAsync(AppUser user)
        {
            if (provider == ExternalProviders.Apple
                && info.AuthenticationTokens?.FirstOrDefault(t => t.Name == AppleTokens.TokenName)?.Value is { Length: > 0 } refresh
                && (await store.GetAsync(http.RequestAborted)).AppleServicesId is { } servicesId)
            {
                await appleTokens.KeepAsync(user, servicesId, refresh);
            }
        }
    }

    /// <summary>The second step after a provider, for an account with two-factor on.</summary>
    private static async Task<Results<NoContent, ProblemHttpResult>> TwoFactorAsync(
        TwoFactorSignInRequest request, HttpContext http, SignInManager<AppUser> signIn, UserManager<AppUser> users, AppDbContext db, ActivityLog activity)
    {
        if (await signIn.GetTwoFactorAuthenticationUserAsync() is not { } user)
        {
            return ApiProblems.Of(ProblemTypes.Unauthorized, "Start signing in again.");
        }

        // Identity keeps the provider of the first step on its two-factor cookie.
        var firstStep = await http.AuthenticateAsync(IdentityConstants.TwoFactorUserIdScheme);
        var method = ExternalProviders.ForScheme(firstStep.Principal?.FindFirstValue(ClaimTypes.AuthenticationMethod))?.Name;

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

        await activity.SaveNowAsync(user.Id, ActivityActions.SignIn, new { method });
        http.User = await signIn.CreateUserPrincipalAsync(user);
        AntiforgeryCheck.IssueToken(http);
        return TypedResults.NoContent();
    }

    private static async Task<Results<NoContent, ProblemHttpResult, UnauthorizedHttpResult>> UnlinkAsync(
        string provider, HttpContext http, UserManager<AppUser> users, SignInManager<AppUser> signIn, AppleTokens appleTokens, AppDbContext db, ActivityLog activity)
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

        ExternalAccounts.Succeeded(await users.RemoveLoginAsync(user, login.LoginProvider, login.ProviderKey));
        if (ExternalProviders.ForScheme(login.LoginProvider) == ExternalProviders.Apple)
        {
            await appleTokens.RevokeAsync(user, forget: true, http.RequestAborted);
        }

        activity.Add(user.Id, ActivityActions.LoginUnlinked, new { provider = provider.ToLowerInvariant() });
        await db.SaveChangesAsync();
        await signIn.RefreshSignInAsync(user);
        return TypedResults.NoContent();
    }

    private static RedirectHttpResult Fail(string error, string back) => TypedResults.Redirect(ExternalProviders.FailurePath(error, back));

    private static string WithQuery(string path, string query) => path + (path.Contains('?', StringComparison.Ordinal) ? "&" : "?") + query;
}
