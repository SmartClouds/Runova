using System.Buffers.Text;
using System.Net;
using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.Website.Data;
using Runova.Website.Data.Accounts;
using Runova.Website.Data.Identity;
using Runova.Website.IntegrationTests.Infrastructure;
using static Runova.Website.IntegrationTests.Infrastructure.TestPasskeys;

namespace Runova.Website.IntegrationTests.Accounts;

/// <summary>The phone app signing in with a passkey: the <c>passkey</c> grant of <c>/device-tokens</c> (E115).</summary>
public sealed class PasskeyDeviceTokensTests : IDisposable
{
    private const string Tokens = "/api/v1/device-tokens";

    // A made-up signing certificate's SHA-256, as keytool prints it.
    private static readonly byte[] _certificateHash = SHA256.HashData("runova test signing certificate"u8);
    private static readonly string _fingerprint = string.Join(':', _certificateHash.Select(b => b.ToString("X2", System.Globalization.CultureInfo.InvariantCulture)));
    private static readonly string _androidOrigin = "android:apk-key-hash:" + Base64Url.EncodeToString(_certificateHash);

    private readonly string _connectionString;
    private readonly WebsiteApiFactory _factory;
    private readonly SoftwarePasskey _passkey = new();

    public PasskeyDeviceTokensTests(PostgresFixture postgres)
    {
        _connectionString = postgres.ConnectionString;
        _factory = new(_connectionString, settings: new Dictionary<string, string> { ["Website:Passkeys:AndroidCertFingerprints"] = _fingerprint });
    }

    public void Dispose()
    {
        _passkey.Dispose();
        _factory.Dispose();
    }

    private async Task<AppUser> AccountWithPasskeyAsync()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        await AddAsync(await TestAccounts.SignedInClientAsync(_factory, user), _passkey);
        return user;
    }

    /// <summary>What the phone does: a challenge with no cookie, the passkey's answer, the grant.</summary>
    private async Task<HttpResponseMessage> PhoneSignInAsync(string platform = "android", Guid? deviceId = null, SoftwarePasskey? passkey = null)
    {
        var phone = _factory.CreateApiClient();
        var challenge = await ChallengeAsync(phone, "sign-in");
        return await phone.SendAsync(HttpMethod.Post, Tokens, new
        {
            grantType = "passkey",
            challengeId = challenge.Id,
            credential = (passkey ?? _passkey).Get(challenge.Options),
            platform,
            appVersion = "1.4.0",
            deviceId = deviceId ?? Guid.NewGuid(),
        });
    }

    [Fact]
    public async Task A_passkey_from_the_android_app_gets_tokens_and_a_phone_session()
    {
        var user = await AccountWithPasskeyAsync();
        _passkey.Origin = _androidOrigin;

        var tokens = await ApiClient.ReadJsonAsync(await PhoneSignInAsync(), HttpStatusCode.OK);

        Assert.StartsWith("rd1.", tokens.GetProperty("accessToken").GetString(), StringComparison.Ordinal);
        Assert.StartsWith("rr1.", tokens.GetProperty("refreshToken").GetString(), StringComparison.Ordinal);
        Assert.Equal(user.Id, tokens.GetProperty("account").GetProperty("id").GetInt64());
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var session = await db.AccountSessions.SingleAsync(s => s.Id == tokens.GetProperty("sessionId").GetInt64(), TestContext.Current.CancellationToken);
        Assert.Equal(AccountSessionKinds.Mobile, session.Kind);
        Assert.Equal("Phone", session.Platform);
        Assert.Equal("Runova app", session.DeviceName);
        Assert.Equal("1.4.0", session.AppVersion);
        Assert.Contains(await db.AccountActivities.Where(a => a.UserId == user.Id).Select(a => a.Action).ToListAsync(TestContext.Current.CancellationToken), a => a == "device-sign-in");
    }

    [Fact]
    public async Task The_ios_app_answers_from_the_site_s_own_origin()
    {
        await AccountWithPasskeyAsync();

        var response = await PhoneSignInAsync(platform: "ios");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task An_android_app_signed_with_another_certificate_is_refused()
    {
        await AccountWithPasskeyAsync();
        _passkey.Origin = "android:apk-key-hash:" + Base64Url.EncodeToString(SHA256.HashData("someone else"u8));

        await ProblemAssert.IsAsync(await PhoneSignInAsync(), HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task The_android_origin_is_refused_when_no_fingerprint_is_set()
    {
        using var plain = new WebsiteApiFactory(_connectionString);
        var user = await TestAccounts.CreateAsync(plain.Services);
        await AddAsync(await TestAccounts.SignedInClientAsync(plain, user), _passkey);
        _passkey.Origin = _androidOrigin;
        var phone = plain.CreateApiClient();
        var challenge = await ChallengeAsync(phone, "sign-in");

        var response = await phone.SendAsync(HttpMethod.Post, Tokens, new { grantType = "passkey", challengeId = challenge.Id, credential = _passkey.Get(challenge.Options), platform = "android" });

        await ProblemAssert.IsAsync(response, HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Signing_in_again_on_the_same_phone_ends_its_older_session()
    {
        await AccountWithPasskeyAsync();
        var device = Guid.NewGuid();
        var first = await ApiClient.ReadJsonAsync(await PhoneSignInAsync(platform: "ios", deviceId: device), HttpStatusCode.OK);

        await ApiClient.ReadJsonAsync(await PhoneSignInAsync(platform: "ios", deviceId: device), HttpStatusCode.OK);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var older = await db.AccountSessions.SingleAsync(s => s.Id == first.GetProperty("sessionId").GetInt64(), TestContext.Current.CancellationToken);
        Assert.NotNull(older.RevokedAt);
    }

    [Fact]
    public async Task The_refresh_token_rotates_like_any_other()
    {
        await AccountWithPasskeyAsync();
        var tokens = await ApiClient.ReadJsonAsync(await PhoneSignInAsync(platform: "ios"), HttpStatusCode.OK);

        var refreshed = await _factory.CreateApiClient().SendAsync(HttpMethod.Post, Tokens, new { grantType = "refresh_token", refreshToken = tokens.GetProperty("refreshToken").GetString() });

        var rotated = await ApiClient.ReadJsonAsync(refreshed, HttpStatusCode.OK);
        Assert.NotEqual(tokens.GetProperty("refreshToken").GetString(), rotated.GetProperty("refreshToken").GetString());
    }

    [Theory]
    [InlineData("windows")]
    [InlineData("")]
    public async Task The_passkey_grant_is_for_phones_only(string platform)
    {
        await AccountWithPasskeyAsync();

        var response = await PhoneSignInAsync(platform: platform);

        var problem = await ProblemAssert.IsAsync(response, HttpStatusCode.BadRequest);
        Assert.True(problem.GetProperty("errors").TryGetProperty("platform", out _));
    }

    [Fact]
    public async Task A_passkey_the_site_never_saw_gets_no_tokens()
    {
        await AccountWithPasskeyAsync();
        using var stranger = new SoftwarePasskey { UserHandle = _passkey.UserHandle };

        await ProblemAssert.IsAsync(await PhoneSignInAsync(platform: "ios", passkey: stranger), HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task A_disabled_account_gets_no_tokens()
    {
        var user = await AccountWithPasskeyAsync();
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            await db.Users.Where(u => u.Id == user.Id).ExecuteUpdateAsync(u => u.SetProperty(x => x.DisabledAt, DateTimeOffset.UtcNow), TestContext.Current.CancellationToken);
        }

        await ProblemAssert.IsAsync(await PhoneSignInAsync(platform: "ios"), HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Missing_challenge_or_answer_is_a_validation_problem()
    {
        var response = await _factory.CreateApiClient().SendAsync(HttpMethod.Post, Tokens, new { grantType = "passkey", platform = "ios" });

        await ProblemAssert.IsAsync(response, HttpStatusCode.BadRequest);
    }

}
