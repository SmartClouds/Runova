using System.Buffers.Text;
using System.Globalization;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Runova.Website.Api.Dependencies;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Problems;
using Runova.Website.Data;
using Runova.Website.Data.Remote;

namespace Runova.Website.Api.Remote;

/// <summary>Turns the background agent on for a computer, with its own public key.</summary>
public sealed record EnableAgentRequest(string IdentityKey);

/// <summary>The agent's secret, shown this once for the app to hand to the agent it installs.</summary>
public sealed record AgentEnabledDto(string IdentityKey, string AgentSecret);

public sealed record AgentTokenRequest(string RemoteId, string Secret);

public sealed record AgentTokenDto(string AccessToken, int ExpiresIn);

/// <summary>
/// The background agent's credentials (E64). Its owner turns it on from the signed-in app, which
/// gets a secret of 256 random bits once and hands it to the agent; the server keeps only its
/// SHA-256. The agent trades the secret for an access token that lasts an hour and reaches the
/// remote hub only, where it can host its own computer and nothing else. Turning the agent off, or
/// on again with a new key, makes every token it holds stop working.
/// </summary>
internal sealed class RemoteAgentTokens(IDataProtectionProvider protection)
{
    public const string Prefix = "ra1.";
    public const string SecretPrefix = "ras1.";
    public const string DeviceClaim = "runova:remote-agent";
    public static readonly TimeSpan Lifetime = TimeSpan.FromHours(1);

    private readonly ITimeLimitedDataProtector _protector = protection.CreateProtector("Runova.RemoteAgent.v1").ToTimeLimitedDataProtector();

    public static string NewSecret() => SecretPrefix + Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32));

    public static byte[] Hash(string secret) => SHA256.HashData(Encoding.UTF8.GetBytes(secret));

    /// <summary>A token bound to the secret it was bought with, so a new secret retires it.</summary>
    public string Issue(long userId, long deviceId, byte[] secretHash) =>
        Prefix + _protector.Protect(string.Create(CultureInfo.InvariantCulture, $"{userId}|{deviceId}|{Convert.ToHexString(secretHash, 0, 8)}"), Lifetime);

    public (long UserId, long DeviceId, string Stamp)? Read(string token)
    {
        if (!token.StartsWith(Prefix, StringComparison.Ordinal))
        {
            return null;
        }

        try
        {
            var parts = _protector.Unprotect(token[Prefix.Length..]).Split('|');
            return parts.Length == 3
                && long.TryParse(parts[0], CultureInfo.InvariantCulture, out var userId)
                && long.TryParse(parts[1], CultureInfo.InvariantCulture, out var deviceId)
                    ? (userId, deviceId, parts[2])
                    : null;
        }
        catch (CryptographicException)
        {
            return null;
        }
    }

    public static long? AgentDevice(ClaimsPrincipal? user) =>
        long.TryParse(user?.FindFirstValue(DeviceClaim), CultureInfo.InvariantCulture, out var id) ? id : null;
}

/// <summary>
/// <c>Authorization: Bearer ra1...</c> from a background agent, on the remote hub only. Anywhere
/// else it fails, so an agent token never reaches an account route.
/// </summary>
internal sealed class RemoteAgentAuthenticationHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder,
    RemoteAgentTokens tokens,
    AppDbContext db)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string SchemeName = "RunovaRemoteAgent";

    public static bool HasToken(HttpContext http) =>
        http.Request.Headers.Authorization.ToString().StartsWith("Bearer " + RemoteAgentTokens.Prefix, StringComparison.Ordinal);

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        if (!Request.Path.StartsWithSegments(RemoteHub.Path, StringComparison.Ordinal))
        {
            return AuthenticateResult.Fail("An agent token reaches the remote hub only.");
        }

        var header = Request.Headers.Authorization.ToString();
        if (tokens.Read(header["Bearer ".Length..].Trim()) is not { } read)
        {
            return AuthenticateResult.Fail("The token is not valid.");
        }

        var hash = await db.RemoteDevices.AsNoTracking()
            .Where(d => d.Id == read.DeviceId && d.UserId == read.UserId && d.RevokedAt == null)
            .Select(d => d.AgentSecretHash)
            .SingleOrDefaultAsync();
        if (hash is null || Convert.ToHexString(hash, 0, 8) != read.Stamp)
        {
            return AuthenticateResult.Fail("The agent was turned off.");
        }

        var principal = new ClaimsPrincipal(new ClaimsIdentity(
            [
                new Claim(ClaimTypes.NameIdentifier, read.UserId.ToString(CultureInfo.InvariantCulture)),
                new Claim(RemoteAgentTokens.DeviceClaim, read.DeviceId.ToString(CultureInfo.InvariantCulture)),
            ],
            SchemeName));
        return AuthenticateResult.Success(new AuthenticationTicket(principal, SchemeName));
    }
}

/// <summary>The routes the app and the agent use to set the agent up (E64).</summary>
internal static class RemoteAgentEndpoints
{
    public static RouteGroupBuilder MapRemoteAgents(this RouteGroupBuilder api)
    {
        api.MapPost("/remote-devices/{id:long}/agents", EnableAsync).RequireAuthorization(Policies.Account);
        api.MapDelete("/remote-devices/{id:long}/agents", DisableAsync).RequireAuthorization(Policies.Account);
        api.MapPost("/remote-agent-tokens", TokenAsync).AllowAnonymous().RequireRateLimiting(AuthRateLimits.Policy);
        return api;
    }

    private static async Task<Results<Created<AgentEnabledDto>, ValidationProblem, ProblemHttpResult>> EnableAsync(
        long id, [FromBody] EnableAgentRequest request, HttpContext http, AppDbContext db, RemotePresence presence, TimeProvider time)
    {
        if (!RemoteEndpoints.IsIdentityKey(request.IdentityKey))
        {
            return ApiProblems.Invalid("identityKey", "identityKey is an Ed25519 public key: 32 bytes in base64url.");
        }

        var me = CurrentAccount.Id(http);
        if (await db.RemoteDevices.SingleOrDefaultAsync(d => d.Id == id && d.UserId == me && d.RevokedAt == null) is not { } device)
        {
            return ApiProblems.Of(ProblemTypes.NotFound, "There is no such computer on this account.");
        }

        var secret = RemoteAgentTokens.NewSecret();
        device.AgentIdentityKey = request.IdentityKey;
        device.AgentSecretHash = RemoteAgentTokens.Hash(secret);
        device.AgentEnabledAt = time.GetUtcNow();
        await db.SaveChangesAsync();
        // An agent still online with the old secret is no longer this computer's agent.
        presence.RemoveAgent(id);
        return TypedResults.Created($"{ApiV1.Prefix}/remote-devices/{id}/agents", new AgentEnabledDto(request.IdentityKey, secret));
    }

    private static async Task<Results<NoContent, ProblemHttpResult>> DisableAsync(
        long id, HttpContext http, AppDbContext db, RemotePresence presence, RemoteAudience audience)
    {
        var me = CurrentAccount.Id(http);
        if (await db.RemoteDevices.SingleOrDefaultAsync(d => d.Id == id && d.UserId == me && d.RevokedAt == null && d.AgentSecretHash != null) is not { } device)
        {
            return ApiProblems.Of(ProblemTypes.NotFound, "This computer has no background agent turned on.");
        }

        device.AgentIdentityKey = null;
        device.AgentSecretHash = null;
        device.AgentEnabledAt = null;
        await db.SaveChangesAsync();
        if (presence.RemoveAgent(id) is not null && !presence.IsOnline(id))
        {
            await audience.PresenceAsync(device, online: false);
        }

        return TypedResults.NoContent();
    }

    private static async Task<Results<Ok<AgentTokenDto>, ProblemHttpResult>> TokenAsync(
        [FromBody] AgentTokenRequest request, AppDbContext db, RemoteAgentTokens tokens)
    {
        var refused = ApiProblems.Of(ProblemTypes.Unauthorized, "That agent secret does not open this computer.");
        if (RemoteIds.Parse(request.RemoteId) is not { } remoteId || string.IsNullOrEmpty(request.Secret))
        {
            return refused;
        }

        var device = await db.RemoteDevices.AsNoTracking()
            .Where(d => d.RemoteId == remoteId && d.RevokedAt == null && d.AgentSecretHash != null)
            .Select(d => new { d.Id, d.UserId, d.AgentSecretHash })
            .SingleOrDefaultAsync();
        var hash = RemoteAgentTokens.Hash(request.Secret);
        if (device?.AgentSecretHash is null || !CryptographicOperations.FixedTimeEquals(device.AgentSecretHash, hash))
        {
            return refused;
        }

        return TypedResults.Ok(new AgentTokenDto(tokens.Issue(device.UserId, device.Id, hash), (int)RemoteAgentTokens.Lifetime.TotalSeconds));
    }
}
