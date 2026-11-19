using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Protocols;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.IdentityModel.Tokens;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>
/// An OpenID Connect provider for the API's Apple and Microsoft handlers: the discovery document,
/// the signing keys, and a token endpoint that hands back an ID token signed with a key made for
/// the test, carrying the claims the test set and the nonce the handler asked for. It also plays
/// the browser: start, follow the redirect to the provider, come back to the callback, and finish.
/// </summary>
internal abstract class FakeOidcProvider : HttpMessageHandler
{
    private readonly RsaSecurityKey _key = new(RSA.Create(2048)) { KeyId = "fake-key-1" };
    private string? _nonce;

    /// <summary>The provider's address, as the handler's Authority.</summary>
    public abstract string Authority { get; }

    /// <summary>The scheme the API registers the handler under.</summary>
    protected abstract string Scheme { get; }

    /// <summary>The provider's name in the API's start path.</summary>
    public abstract string Provider { get; }

    /// <summary>The host the browser is sent to.</summary>
    public string AuthorizeHost => new Uri(Authority).Host;

    /// <summary>The issuer in the discovery document, which may be a template, as Microsoft's is.</summary>
    protected virtual string DocumentIssuer => Authority;

    public string Subject { get; set; } = Guid.NewGuid().ToString("N");

    public string Email { get; set; } = TestAccounts.NewEmail();

    /// <summary>The claims of the next ID token beyond the standard ones; a test may change them.</summary>
    public Dictionary<string, object> ExtraClaims { get; } = [];

    /// <summary>The token endpoint's requests, as form fields, for a test to look at.</summary>
    public List<Dictionary<string, string>> TokenRequests { get; } = [];

    /// <summary>Every other POST the API sent, by path, as form fields.</summary>
    public List<(string Path, Dictionary<string, string> Form)> OtherPosts { get; } = [];

    /// <summary>The client id the API asked for, for the ID token's audience.</summary>
    public string? ClientId { get; private set; }

    /// <summary>Hands the API's handler this fake for discovery, keys and tokens.</summary>
    public virtual void Register(IServiceCollection services) =>
        // The handler makes its HTTP client and configuration manager before a test's
        // post-configure runs, so replace both.
        services.PostConfigure<OpenIdConnectOptions>(Scheme, options =>
        {
            options.Backchannel = new HttpClient(this);
            options.ConfigurationManager = new ConfigurationManager<OpenIdConnectConfiguration>(
                options.MetadataAddress ?? $"{Authority.TrimEnd('/')}/.well-known/openid-configuration",
                new OpenIdConnectConfigurationRetriever(),
                new HttpDocumentRetriever(options.Backchannel));
        });

    /// <summary>The claims of the ID token the token endpoint hands out next.</summary>
    protected virtual Dictionary<string, object> Claims(string issuer)
    {
        var now = DateTimeOffset.UtcNow;
        var claims = new Dictionary<string, object>
        {
            ["iss"] = issuer,
            ["aud"] = ClientId ?? "unknown",
            ["sub"] = Subject,
            ["email"] = Email,
            ["iat"] = now.ToUnixTimeSeconds(),
            ["exp"] = now.AddMinutes(10).ToUnixTimeSeconds(),
        };
        if (_nonce is not null)
        {
            claims["nonce"] = _nonce;
        }

        foreach (var (name, value) in ExtraClaims)
        {
            claims[name] = value;
        }

        return claims;
    }

    /// <summary>The issuer of the next ID token.</summary>
    protected virtual string TokenIssuer => Authority;

    /// <summary>An ID token signed with this provider's key, for any audience and nonce, as a phone gets one.</summary>
    public string IdToken(string audience, string? nonce, Action<Dictionary<string, object>>? change = null)
    {
        _nonce = nonce;
        ClientId = audience;
        var claims = Claims(TokenIssuer);
        change?.Invoke(claims);
        return Sign(claims, _key);
    }

    /// <summary>The same token signed by a key nobody published.</summary>
    public static string SignedByStranger(Dictionary<string, object> claims) =>
        Sign(claims, new RsaSecurityKey(RSA.Create(2048)) { KeyId = "fake-key-1" });

    private static string Sign(Dictionary<string, object> claims, RsaSecurityKey key) =>
        new JsonWebTokenHandler().CreateToken(
            JsonSerializer.Serialize(claims), new SigningCredentials(key, SecurityAlgorithms.RsaSha256));

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var path = request.RequestUri!.AbsolutePath;
        if (path.EndsWith("/.well-known/openid-configuration", StringComparison.Ordinal))
        {
            var root = Authority.TrimEnd('/');
            return Json(new Dictionary<string, object>
            {
                ["issuer"] = DocumentIssuer,
                ["authorization_endpoint"] = $"{root}/authorize",
                ["token_endpoint"] = $"{root}/token",
                ["jwks_uri"] = $"{root}/keys",
                ["response_types_supported"] = new[] { "code" },
                ["subject_types_supported"] = new[] { "pairwise" },
                ["id_token_signing_alg_values_supported"] = new[] { "RS256" },
            });
        }

        if (path.EndsWith("/keys", StringComparison.Ordinal))
        {
            var jwk = JsonWebKeyConverter.ConvertFromRSASecurityKey(_key);
            return Json(new { keys = new[] { new { kty = jwk.Kty, use = "sig", kid = jwk.Kid, alg = "RS256", n = jwk.N, e = jwk.E } } });
        }

        var form = request.Content is null
            ? []
            : QueryHelpers.ParseQuery(await request.Content.ReadAsStringAsync(cancellationToken)).ToDictionary(p => p.Key, p => p.Value.ToString());
        if (path.EndsWith("/token", StringComparison.Ordinal))
        {
            TokenRequests.Add(form);
            ClientId = form.GetValueOrDefault("client_id") ?? ClientId;
            return Json(new
            {
                access_token = "fake-access",
                token_type = "Bearer",
                expires_in = 3600,
                refresh_token = $"fake-refresh-{Subject}",
                id_token = Sign(Claims(TokenIssuer), _key),
            });
        }

        OtherPosts.Add((path, form));
        return new HttpResponseMessage(HttpStatusCode.OK);
    }

    private static HttpResponseMessage Json(object body) => new(HttpStatusCode.OK)
    {
        Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json"),
    };

    public string StartPath(string returnUrl = "/account", bool link = false) =>
        $"/api/v1/external-sign-ins/{Provider}?returnUrl={Uri.EscapeDataString(returnUrl)}" + (link ? "&link=true" : "");

    /// <summary>
    /// Runs the browser's side from <paramref name="startPath"/> and returns the last response,
    /// the redirect the API sends the browser to when it is done.
    /// </summary>
    public async Task<HttpResponseMessage> SignInAsync(ApiClient client, string? startPath = null)
    {
        var callback = await ReturnToCallbackAsync(client, startPath ?? StartPath(), error: null);
        Assert.True(callback.StatusCode == HttpStatusCode.Redirect, $"The callback answered {(int)callback.StatusCode}: {await callback.Content.ReadAsStringAsync(TestContext.Current.CancellationToken)}");
        return await client.GetAsync(FakeGoogle.FollowHop(callback.Headers.Location!));
    }

    /// <summary>The browser coming back from the provider with a code: the callback's own answer.</summary>
    public Task<HttpResponseMessage> CallbackAsync(ApiClient client, string? startPath = null) =>
        ReturnToCallbackAsync(client, startPath ?? StartPath(), error: null);

    /// <summary>The browser coming back from the provider with an error, as when the person presses Cancel.</summary>
    public Task<HttpResponseMessage> CancelAsync(ApiClient client, string? startPath = null) =>
        ReturnToCallbackAsync(client, startPath ?? StartPath(), error: "access_denied");

    /// <summary>What the browser sends back besides the code, such as Apple's first-time <c>user</c>.</summary>
    protected virtual void AddCallbackFields(Dictionary<string, string> fields)
    {
    }

    private async Task<HttpResponseMessage> ReturnToCallbackAsync(ApiClient client, string startPath, string? error)
    {
        var start = await client.GetAsync(startPath);
        Assert.Equal(HttpStatusCode.Redirect, start.StatusCode);
        var toProvider = start.Headers.Location!;
        Assert.Equal(AuthorizeHost, toProvider.Host);
        var query = QueryHelpers.ParseQuery(toProvider.Query);
        _nonce = query["nonce"].ToString();
        ClientId = query["client_id"].ToString();
        var callbackPath = new Uri(query["redirect_uri"].ToString()).AbsolutePath;
        var fields = new Dictionary<string, string> { ["state"] = query["state"].ToString() };
        if (error is null)
        {
            fields["code"] = "fake-code";
            AddCallbackFields(fields);
        }
        else
        {
            fields["error"] = error;
        }

        if (query.TryGetValue("response_mode", out var mode) && mode == "form_post")
        {
            return await client.Http.PostAsync(callbackPath, new FormUrlEncodedContent(fields), TestContext.Current.CancellationToken);
        }

        return await client.GetAsync(QueryHelpers.AddQueryString(callbackPath, fields!));
    }
}

/// <summary>Microsoft's common endpoint: personal accounts and work or school accounts from any tenant.</summary>
internal sealed class FakeMicrosoft : FakeOidcProvider
{
    public const string ConsumersTenant = "9188040d-6c67-4c5b-b112-36a304b66dad";

    public override string Authority => "https://login.microsoftonline.com/common/v2.0";

    public override string Provider => "microsoft";

    protected override string Scheme => "Microsoft";

    protected override string DocumentIssuer => "https://login.microsoftonline.com/{tenantid}/v2.0";

    /// <summary>The tenant of the account; a personal account by default.</summary>
    public string Tenant { get; set; } = ConsumersTenant;

    public string Name { get; set; } = "Sam Microsoft";

    protected override string TokenIssuer => $"https://login.microsoftonline.com/{Tenant}/v2.0";

    protected override Dictionary<string, object> Claims(string issuer)
    {
        var claims = base.Claims(issuer);
        claims.TryAdd("tid", Tenant);
        claims.TryAdd("name", Name);
        return claims;
    }

    public static IReadOnlyDictionary<string, string> Settings => new Dictionary<string, string>
    {
        ["Authentication:Microsoft:ClientId"] = "6f1c2c1e-0000-4000-8000-000000000001",
        ["Authentication:Microsoft:ClientSecret"] = "ms-test-secret",
    };
}

/// <summary>Sign in with Apple: a form post back, the name only the first time, and a JWT client secret.</summary>
internal sealed class FakeApple : FakeOidcProvider
{
    public const string ServicesId = "com.runovahq.web";
    public const string TeamId = "TEAM123456";
    public const string KeyId = "KEY1234567";

    public static readonly string PrivateKey = TestAppleKeys.NewPrivateKeyPem();

    public override string Authority => "https://appleid.apple.com";

    public override string Provider => "apple";

    protected override string Scheme => "Apple";

    /// <summary>The <c>user</c> field Apple posts on the very first sign-in only; null after.</summary>
    public string? FirstTimeName { get; set; } = "Sam Apple";

    protected override Dictionary<string, object> Claims(string issuer)
    {
        var claims = base.Claims(issuer);
        claims.TryAdd("email_verified", "true");
        return claims;
    }

    protected override void AddCallbackFields(Dictionary<string, string> fields)
    {
        if (FirstTimeName is { } name)
        {
            var parts = name.Split(' ', 2);
            fields["user"] = JsonSerializer.Serialize(new { name = new { firstName = parts[0], lastName = parts.ElementAtOrDefault(1) ?? "" }, email = Email });
        }
    }

    /// <summary>Also takes the API's calls to revoke a token.</summary>
    public override void Register(IServiceCollection services)
    {
        base.Register(services);
        services.AddHttpClient(Runova.Website.Api.Accounts.AppleTokens.HttpClientName).ConfigurePrimaryHttpMessageHandler(() => this);
    }

    /// <summary>Apple's public key for client secrets made with <see cref="PrivateKey"/>.</summary>
    public static ECDsaSecurityKey PublicKey()
    {
        var key = ECDsa.Create();
        key.ImportFromPem(PrivateKey);
        return new ECDsaSecurityKey(key);
    }

    public static IReadOnlyDictionary<string, string> Settings => new Dictionary<string, string>
    {
        ["Authentication:Apple:ServicesId"] = ServicesId,
        ["Authentication:Apple:TeamId"] = TeamId,
        ["Authentication:Apple:KeyId"] = KeyId,
        ["Authentication:Apple:PrivateKey"] = PrivateKey,
    };
}

/// <summary>Google as it signs the ID tokens Credential Manager hands the Android app.</summary>
internal sealed class FakeGoogleIdTokens : FakeOidcProvider
{
    public override string Authority => "https://accounts.google.com";

    public override string Provider => "google";

    protected override string Scheme => "Google";

    protected override Dictionary<string, object> Claims(string issuer)
    {
        var claims = base.Claims(issuer);
        claims.TryAdd("email_verified", true);
        claims.TryAdd("name", "Sam Google");
        return claims;
    }

    /// <summary>The Google handler is OAuth, not OpenID Connect, so there is nothing to hand it.</summary>
    public override void Register(IServiceCollection services)
    {
    }
}

/// <summary>
/// Hands the API's ID token checker the fakes, by host: Google's and Apple's discovery documents
/// and signing keys.
/// </summary>
internal sealed class FakeIdTokenProviders(IReadOnlyDictionary<string, HttpMessageInvoker> byHost) : HttpMessageHandler
{
    public static void Register(IServiceCollection services, params FakeOidcProvider[] providers)
    {
        var byHost = providers.ToDictionary(p => p.AuthorizeHost, p => new HttpMessageInvoker(p, disposeHandler: false));
        services.AddHttpClient(Runova.Website.Api.Accounts.IdTokenValidator.HttpClientName)
            .ConfigurePrimaryHttpMessageHandler(() => new FakeIdTokenProviders(byHost));
    }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
        byHost[request.RequestUri!.Host].SendAsync(request, cancellationToken);
}
