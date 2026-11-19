using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.DependencyInjection;
using Runova.Website.Data.Identity;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Accounts;

/// <summary>
/// The phone app signing in with the system's own Google or Apple sheet (E117): a nonce from
/// <c>/sign-in-nonces</c>, then the <c>id_token</c> grant of <c>/device-tokens</c>. The same
/// account rules as the website apply.
/// </summary>
public sealed class IdTokenDeviceTokensTests : IDisposable
{
    private const string Nonces = "/api/v1/sign-in-nonces";
    private const string Tokens = "/api/v1/device-tokens";
    private const string BundleId = "com.runovahq.app";

    private readonly FakeGoogleIdTokens _google = new() { Email = TestAccounts.NewEmail() };
    private readonly FakeApple _apple = new() { Email = TestAccounts.NewEmail() };
    private readonly string _connectionString;
    private readonly WebsiteApiFactory _factory;

    public IdTokenDeviceTokensTests(PostgresFixture postgres)
    {
        _connectionString = postgres.ConnectionString;
        _factory = Factory(FakeGoogle.Settings.Concat(FakeApple.Settings).ToDictionary());
    }

    public void Dispose() => _factory.Dispose();

    private WebsiteApiFactory Factory(IReadOnlyDictionary<string, string> settings) =>
        new(_connectionString, settings: settings, services: services =>
        {
            _apple.Register(services);
            FakeIdTokenProviders.Register(services, _google, _apple);
        });

    private static async Task<JsonElement> NonceAsync(ApiClient phone, string provider) =>
        await ApiClient.ReadJsonAsync(await phone.SendAsync(HttpMethod.Post, Nonces, new { provider }), HttpStatusCode.Created);

    private static Task<HttpResponseMessage> GrantAsync(
        ApiClient phone, string provider, string idToken, string nonce, string? authorizationCode = null, string? name = null, string? platform = "android") =>
        phone.SendAsync(HttpMethod.Post, Tokens, new
        {
            grantType = "id_token",
            provider,
            idToken,
            nonce,
            authorizationCode,
            name,
            platform,
            appVersion = "1.5.0",
            deviceId = Guid.NewGuid(),
        });

    /// <summary>What Android does: a nonce, Google's sheet, the grant.</summary>
    private async Task<HttpResponseMessage> GoogleSignInAsync(Action<Dictionary<string, object>>? change = null)
    {
        var phone = _factory.CreateApiClient();
        var nonce = (await NonceAsync(phone, "google")).GetProperty("nonce").GetString()!;
        return await GrantAsync(phone, "google", _google.IdToken(FakeGoogle.ClientId, nonce, change), nonce);
    }

    /// <summary>What the iPhone does: a nonce, Sign in with Apple, the grant with Apple's code.</summary>
    private async Task<HttpResponseMessage> AppleSignInAsync(string? name = "Sam Apple")
    {
        var phone = _factory.CreateApiClient();
        var nonce = (await NonceAsync(phone, "apple")).GetProperty("nonce").GetString()!;
        return await GrantAsync(phone, "apple", _apple.IdToken(BundleId, nonce), nonce, "apple-code", name, "ios");
    }

    [Fact]
    public async Task A_nonce_names_googles_web_client_for_credential_manager()
    {
        var nonce = await NonceAsync(_factory.CreateApiClient(), "google");

        Assert.Matches("^[A-Za-z0-9_-]{43}$", nonce.GetProperty("nonce").GetString());
        Assert.Equal(FakeGoogle.ClientId, nonce.GetProperty("clientId").GetString());
        Assert.True(nonce.GetProperty("expiresAt").GetDateTimeOffset() <= DateTimeOffset.UtcNow.AddMinutes(5).AddSeconds(5));
    }

    [Fact]
    public async Task A_nonce_is_only_for_google_or_apple_and_only_while_it_is_on()
    {
        using var plain = Factory(new Dictionary<string, string>());
        var phone = plain.CreateApiClient();

        var off = await phone.SendAsync(HttpMethod.Post, Nonces, new { provider = "google" });
        var microsoft = await phone.SendAsync(HttpMethod.Post, Nonces, new { provider = "microsoft" });

        await ProblemAssert.IsProblemAsync(off, HttpStatusCode.NotFound, ProblemAssert.Type("not-found"), Nonces);
        await ProblemAssert.IsProblemAsync(microsoft, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Nonces);
    }

    [Fact]
    public async Task A_google_token_from_android_makes_the_account_and_a_phone_session()
    {
        var tokens = await ApiClient.ReadJsonAsync(await GoogleSignInAsync(), HttpStatusCode.OK);

        Assert.StartsWith("rd1.", tokens.GetProperty("accessToken").GetString(), StringComparison.Ordinal);
        var account = tokens.GetProperty("account");
        Assert.Equal(_google.Email, account.GetProperty("email").GetString());
        Assert.Equal(["google"], account.GetProperty("logins").EnumerateArray().Select(l => l.GetString()));
        Assert.Equal("Sam Google", account.GetProperty("displayName").GetString());
    }

    [Fact]
    public async Task Signing_in_again_with_google_finds_the_same_account()
    {
        var first = await ApiClient.ReadJsonAsync(await GoogleSignInAsync(), HttpStatusCode.OK);

        var second = await ApiClient.ReadJsonAsync(await GoogleSignInAsync(), HttpStatusCode.OK);

        Assert.Equal(first.GetProperty("account").GetProperty("id").GetInt64(), second.GetProperty("account").GetProperty("id").GetInt64());
    }

    [Fact]
    public async Task An_apple_token_for_the_app_makes_the_account_with_the_name_the_app_sends()
    {
        var tokens = await ApiClient.ReadJsonAsync(await AppleSignInAsync(), HttpStatusCode.OK);

        var account = tokens.GetProperty("account");
        Assert.Equal(_apple.Email, account.GetProperty("email").GetString());
        Assert.Equal("Sam Apple", account.GetProperty("displayName").GetString());
        Assert.Equal(["apple"], account.GetProperty("logins").EnumerateArray().Select(l => l.GetString()));
    }

    [Fact]
    public async Task Apples_code_from_the_app_is_traded_for_a_refresh_token_kept_for_revoking()
    {
        var tokens = await ApiClient.ReadJsonAsync(await AppleSignInAsync(), HttpStatusCode.OK);

        var exchange = Assert.Single(_apple.TokenRequests);
        Assert.Equal(BundleId, exchange["client_id"]);
        Assert.Equal("apple-code", exchange["code"]);
        Assert.Equal("authorization_code", exchange["grant_type"]);
        using var scope = _factory.Services.CreateScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<AppUser>>();
        var user = (await users.FindByIdAsync(tokens.GetProperty("account").GetProperty("id").GetInt64().ToString(System.Globalization.CultureInfo.InvariantCulture)))!;
        Assert.NotNull(await users.GetAuthenticationTokenAsync(user, "Apple", "refresh_token"));
    }

    [Theory]
    [InlineData("audience")]
    [InlineData("issuer")]
    [InlineData("expired")]
    [InlineData("signature")]
    [InlineData("nonce")]
    public async Task A_token_that_does_not_check_out_is_refused(string wrong)
    {
        var phone = _factory.CreateApiClient();
        var nonce = (await NonceAsync(phone, "google")).GetProperty("nonce").GetString()!;
        var token = _google.IdToken(wrong == "audience" ? "another-app.apps.googleusercontent.com" : FakeGoogle.ClientId, nonce, claims =>
        {
            if (wrong == "issuer") claims["iss"] = "https://evil.example";
            if (wrong == "nonce") claims["nonce"] = "some-other-nonce";
            if (wrong == "expired")
            {
                claims["iat"] = DateTimeOffset.UtcNow.AddHours(-2).ToUnixTimeSeconds();
                claims["exp"] = DateTimeOffset.UtcNow.AddHours(-1).ToUnixTimeSeconds();
            }
        });
        if (wrong == "signature")
        {
            token = FakeOidcProvider.SignedByStranger(Payload(token));
        }

        var response = await GrantAsync(phone, "google", token, nonce);

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Unauthorized, ProblemAssert.Type("unauthorized"), Tokens);
        Assert.Null(await TestAccounts.FindAsync(_factory.Services, _google.Email));
    }

    [Fact]
    public async Task A_nonce_works_once()
    {
        var phone = _factory.CreateApiClient();
        var nonce = (await NonceAsync(phone, "google")).GetProperty("nonce").GetString()!;
        var token = _google.IdToken(FakeGoogle.ClientId, nonce);

        var first = await GrantAsync(phone, "google", token, nonce);
        var again = await GrantAsync(phone, "google", token, nonce);

        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        await ProblemAssert.IsProblemAsync(again, HttpStatusCode.Unauthorized, ProblemAssert.Type("unauthorized"), Tokens);
    }

    [Fact]
    public async Task A_nonce_works_only_for_its_own_provider()
    {
        var phone = _factory.CreateApiClient();
        var nonce = (await NonceAsync(phone, "apple")).GetProperty("nonce").GetString()!;

        var response = await GrantAsync(phone, "google", _google.IdToken(FakeGoogle.ClientId, nonce), nonce);

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Unauthorized, ProblemAssert.Type("unauthorized"), Tokens);
    }

    [Fact]
    public async Task A_made_up_nonce_is_refused()
    {
        var response = await GrantAsync(_factory.CreateApiClient(), "google", _google.IdToken(FakeGoogle.ClientId, "made-up-nonce"), "made-up-nonce");

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Unauthorized, ProblemAssert.Type("unauthorized"), Tokens);
    }

    [Fact]
    public async Task An_existing_confirmed_account_is_never_taken_by_email_alone()
    {
        var owner = await TestAccounts.CreateAsync(_factory.Services);
        _google.Email = owner.Email!;

        var response = await GoogleSignInAsync();

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Conflict, ProblemAssert.Type("conflict"), Tokens);
        Assert.Equal(owner.PasswordHash, (await TestAccounts.ReloadAsync(_factory.Services, owner.Id)).PasswordHash);
    }

    [Fact]
    public async Task An_unverified_google_email_is_refused()
    {
        var response = await GoogleSignInAsync(claims => claims["email_verified"] = false);

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Forbidden, ProblemAssert.Type("email-unverified"), Tokens);
    }

    [Fact]
    public async Task An_account_with_two_factor_is_sent_to_the_browser_for_its_code()
    {
        await ApiClient.ReadJsonAsync(await GoogleSignInAsync(), HttpStatusCode.OK);
        await TestUsers.EnableTwoFactorAsync(_factory.Services, (await TestAccounts.FindAsync(_factory.Services, _google.Email))!);

        var response = await GoogleSignInAsync();

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Unauthorized, ProblemAssert.Type("two-factor-required"), Tokens);
    }

    [Fact]
    public async Task The_grant_is_for_the_phone_app_only()
    {
        var phone = _factory.CreateApiClient();
        var nonce = (await NonceAsync(phone, "google")).GetProperty("nonce").GetString()!;

        var response = await GrantAsync(phone, "google", _google.IdToken(FakeGoogle.ClientId, nonce), nonce, platform: null);

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Tokens);
        Assert.True(problem.GetProperty("errors").TryGetProperty("platform", out _));
    }

    private static Dictionary<string, object> Payload(string jwt)
    {
        var json = System.Text.Encoding.UTF8.GetString(Microsoft.IdentityModel.Tokens.Base64UrlEncoder.DecodeBytes(jwt.Split('.')[1]));
        return JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json)!.ToDictionary(p => p.Key, p => (object)p.Value);
    }
}
