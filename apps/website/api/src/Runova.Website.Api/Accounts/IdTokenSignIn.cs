using System.Buffers.Text;
using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Protocols;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.IdentityModel.Tokens;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Problems;
using Runova.Website.Data;
using Runova.Website.Data.Accounts;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Accounts;

public sealed record SignInNonceRequest(string? Provider);

/// <summary>
/// A nonce for the phone's own Google or Apple sheet, and for Google the web client id that
/// Credential Manager asks for (public, the same one the website signs in with).
/// </summary>
public sealed record SignInNonceDto(string Nonce, DateTimeOffset ExpiresAt, string? ClientId);

/// <summary>
/// Signing the phone app in with the system's own Google or Apple sheet (E117): a nonce first,
/// then the <c>id_token</c> grant of <c>/device-tokens</c>, which <see cref="IdTokenValidator"/>
/// checks. Only Google and Apple have such a sheet on a phone; Microsoft goes through the browser.
/// </summary>
internal static class IdTokenSignIn
{
    public static readonly TimeSpan NonceLifetime = TimeSpan.FromMinutes(5);

    /// <summary>The providers a phone can send an ID token for.</summary>
    public static readonly IReadOnlyList<ExternalProvider> Providers = [ExternalProviders.Google, ExternalProviders.Apple];

    public static RouteGroupBuilder MapSignInNonces(this RouteGroupBuilder api)
    {
        // Anonymous with no cookie, like the passkey challenge: the phone asks before it has a session.
        api.MapPost("/sign-in-nonces", IssueAsync).AllowAnonymous().RequireRateLimiting(AuthRateLimits.Policy);
        return api;
    }

    public static ExternalProvider? Find(string? name) =>
        Providers.FirstOrDefault(p => string.Equals(p.Name, name, StringComparison.Ordinal));

    private static async Task<Results<Created<SignInNonceDto>, ValidationProblem, ProblemHttpResult>> IssueAsync(
        SignInNonceRequest request, SignInSettingsStore store, AppDbContext db, TimeProvider time, HttpContext http)
    {
        if (Find(request.Provider) is not { } provider)
        {
            return ApiProblems.Invalid("provider", "provider is google or apple.");
        }

        var settings = await store.GetAsync(http.RequestAborted);
        if (!provider.IsActive(settings))
        {
            return ApiProblems.Of(ProblemTypes.NotFound, "That sign-in provider is not available here.");
        }

        var now = time.GetUtcNow();
        var nonce = Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32));

        // Nonces nobody used are of no use after a while; drop them as new ones are made.
        await db.SignInNonces.Where(n => n.ExpiresAt < now - TimeSpan.FromHours(1)).ExecuteDeleteAsync();
        db.SignInNonces.Add(new SignInNonce { NonceHash = Hash(nonce), Provider = provider.Name, CreatedAt = now, ExpiresAt = now + NonceLifetime });
        await db.SaveChangesAsync();
        http.Response.Headers.CacheControl = Http.HttpCaching.Private;
        var clientId = provider == ExternalProviders.Google ? settings.GoogleClientId : null;
        return TypedResults.Created((string?)null, new SignInNonceDto(nonce, now + NonceLifetime, clientId));
    }

    /// <summary>Uses up a nonce for <paramref name="provider"/>, once, even when two grants race for it.</summary>
    public static async Task<bool> TakeNonceAsync(AppDbContext db, string? nonce, ExternalProvider provider, DateTimeOffset now)
    {
        if (string.IsNullOrEmpty(nonce) || nonce.Length > 64)
        {
            return false;
        }

        var hash = Hash(nonce);
        return await db.SignInNonces
            .Where(n => n.NonceHash == hash && n.Provider == provider.Name && n.UsedAt == null && n.ExpiresAt > now)
            .ExecuteUpdateAsync(n => n.SetProperty(x => x.UsedAt, now)) == 1;
    }

    /// <summary>
    /// The login an ID token proves, as the website's sign-in would make it, or null when the token
    /// is not one this site accepts for <paramref name="provider"/> and <paramref name="nonce"/>.
    /// </summary>
    public static async Task<ExternalLoginInfo?> LoginAsync(
        IdTokenValidator validator, ExternalProvider provider, SignInSnapshot settings, string idToken, string nonce, string? name, CancellationToken cancellationToken)
    {
        var token = await validator.ValidateAsync(provider, settings, idToken, cancellationToken);
        if (token is null || OidcSignIns.Claim(token, "nonce") is not { } claimed
            || !CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(claimed), Encoding.UTF8.GetBytes(nonce)))
        {
            return null;
        }

        // Google sends the name in the token; Apple only to the app, the first time, which sends it here.
        var displayName = provider == ExternalProviders.Google ? OidcSignIns.Claim(token, "name") : name?.Trim() is { Length: > 0 and <= 200 } given ? given : null;
        var principal = OidcSignIns.Principal(
            provider.Scheme, token.Subject, OidcSignIns.Claim(token, "email"), OidcSignIns.IsTrue(OidcSignIns.Claim(token, "email_verified")), displayName);
        return new ExternalLoginInfo(principal, provider.Scheme, token.Subject, provider.Scheme);
    }

    private static byte[] Hash(string nonce) => SHA256.HashData(Encoding.ASCII.GetBytes(nonce));
}

/// <summary>
/// Checks an ID token a phone got from Google or Apple: the signature against the provider's
/// published keys (read from its discovery document and cached), the issuer, the audience (the
/// Google web client id, or the app's bundle id for Apple) and the lifetime.
/// </summary>
internal sealed partial class IdTokenValidator(IHttpClientFactory clients, ILogger<IdTokenValidator> logger)
{
    public const string HttpClientName = "id-tokens";

    private static readonly Dictionary<string, (string Authority, string[] Issuers)> _providers = new(StringComparer.Ordinal)
    {
        ["google"] = ("https://accounts.google.com", ["https://accounts.google.com", "accounts.google.com"]),
        ["apple"] = (OidcSignIns.AppleAuthority, [OidcSignIns.AppleAuthority]),
    };

    private readonly ConcurrentDictionary<string, ConfigurationManager<OpenIdConnectConfiguration>> _configurations = new(StringComparer.Ordinal);

    public async Task<JsonWebToken?> ValidateAsync(ExternalProvider provider, SignInSnapshot settings, string idToken, CancellationToken cancellationToken)
    {
        var audience = provider == ExternalProviders.Google ? settings.GoogleClientId : settings.AppleBundleId;
        if (!_providers.TryGetValue(provider.Name, out var known) || audience is null)
        {
            return null;
        }

        var configurations = _configurations.GetOrAdd(provider.Name, _ => new ConfigurationManager<OpenIdConnectConfiguration>(
            $"{known.Authority}/.well-known/openid-configuration",
            new OpenIdConnectConfigurationRetriever(),
            new HttpDocumentRetriever(clients.CreateClient(HttpClientName))));
        OpenIdConnectConfiguration configuration;
        try
        {
            configuration = await configurations.GetConfigurationAsync(cancellationToken);
        }
        catch (Exception e) when (e is InvalidOperationException or IOException or HttpRequestException)
        {
            LogNoKeys(logger, provider.Name, e);
            return null;
        }

        var result = await new JsonWebTokenHandler { MapInboundClaims = false }.ValidateTokenAsync(idToken, new TokenValidationParameters
        {
            ValidIssuers = known.Issuers,
            ValidAudience = audience,
            IssuerSigningKeys = configuration.SigningKeys,
            ValidateLifetime = true,
            RequireExpirationTime = true,
            RequireSignedTokens = true,
        });
        if (!result.IsValid)
        {
            // A key Google or Apple rolled since the last read: read the keys again for the next try.
            if (result.Exception is SecurityTokenSignatureKeyNotFoundException)
            {
                configurations.RequestRefresh();
            }

            return null;
        }

        return (JsonWebToken)result.SecurityToken;
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Could not read the {Provider} signing keys to check a phone's ID token")]
    private static partial void LogNoKeys(ILogger logger, string provider, Exception exception);
}

/// <summary>Who an <c>id_token</c> grant signs in, or the problem to answer with; neither means a plain refusal.</summary>
internal sealed record IdTokenOutcome(AppUser? User, ProblemHttpResult? Problem);

/// <summary>
/// The <c>id_token</c> grant's checks (E117): the provider on, the nonce used up, the token good,
/// then the same account rules as the website. An account with two-step sign-in finishes in the
/// browser, which asks for the code.
/// </summary>
internal sealed class IdTokenGrant(
    SignInSettingsStore store, AppDbContext db, IdTokenValidator validator, ExternalAccounts accounts, UserManager<AppUser> users, AppleTokens appleTokens)
{
    public async Task<IdTokenOutcome> SignInAsync(ExternalProvider provider, DeviceTokenRequest request, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var settings = await store.GetAsync(cancellationToken);
        if (!provider.IsActive(settings) || !await IdTokenSignIn.TakeNonceAsync(db, request.Nonce, provider, now))
        {
            return new IdTokenOutcome(null, null);
        }

        var info = await IdTokenSignIn.LoginAsync(validator, provider, settings, request.IdToken!, request.Nonce!, request.Name, cancellationToken);
        if (info is null)
        {
            return new IdTokenOutcome(null, null);
        }

        var account = await accounts.ResolveAsync(info, provider);
        switch (account.Error)
        {
            case "link-needed":
                return new IdTokenOutcome(null, ApiProblems.Of(
                    ProblemTypes.Conflict,
                    $"An account with this email already exists. Sign in with its password, then link {provider.Scheme} under Security on the website."));
            case "email-unverified":
                return new IdTokenOutcome(null, ApiProblems.Of(
                    ProblemTypes.EmailUnverified, $"{provider.Scheme} has not confirmed this email address, so Runova can not use it."));
        }

        if (account.Owner is not { } user || user.DisabledAt is not null || await users.IsLockedOutAsync(user))
        {
            return new IdTokenOutcome(null, null);
        }

        if (await users.GetTwoFactorEnabledAsync(user))
        {
            return new IdTokenOutcome(null, ApiProblems.Of(
                ProblemTypes.TwoFactorRequired, "Two-step sign-in is on for this account. Finish signing in in the browser."));
        }

        if (provider == ExternalProviders.Apple
            && request.AuthorizationCode is { Length: > 0 and < 2048 } code
            && await appleTokens.ExchangeAsync(code, settings.AppleBundleId, cancellationToken) is { } refresh)
        {
            await appleTokens.KeepAsync(user, settings.AppleBundleId, refresh);
        }

        return new IdTokenOutcome(user, null);
    }
}
