using System.Buffers.Text;
using System.Globalization;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Runova.Website.Api.Email;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Accounts;
using Runova.Website.Core.Email;
using Runova.Website.Core.Problems;
using Runova.Website.Data;
using Runova.Website.Data.Accounts;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Accounts;

public sealed record DeviceAuthorizationRequest(
    string? ClientId,
    string? RedirectUri,
    string? CodeChallenge,
    string? CodeChallengeMethod,
    string? State,
    string? DeviceName,
    string? Platform,
    string? AppVersion,
    Guid? DeviceId);

public sealed record DeviceAuthorizationDto(string RedirectUrl, DateTimeOffset ExpiresAt);

public sealed record DeviceTokenRequest(string? GrantType, string? Code, string? CodeVerifier, string? RedirectUri, string? RefreshToken);

public sealed record DeviceTokenDto(string AccessToken, string RefreshToken, int ExpiresIn, long SessionId, AccountDto Account);

/// <summary>
/// Signing the desktop app in (E48.5), in the spirit of OAuth's authorization code flow with PKCE
/// for a native app (RFC 8252): the signed-in browser approves the computer and is sent back to
/// the app's loopback listener with a one-time code; the app trades code and verifier for a
/// 15-minute access token and a refresh token. Refresh tokens rotate on every use, and one used
/// twice (after a short grace for a lost answer) ends its session.
/// </summary>
internal static partial class DeviceTokenEndpoints
{
    public const string ClientId = "runova-desktop";
    public const string PhoneClientId = "runova-mobile";

    /// <summary>The phone app's private-use redirect (RFC 8252 section 7.1); PKCE protects the code.</summary>
    public const string PhoneRedirect = "com.runovahq.app:/auth/callback";

    /// <summary>A phone's name in the session list, and the only one the website shows for it.</summary>
    public const string PhoneDeviceName = "Runova app";
    public static readonly TimeSpan CodeLifetime = TimeSpan.FromMinutes(2);
    public static readonly TimeSpan RefreshLifetime = TimeSpan.FromDays(60);

    /// <summary>A retry with the old refresh token this soon after a rotation is a lost answer, not a theft.</summary>
    public static readonly TimeSpan ReuseGrace = TimeSpan.FromSeconds(30);

    private static readonly Dictionary<string, string> _platforms = new(StringComparer.Ordinal)
    {
        ["windows"] = "Windows",
        ["macos"] = "macOS",
        ["linux"] = "Linux",
    };

    private static readonly Dictionary<string, string> _phonePlatforms = new(StringComparer.Ordinal)
    {
        ["android"] = "Phone",
        ["ios"] = "Phone",
    };

    public static RouteGroupBuilder MapDeviceTokens(this RouteGroupBuilder api)
    {
        api.MapPost("/device-authorizations", ApproveAsync).RequireAuthorization(Policies.Account);
        api.MapPost("/device-tokens", TokensAsync).AllowAnonymous().RequireRateLimiting(AuthRateLimits.Policy);
        return api;
    }

    [GeneratedRegex(@"^http://(127\.0\.0\.1|\[::1\]):(\d{1,5})/callback$", RegexOptions.CultureInvariant)]
    private static partial Regex LoopbackRedirect();

    private static bool IsLoopbackRedirect(string? redirectUri) =>
        redirectUri is not null
        && LoopbackRedirect().Match(redirectUri) is { Success: true } loopback
        && int.TryParse(loopback.Groups[2].Value, CultureInfo.InvariantCulture, out var port)
        && port is >= 1024 and <= 65535;

    [GeneratedRegex("^[A-Za-z0-9_-]{43,128}$", RegexOptions.CultureInvariant)]
    private static partial Regex Base64UrlToken();

    [GeneratedRegex("^[A-Za-z0-9_-]{8,200}$", RegexOptions.CultureInvariant)]
    private static partial Regex StateValue();

    private static async Task<Results<Created<DeviceAuthorizationDto>, ValidationProblem, UnauthorizedHttpResult>> ApproveAsync(
        DeviceAuthorizationRequest request, HttpContext http, UserManager<AppUser> users, AppDbContext db, TimeProvider time)
    {
        if (await users.GetUserAsync(http.User) is not { } user)
        {
            return TypedResults.Unauthorized();
        }

        var errors = new Dictionary<string, string[]>();
        var isPhone = request.ClientId == PhoneClientId;
        if (!isPhone && request.ClientId != ClientId)
        {
            errors["clientId"] = ["Only the Runova apps can be signed in here."];
        }

        if (isPhone ? request.RedirectUri != PhoneRedirect : !IsLoopbackRedirect(request.RedirectUri))
        {
            errors["redirectUri"] = [isPhone ? $"The app listens on {PhoneRedirect}." : "The app listens on http://127.0.0.1:<port>/callback."];
        }

        if (request.CodeChallengeMethod != "S256" || request.CodeChallenge is null || !Base64UrlToken().IsMatch(request.CodeChallenge))
        {
            errors["codeChallenge"] = ["Send a PKCE S256 challenge."];
        }

        if (request.State is null || !StateValue().IsMatch(request.State))
        {
            errors["state"] = ["Send the state the app made, 8 to 200 URL-safe characters."];
        }

        var deviceName = request.DeviceName?.Trim() ?? "";
        if (deviceName.Length is 0 or > 100)
        {
            errors["deviceName"] = ["Name the computer, up to 100 characters."];
        }

        var platforms = isPhone ? _phonePlatforms : _platforms;
        if (request.Platform is null || !platforms.ContainsKey(request.Platform))
        {
            errors["platform"] = [isPhone ? "platform is android or ios." : "platform is windows, macos or linux."];
        }

        if (request.AppVersion is { Length: > 32 })
        {
            errors["appVersion"] = ["appVersion is up to 32 characters."];
        }

        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        var code = Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32));
        var now = time.GetUtcNow();
        var approval = new DeviceAuthorization
        {
            UserId = user.Id,
            CodeHash = Hash(code),
            CodeChallenge = request.CodeChallenge!,
            RedirectUri = request.RedirectUri!,
            DeviceName = isPhone ? PhoneDeviceName : deviceName,
            Platform = platforms[request.Platform!],
            AppVersion = request.AppVersion,
            DeviceId = request.DeviceId,
            CreatedAt = now,
            ExpiresAt = now + CodeLifetime,
        };
        db.DeviceAuthorizations.Add(approval);
        await db.DeviceAuthorizations.Where(a => a.ExpiresAt < now).ExecuteDeleteAsync();
        await db.SaveChangesAsync();

        var redirect = $"{request.RedirectUri}?code={UrlEncoder.Default.Encode(code)}&state={UrlEncoder.Default.Encode(request.State!)}";
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Created((string?)null, new DeviceAuthorizationDto(redirect, approval.ExpiresAt));
    }

    private static async Task<Results<Ok<DeviceTokenDto>, ValidationProblem, ProblemHttpResult>> TokensAsync(
        DeviceTokenRequest request,
        HttpContext http,
        UserManager<AppUser> users,
        AppDbContext db,
        DeviceTokens tokens,
        AccountSessions sessions,
        ActivityLog activity,
        EmailOutbox outbox,
        IConfiguration configuration,
        TimeProvider time)
    {
        http.Response.Headers.CacheControl = HttpCaching.Private;
        var now = time.GetUtcNow();
        switch (request.GrantType)
        {
            case "authorization_code":
                {
                    if (string.IsNullOrEmpty(request.Code) || string.IsNullOrEmpty(request.CodeVerifier) || string.IsNullOrEmpty(request.RedirectUri))
                    {
                        return ApiProblems.Invalid("code", "Send the code, the verifier and the redirect URI.");
                    }

                    var hash = Hash(request.Code);
                    var approval = await db.DeviceAuthorizations.SingleOrDefaultAsync(a => a.CodeHash == hash);
                    if (approval is null || approval.UsedAt is not null || approval.ExpiresAt <= now
                        || approval.RedirectUri != request.RedirectUri
                        || !CryptographicOperations.FixedTimeEquals(
                            Encoding.ASCII.GetBytes(Challenge(request.CodeVerifier)), Encoding.ASCII.GetBytes(approval.CodeChallenge)))
                    {
                        return Refused();
                    }

                    // One use, even when two requests race for it.
                    if (await db.DeviceAuthorizations.Where(a => a.Id == approval.Id && a.UsedAt == null)
                            .ExecuteUpdateAsync(a => a.SetProperty(x => x.UsedAt, now)) != 1)
                    {
                        return Refused();
                    }

                    var user = await users.FindByIdAsync(approval.UserId.ToString(CultureInfo.InvariantCulture));
                    if (user is null || user.DisabledAt is not null)
                    {
                        return Refused();
                    }

                    if (approval.DeviceId is { } deviceId)
                    {
                        var previous = await db.AccountSessions
                            .Where(s => s.UserId == user.Id && s.DeviceId == deviceId && s.RevokedAt == null)
                            .Select(s => s.Id)
                            .ToListAsync();
                        foreach (var id in previous)
                        {
                            await sessions.RevokeAsync(user.Id, id);
                        }
                    }

                    var refresh = DeviceTokens.NewRefreshToken();
                    var kind = approval.RedirectUri == PhoneRedirect ? AccountSessionKinds.Mobile : AccountSessionKinds.Desktop;
                    var anyBefore = await db.AccountSessions.AnyAsync(s => s.UserId == user.Id && s.Kind == kind);
                    var ip = http.Connection.RemoteIpAddress?.ToString();
                    var session = new AccountSession
                    {
                        UserId = user.Id,
                        Kind = kind,
                        DeviceName = approval.DeviceName,
                        Platform = approval.Platform,
                        AppVersion = approval.AppVersion,
                        DeviceId = approval.DeviceId,
                        UserAgent = AccountSessions.Truncate(http.Request.Headers.UserAgent.ToString(), 300),
                        CreatedIp = ip,
                        LastIp = ip,
                        CreatedAt = now,
                        LastSeenAt = now,
                        RefreshTokenHash = Hash(refresh),
                        RefreshExpiresAt = now + RefreshLifetime,
                    };
                    db.AccountSessions.Add(session);
                    await db.SaveChangesAsync();

                    http.Items[ActivityLog.DeviceItem] = approval.DeviceName;
                    http.User = DeviceTokens.Principal(user.Id, session.Id);
                    activity.Add(user.Id, ActivityActions.DeviceSignIn, new { device = approval.DeviceName, platform = approval.Platform, reused = anyBefore });
                    if (user.Email is { } email)
                    {
                        outbox.Add(email, EmailTemplates.NewSignIn(user.DisplayName, $"{approval.DeviceName} ({approval.Platform})", ip ?? "an unknown address", $"{SiteUrl.From(configuration)}/account/sessions"));
                    }

                    await db.SaveChangesAsync();
                    outbox.SendSoon();
                    return TypedResults.Ok(new DeviceTokenDto(tokens.AccessToken(user.Id, session.Id), refresh, (int)DeviceTokens.AccessLifetime.TotalSeconds, session.Id, await users.ToAccountDtoAsync(user)));
                }

            case "refresh_token":
                {
                    if (string.IsNullOrEmpty(request.RefreshToken))
                    {
                        return ApiProblems.Invalid("refreshToken", "Send the refresh token.");
                    }

                    var hash = Hash(request.RefreshToken);
                    var session = await db.AccountSessions.SingleOrDefaultAsync(s => s.RefreshTokenHash == hash);
                    if (session is null)
                    {
                        var replaced = await db.AccountSessions.SingleOrDefaultAsync(s => s.PreviousRefreshTokenHash == hash);
                        if (replaced is { RevokedAt: null } && now - replaced.RefreshRotatedAt > ReuseGrace)
                        {
                            await sessions.RevokeAsync(replaced.UserId, replaced.Id);
                            http.Items[ActivityLog.DeviceItem] = replaced.DeviceName;
                            activity.Add(replaced.UserId, ActivityActions.RefreshTokenReused, new { sessionId = replaced.Id, device = replaced.DeviceName });
                            await db.SaveChangesAsync();
                        }

                        return Refused();
                    }

                    if (session.RevokedAt is not null || session.RefreshExpiresAt <= now)
                    {
                        return Refused();
                    }

                    var user = await users.FindByIdAsync(session.UserId.ToString(CultureInfo.InvariantCulture));
                    if (user is null || user.DisabledAt is not null)
                    {
                        return Refused();
                    }

                    var refresh = DeviceTokens.NewRefreshToken();
                    var ip = http.Connection.RemoteIpAddress?.ToString();
                    var rotated = await db.AccountSessions
                        .Where(s => s.Id == session.Id && s.RefreshTokenHash == hash && s.RevokedAt == null)
                        .ExecuteUpdateAsync(s => s
                            .SetProperty(x => x.PreviousRefreshTokenHash, hash)
                            .SetProperty(x => x.RefreshTokenHash, Hash(refresh))
                            .SetProperty(x => x.RefreshRotatedAt, now)
                            .SetProperty(x => x.RefreshExpiresAt, now + RefreshLifetime)
                            .SetProperty(x => x.LastSeenAt, now)
                            .SetProperty(x => x.LastIp, ip));
                    if (rotated != 1)
                    {
                        return Refused();
                    }

                    return TypedResults.Ok(new DeviceTokenDto(tokens.AccessToken(user.Id, session.Id), refresh, (int)DeviceTokens.AccessLifetime.TotalSeconds, session.Id, await users.ToAccountDtoAsync(user)));
                }

            default:
                return ApiProblems.Invalid("grantType", "grantType is authorization_code or refresh_token.");
        }
    }

    private static ProblemHttpResult Refused() =>
        ApiProblems.Of(ProblemTypes.Unauthorized, "This sign-in is no longer valid. Sign in to Runova again.");

    internal static byte[] Hash(string token) => SHA256.HashData(Encoding.ASCII.GetBytes(token));

    private static string Challenge(string verifier) => Base64Url.EncodeToString(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
}

/// <summary>
/// The desktop's access tokens: the user and session, sealed with Data Protection for 15 minutes
/// (no JWT, as the server core does), and refresh tokens of 32 random bytes.
/// </summary>
internal sealed class DeviceTokens(IDataProtectionProvider protection)
{
    public const string Prefix = "rd1.";
    public static readonly TimeSpan AccessLifetime = TimeSpan.FromMinutes(15);
    private readonly ITimeLimitedDataProtector _protector = protection.CreateProtector("Runova.DeviceAccess.v1").ToTimeLimitedDataProtector();

    public static string NewRefreshToken() => "rr1." + Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32));

    public string AccessToken(long userId, long sessionId) =>
        Prefix + _protector.Protect(string.Create(CultureInfo.InvariantCulture, $"{userId}|{sessionId}"), AccessLifetime);

    /// <summary>The user and session a token names, or null when it is not one of ours or has expired.</summary>
    public (long UserId, long SessionId)? Read(string token)
    {
        if (!token.StartsWith(Prefix, StringComparison.Ordinal))
        {
            return null;
        }

        try
        {
            var parts = _protector.Unprotect(token[Prefix.Length..]).Split('|');
            return parts.Length == 2
                && long.TryParse(parts[0], CultureInfo.InvariantCulture, out var userId)
                && long.TryParse(parts[1], CultureInfo.InvariantCulture, out var sessionId)
                    ? (userId, sessionId)
                    : null;
        }
        catch (CryptographicException)
        {
            return null;
        }
    }

    public static ClaimsPrincipal Principal(long userId, long sessionId) =>
        new(new ClaimsIdentity(
            [
                new Claim(ClaimTypes.NameIdentifier, userId.ToString(CultureInfo.InvariantCulture)),
                new Claim(AccountSessions.SessionClaim, sessionId.ToString(CultureInfo.InvariantCulture)),
            ],
            DeviceTokenAuthenticationHandler.SchemeName));
}

/// <summary>
/// <c>Authorization: Bearer rd1...</c> from the desktop app. The token must open, and its session
/// must still be live. The principal carries no role, so a device token reaches account routes only,
/// even for staff. A bearer request carries no cookie, so it needs no antiforgery token.
/// </summary>
internal sealed class DeviceTokenAuthenticationHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder,
    DeviceTokens tokens,
    AccountSessions sessions)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string SchemeName = "RunovaDevice";

    public static bool HasToken(HttpContext http) =>
        http.Request.Headers.Authorization.ToString().StartsWith("Bearer " + DeviceTokens.Prefix, StringComparison.Ordinal);

    public static bool IsDevice(ClaimsPrincipal? user) => user?.Identity?.AuthenticationType == SchemeName;

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var header = Request.Headers.Authorization.ToString();
        if (!header.StartsWith("Bearer ", StringComparison.Ordinal))
        {
            return AuthenticateResult.NoResult();
        }

        if (tokens.Read(header["Bearer ".Length..].Trim()) is not { } read
            || await sessions.FindLiveAsync(read.SessionId, read.UserId) is not { } session)
        {
            return AuthenticateResult.Fail("The token is not valid.");
        }

        Context.Items[ActivityLog.DeviceItem] = session.DeviceName;
        return AuthenticateResult.Success(new AuthenticationTicket(DeviceTokens.Principal(read.UserId, read.SessionId), SchemeName));
    }
}
