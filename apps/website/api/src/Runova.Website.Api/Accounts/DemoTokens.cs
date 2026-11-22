using System.Globalization;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Options;

namespace Runova.Website.Api.Accounts;

/// <summary>The <c>Demo</c> settings: whether the phone app may sign in to the demo account.</summary>
internal sealed class DemoOptions
{
    public const string Section = "Demo";

    public bool Enabled { get; set; } = true;
}

/// <summary>
/// The demo account the phone app signs in to for app store reviewers and the curious. It is not
/// in the database: its principal carries a claim of its own, and <see cref="DemoAnswers"/> answers
/// every request it makes before any endpoint runs.
/// </summary>
internal static class DemoAccount
{
    public const long UserId = -1;
    public const long SessionId = -1;
    public const string DisplayName = "Demo";
    public const string Email = "demo@runovahq.com";
    public const string Claim = "runova:demo";

    public static ClaimsPrincipal Principal() =>
        new(new ClaimsIdentity(
            [
                new Claim(ClaimTypes.NameIdentifier, UserId.ToString(CultureInfo.InvariantCulture)),
                new Claim(Claim, "1"),
            ],
            DemoTokenAuthenticationHandler.SchemeName));

    public static bool IsDemo(ClaimsPrincipal? user) =>
        user?.Identity is { IsAuthenticated: true, AuthenticationType: DemoTokenAuthenticationHandler.SchemeName }
        && user.HasClaim(Claim, "1");
}

/// <summary>
/// The demo account's tokens: a 15-minute access token and a 30-day refresh token, each only a
/// Data Protection seal of its expiry under a purpose of its own. Nothing is stored, so a refresh
/// token can be used again until it expires, and the demo only ever shows mock data.
/// </summary>
internal sealed class DemoTokens(IDataProtectionProvider protection, TimeProvider time)
{
    public const string AccessPrefix = "rdm1.";
    public const string RefreshPrefix = "rrm1.";
    public static readonly TimeSpan AccessLifetime = TimeSpan.FromMinutes(15);
    public static readonly TimeSpan RefreshLifetime = TimeSpan.FromDays(30);

    private const string Payload = "demo";

    private readonly IDataProtector _access = protection.CreateProtector("Runova.DemoAccess.v1");
    private readonly IDataProtector _refresh = protection.CreateProtector("Runova.DemoRefresh.v1");

    public string AccessToken() => AccessPrefix + Seal(_access, AccessLifetime);

    public string RefreshToken() => RefreshPrefix + Seal(_refresh, RefreshLifetime);

    public bool IsAccessToken(string token) => Opens(token, AccessPrefix, _access);

    public bool IsRefreshToken(string token) => Opens(token, RefreshPrefix, _refresh);

    /// <summary>A fresh pair for the demo account, shaped as any other sign-in's.</summary>
    public DeviceTokenDto Issue() =>
        new(AccessToken(), RefreshToken(), (int)AccessLifetime.TotalSeconds, DemoAccount.SessionId, DemoData.Account(time.GetUtcNow()));

    // The expiry goes inside the seal and is checked against the injected clock, so it moves with it.
    private string Seal(IDataProtector protector, TimeSpan lifetime) =>
        protector.Protect(string.Create(CultureInfo.InvariantCulture, $"{Payload}|{(time.GetUtcNow() + lifetime).ToUnixTimeMilliseconds()}"));

    private bool Opens(string token, string prefix, IDataProtector protector)
    {
        if (!token.StartsWith(prefix, StringComparison.Ordinal) || token.Length == prefix.Length)
        {
            return false;
        }

        try
        {
            var parts = protector.Unprotect(token[prefix.Length..]).Split('|');
            return parts is [Payload, var expires]
                && long.TryParse(expires, NumberStyles.None, CultureInfo.InvariantCulture, out var ms)
                && DateTimeOffset.FromUnixTimeMilliseconds(ms) > time.GetUtcNow();
        }
        catch (CryptographicException)
        {
            return false;
        }
        catch (FormatException)
        {
            return false;
        }
    }
}

/// <summary>
/// <c>Authorization: Bearer rdm1...</c> from the phone's demo account. It opens only on the
/// <c>/api/v1</c> routes, never on the hubs or the relay, and touches no database: the principal
/// is the demo account, with no role, so it passes the Account policy and nothing above it.
/// </summary>
internal sealed class DemoTokenAuthenticationHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder,
    DemoTokens tokens,
    IOptionsMonitor<DemoOptions> demo)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string SchemeName = "RunovaDemo";

    public static bool HasToken(HttpContext http) =>
        http.Request.Headers.Authorization.ToString().StartsWith("Bearer " + DemoTokens.AccessPrefix, StringComparison.Ordinal);

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var header = Request.Headers.Authorization.ToString();
        if (!header.StartsWith("Bearer ", StringComparison.Ordinal))
        {
            return Task.FromResult(AuthenticateResult.NoResult());
        }

        if (!demo.CurrentValue.Enabled
            || !Request.Path.StartsWithSegments(ApiV1.Prefix, StringComparison.Ordinal)
            || !tokens.IsAccessToken(header["Bearer ".Length..].Trim()))
        {
            return Task.FromResult(AuthenticateResult.Fail("The token is not valid here."));
        }

        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(DemoAccount.Principal(), SchemeName)));
    }
}
