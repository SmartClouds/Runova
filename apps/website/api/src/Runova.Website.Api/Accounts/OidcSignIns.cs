using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Primitives;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.IdentityModel.Tokens;

namespace Runova.Website.Api.Accounts;

/// <summary>
/// Sign in with Microsoft and Apple (E116), both OpenID Connect, with the keys an Admin saved in
/// the sign-in settings or, without those, <c>Authentication__Microsoft__*</c> and
/// <c>Authentication__Apple__*</c>. Like Google, each handler is always registered, configured
/// again whenever the settings change, and signs in to Identity's external cookie only, as a
/// principal of four plain claims: the subject, the email, the name and whether the email is
/// verified. The endpoints turn that into an account session.
/// </summary>
internal static class OidcSignIns
{
    public const string MicrosoftAuthority = "https://login.microsoftonline.com/common/v2.0";

    /// <summary>The tenant every personal Microsoft account belongs to. Microsoft verifies their addresses.</summary>
    public const string MicrosoftConsumersTenant = "9188040d-6c67-4c5b-b112-36a304b66dad";

    public const string AppleAuthority = "https://appleid.apple.com";

    /// <summary>Where the handler keeps Apple's first-time <c>user</c> field between reading the post and checking the token.</summary>
    private const string AppleUserItem = "runova:apple-user";

    public static IServiceCollection AddOidcSignIns(this IServiceCollection services)
    {
        services.AddAuthentication()
            .AddOpenIdConnect(ExternalProviders.Microsoft.Scheme, "Microsoft", _ => { })
            .AddOpenIdConnect(ExternalProviders.Apple.Scheme, "Apple", _ => { });
        foreach (var provider in new[] { ExternalProviders.Microsoft, ExternalProviders.Apple })
        {
            services.AddSingleton<IOptionsChangeTokenSource<OpenIdConnectOptions>>(sp =>
                new SignInSettingsChangeTokenSource<OpenIdConnectOptions>(provider.Scheme, sp.GetRequiredService<SignInSettingsStore>()));
        }

        services.AddOptions<OpenIdConnectOptions>(ExternalProviders.Microsoft.Scheme)
            .Configure<SignInSettingsStore, IConfiguration>((options, store, configuration) => ConfigureMicrosoft(options, store.Current, configuration));
        services.AddOptions<OpenIdConnectOptions>(ExternalProviders.Apple.Scheme)
            .Configure<SignInSettingsStore, IConfiguration, TimeProvider>((options, store, configuration, time) => ConfigureApple(options, store.Current, configuration, time));
        return services;
    }

    private static void ConfigureMicrosoft(OpenIdConnectOptions options, SignInSnapshot settings, IConfiguration configuration)
    {
        var provider = ExternalProviders.Microsoft;
        var authority = configuration["Authentication:Microsoft:Authority"] ?? MicrosoftAuthority;
        Common(options, provider, authority);
        options.ClientId = settings.MicrosoftClientId ?? "not-configured";
        options.ClientSecret = settings.MicrosoftClientSecret ?? "not-configured";
        options.ResponseMode = OpenIdConnectResponseMode.Query;
        options.Scope.Add("profile");
        options.Scope.Add("email");

        // The common endpoint's issuer names each account's own tenant, so check it against the
        // tenant the token says it is from.
        var instance = new Uri(authority).GetLeftPart(UriPartial.Authority);
        options.TokenValidationParameters.IssuerValidator = (issuer, token, _) => MicrosoftIssuer(instance, issuer, token);
        options.Events.OnTokenValidated = context =>
        {
            var token = context.SecurityToken;
            var email = Claim(token, "email");
            var verified = email is not null && (Claim(token, "tid") == MicrosoftConsumersTenant || IsTrue(Claim(token, "xms_edov")));
            context.Principal = Principal(context.Principal!.Identity!.AuthenticationType, token.Subject, email, verified, Claim(token, "name"));
            return Task.CompletedTask;
        };
    }

    private static void ConfigureApple(OpenIdConnectOptions options, SignInSnapshot settings, IConfiguration configuration, TimeProvider time)
    {
        var provider = ExternalProviders.Apple;
        Common(options, provider, configuration["Authentication:Apple:Authority"] ?? AppleAuthority);
        options.ClientId = settings.AppleServicesId ?? "not-configured";
        options.ClientSecret = "made-for-each-exchange";

        // Apple asks for a form post whenever the name or email is in the scope, and knows no PKCE.
        options.ResponseMode = OpenIdConnectResponseMode.FormPost;
        options.UsePkce = false;
        options.Scope.Add("name");
        options.Scope.Add("email");

        // Kept only so the endpoint can seal Apple's refresh token, to revoke it later.
        options.SaveTokens = true;
        options.Events.OnMessageReceived = context =>
        {
            if (context.ProtocolMessage.GetParameter("user") is { Length: > 0 } user)
            {
                context.HttpContext.Items[AppleUserItem] = user;
            }

            return Task.CompletedTask;
        };
        options.Events.OnAuthorizationCodeReceived = context =>
        {
            context.TokenEndpointRequest!.ClientSecret = AppleClientSecret.Create(
                settings.AppleTeamId ?? "", settings.AppleKeyId ?? "", options.ClientId, settings.ApplePrivateKey ?? "", time.GetUtcNow());
            return Task.CompletedTask;
        };
        options.Events.OnTokenValidated = context =>
        {
            var token = context.SecurityToken;
            var name = AppleName(context.HttpContext.Items[AppleUserItem] as string);
            context.Principal = Principal(context.Principal!.Identity!.AuthenticationType, token.Subject, Claim(token, "email"), IsTrue(Claim(token, "email_verified")), name);
            return Task.CompletedTask;
        };
    }

    private static void Common(OpenIdConnectOptions options, ExternalProvider provider, string authority)
    {
        options.Authority = authority;

        // Only the environment names the authority; the e2e stack points it at a fake on plain HTTP.
        options.RequireHttpsMetadata = authority.StartsWith("https://", StringComparison.Ordinal);
        options.CallbackPath = provider.CallbackPath;

        // Runova never signs anyone out at the provider, so keep the handler's own paths under the callback's.
        options.SignedOutCallbackPath = provider.CallbackPath + "/signed-out";
        options.RemoteSignOutPath = provider.CallbackPath + "/sign-out";
        options.SignInScheme = IdentityConstants.ExternalScheme;
        options.ResponseType = OpenIdConnectResponseType.Code;
        options.Scope.Clear();
        options.Scope.Add("openid");
        options.SaveTokens = false;
        options.GetClaimsFromUserInfoEndpoint = false;
        options.MapInboundClaims = false;
        options.DisableTelemetry = true;
        options.Events.OnRemoteFailure = context => ExternalProviders.OnRemoteFailure(provider, context);
    }

    private static string MicrosoftIssuer(string instance, string issuer, SecurityToken token)
    {
        var tenant = Claim(token, "tid");
        if (Guid.TryParse(tenant, out _) && string.Equals(issuer, $"{instance}/{tenant}/v2.0", StringComparison.Ordinal))
        {
            return issuer;
        }

        throw new SecurityTokenInvalidIssuerException("The issuer does not match the token's tenant.");
    }

    /// <summary>What the endpoints read: the subject as the login's key, the email, its verified flag and a name.</summary>
    internal static ClaimsPrincipal Principal(string? authenticationType, string subject, string? email, bool verified, string? name)
    {
        var identity = new ClaimsIdentity(authenticationType);
        identity.AddClaim(new Claim(ClaimTypes.NameIdentifier, subject));
        if (!string.IsNullOrWhiteSpace(email))
        {
            identity.AddClaim(new Claim(ClaimTypes.Email, email));
        }

        if (verified)
        {
            identity.AddClaim(new Claim(ExternalAccounts.EmailVerifiedClaim, "true"));
        }

        if (!string.IsNullOrWhiteSpace(name))
        {
            identity.AddClaim(new Claim(ClaimTypes.Name, name));
        }

        return new ClaimsPrincipal(identity);
    }

    /// <summary>A claim of the token, whichever of the two token types the handler made, or null when empty.</summary>
    internal static string? Claim(SecurityToken token, string type)
    {
        var claims = token switch
        {
            JsonWebToken json => json.Claims,
            JwtSecurityToken jwt => jwt.Claims,
            _ => [],
        };
        return claims.FirstOrDefault(c => c.Type == type)?.Value is { } value && !string.IsNullOrWhiteSpace(value) ? value : null;
    }

    /// <summary>A flag a provider may send as a JSON bool or as a string.</summary>
    internal static bool IsTrue(string? value) =>
        string.Equals(value, "true", StringComparison.OrdinalIgnoreCase) || value == "1";

    private static readonly string[] _appleNameParts = ["firstName", "lastName"];

    /// <summary>"First Last" from Apple's first-time <c>user</c> field, or null.</summary>
    internal static string? AppleName(string? user)
    {
        if (string.IsNullOrEmpty(user))
        {
            return null;
        }

        try
        {
            using var document = JsonDocument.Parse(user);
            if (!document.RootElement.TryGetProperty("name", out var name) || name.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            var parts = _appleNameParts
                .Select(p => name.TryGetProperty(p, out var part) && part.ValueKind == JsonValueKind.String ? part.GetString()?.Trim() : null)
                .Where(p => !string.IsNullOrEmpty(p));
            var full = string.Join(' ', parts);
            return full.Length > 0 ? full : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}

/// <summary>Tells a provider's handler options to be made again when the sign-in settings change.</summary>
internal sealed class SignInSettingsChangeTokenSource<TOptions>(string name, SignInSettingsStore store) : IOptionsChangeTokenSource<TOptions>
{
    public string Name => name;

    public IChangeToken GetChangeToken() => store.GetChangeToken();
}
