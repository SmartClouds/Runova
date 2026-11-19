using Microsoft.AspNetCore.Identity;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Accounts;

/// <summary>
/// Apple's refresh token for an account, sealed in Identity's user tokens, and revoking it. Apple
/// asks apps that offer Sign in with Apple to revoke the person's token when they delete their
/// account, and the website does the same when Apple is unlinked. The token never leaves the API.
/// </summary>
internal sealed partial class AppleTokens(
    UserManager<AppUser> users,
    SignInSecrets secrets,
    SignInSettingsStore store,
    IHttpClientFactory clients,
    IConfiguration configuration,
    TimeProvider time,
    ILogger<AppleTokens> logger)
{
    public const string HttpClientName = "apple-id";
    public const string TokenName = "refresh_token";

    /// <summary>Keeps <paramref name="refreshToken"/>, with the client it was given to (the Services ID or the app).</summary>
    public async Task KeepAsync(AppUser user, string clientId, string refreshToken) =>
        ExternalAccounts.Succeeded(await users.SetAuthenticationTokenAsync(
            user, ExternalProviders.Apple.Scheme, TokenName, secrets.Seal($"{clientId}\n{refreshToken}")));

    /// <summary>
    /// Trades the authorization code Sign in with Apple gave the phone app for Apple's refresh
    /// token (E117), to revoke later. Null when Apple has no keys here or says no; the sign-in
    /// goes on either way.
    /// </summary>
    public async Task<string?> ExchangeAsync(string code, string clientId, CancellationToken cancellationToken = default)
    {
        var settings = await store.GetAsync(cancellationToken);
        if (settings is not { AppleTeamId: { } teamId, AppleKeyId: { } keyId, ApplePrivateKey: { } key })
        {
            LogNoKeys(logger);
            return null;
        }

        var authority = (configuration["Authentication:Apple:Authority"] ?? OidcSignIns.AppleAuthority).TrimEnd('/');
        try
        {
            using var response = await clients.CreateClient(HttpClientName).PostAsync(
                $"{authority}/auth/token",
                new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["client_id"] = clientId,
                    ["client_secret"] = AppleClientSecret.Create(teamId, keyId, clientId, key, time.GetUtcNow()),
                    ["code"] = code,
                    ["grant_type"] = "authorization_code",
                }),
                cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                LogRefused(logger, (int)response.StatusCode);
                return null;
            }

            var body = await response.Content.ReadFromJsonAsync<System.Text.Json.JsonElement>(cancellationToken);
            return body.TryGetProperty(TokenName, out var refresh) && refresh.ValueKind == System.Text.Json.JsonValueKind.String ? refresh.GetString() : null;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or System.Text.Json.JsonException)
        {
            LogFailed(logger, e);
            return null;
        }
    }

    /// <summary>
    /// Asks Apple to revoke the account's token, if it has one. A failure is logged, never thrown:
    /// Apple being down must not stop anyone deleting their account. <paramref name="forget"/>
    /// removes the saved token too, which deleting the account does by itself.
    /// </summary>
    public async Task RevokeAsync(AppUser user, bool forget, CancellationToken cancellationToken = default)
    {
        var saved = secrets.Unseal(await users.GetAuthenticationTokenAsync(user, ExternalProviders.Apple.Scheme, TokenName));
        if (saved?.Split('\n', 2) is [var clientId, var token])
        {
            await SendRevokeAsync(clientId, token, cancellationToken);
        }

        if (forget)
        {
            ExternalAccounts.Succeeded(await users.RemoveAuthenticationTokenAsync(user, ExternalProviders.Apple.Scheme, TokenName));
        }
    }

    private async Task SendRevokeAsync(string clientId, string token, CancellationToken cancellationToken)
    {
        var settings = await store.GetAsync(cancellationToken);
        if (settings is not { AppleTeamId: { } teamId, AppleKeyId: { } keyId, ApplePrivateKey: { } key })
        {
            LogNoKeys(logger);
            return;
        }

        var authority = (configuration["Authentication:Apple:Authority"] ?? OidcSignIns.AppleAuthority).TrimEnd('/');
        try
        {
            using var response = await clients.CreateClient(HttpClientName).PostAsync(
                $"{authority}/auth/revoke",
                new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["client_id"] = clientId,
                    ["client_secret"] = AppleClientSecret.Create(teamId, keyId, clientId, key, time.GetUtcNow()),
                    ["token"] = token,
                    ["token_type_hint"] = TokenName,
                }),
                cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                LogRefused(logger, (int)response.StatusCode);
            }
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            LogFailed(logger, e);
        }
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Could not reach Apple's token endpoint: Sign in with Apple has no keys now")]
    private static partial void LogNoKeys(ILogger logger);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Apple refused a token request ({Status})")]
    private static partial void LogRefused(ILogger logger, int status);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Could not reach Apple's token endpoint")]
    private static partial void LogFailed(ILogger logger, Exception exception);
}
