using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.Data.Identity;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Accounts;

/// <summary>Signing the desktop app in: the browser approves the computer, the app trades the code for tokens.</summary>
public sealed class DeviceTokensTests : IAsyncLifetime
{
    private const string Redirect = "http://127.0.0.1:53111/callback";
    private const string PhoneRedirect = "com.runovahq.app:/auth/callback";
    private const string Tokens = "/api/v1/device-tokens";

    private readonly PostgresFixture _postgres;
    private readonly FakeTimeProvider _time = new(DateTimeOffset.UtcNow);
    private WebsiteApiFactory _factory = null!;

    public DeviceTokensTests(PostgresFixture postgres) => _postgres = postgres;

    public ValueTask InitializeAsync()
    {
        _factory = new WebsiteApiFactory(_postgres.ConnectionString, time: _time);
        return ValueTask.CompletedTask;
    }

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    private static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static (string Verifier, string Challenge) Pkce()
    {
        var verifier = Base64Url(RandomNumberGenerator.GetBytes(32));
        return (verifier, Base64Url(SHA256.HashData(Encoding.ASCII.GetBytes(verifier))));
    }

    private static object Approval(string challenge, string redirectUri = Redirect, string clientId = "runova-desktop", Guid? deviceId = null) => new
    {
        clientId,
        redirectUri,
        codeChallenge = challenge,
        codeChallengeMethod = "S256",
        state = "state-1234567890",
        deviceName = "Sam's MacBook",
        platform = "macos",
        appVersion = "3.4.0",
        deviceId = deviceId ?? Guid.NewGuid(),
    };

    private static object PhoneApproval(string challenge, string redirectUri = PhoneRedirect, string clientId = "runova-mobile", string platform = "ios") => new
    {
        clientId,
        redirectUri,
        codeChallenge = challenge,
        codeChallengeMethod = "S256",
        state = "state-1234567890",
        deviceName = "Sam's phone",
        platform,
        appVersion = "1.0.0",
        deviceId = Guid.NewGuid(),
    };

    /// <summary>The browser's side: approve, and read the code out of the redirect it gets back.</summary>
    private static async Task<(string Code, string Verifier)> ApproveAsync(ApiClient browser, Guid? deviceId = null)
    {
        var (verifier, challenge) = Pkce();
        var response = await browser.SendAsync(HttpMethod.Post, "/api/v1/device-authorizations", Approval(challenge, deviceId: deviceId));
        var body = await ApiClient.ReadJsonAsync(response, HttpStatusCode.Created);
        var redirect = new Uri(body.GetProperty("redirectUrl").GetString()!);
        Assert.Equal("127.0.0.1", redirect.Host);
        Assert.Contains("state=state-1234567890", redirect.Query, StringComparison.Ordinal);
        var code = System.Web.HttpUtility.ParseQueryString(redirect.Query)["code"]!;
        return (code, verifier);
    }

    private Task<HttpResponseMessage> TradeAsync(string code, string verifier, string redirectUri = Redirect) =>
        _factory.CreateClient().PostAsJsonAsync(Tokens, new { grantType = "authorization_code", code, codeVerifier = verifier, redirectUri, refreshToken = (string?)null }, TestContext.Current.CancellationToken);

    private Task<HttpResponseMessage> RefreshAsync(string refreshToken) =>
        _factory.CreateClient().PostAsJsonAsync(Tokens, new { grantType = "refresh_token", code = (string?)null, codeVerifier = (string?)null, redirectUri = (string?)null, refreshToken }, TestContext.Current.CancellationToken);

    private HttpClient Bearer(string accessToken)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        return client;
    }

    private async Task<(AppUser User, ApiClient Browser, JsonElement Tokens)> SignedInDeviceAsync(Guid? deviceId = null)
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var browser = await TestAccounts.SignedInClientAsync(_factory, user);
        var (code, verifier) = await ApproveAsync(browser, deviceId);
        var tokens = await ApiClient.ReadJsonAsync(await TradeAsync(code, verifier), HttpStatusCode.OK);
        return (user, browser, tokens);
    }

    [Fact]
    public async Task An_approved_computer_gets_tokens_that_reach_the_account()
    {
        var (user, browser, tokens) = await SignedInDeviceAsync();

        Assert.Equal(900, tokens.GetProperty("expiresIn").GetInt32());
        Assert.Equal(user.Email, tokens.GetProperty("account").GetProperty("email").GetString());
        var me = await Bearer(tokens.GetProperty("accessToken").GetString()!).GetAsync("/api/v1/accounts/me", TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.OK, me.StatusCode);
        var sessions = await ApiClient.ReadJsonAsync(await browser.GetAsync("/api/v1/sessions"), HttpStatusCode.OK);
        var desktop = Assert.Single(sessions.GetProperty("items").EnumerateArray(), s => s.GetProperty("kind").GetString() == "desktop");
        Assert.Equal("Sam's MacBook", desktop.GetProperty("deviceName").GetString());
        Assert.Equal("macOS", desktop.GetProperty("platform").GetString());
    }

    [Fact]
    public async Task A_wrong_verifier_a_used_code_and_another_redirect_are_refused()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var browser = await TestAccounts.SignedInClientAsync(_factory, user);
        var (code, verifier) = await ApproveAsync(browser);
        var (other, otherVerifier) = await ApproveAsync(browser);

        Assert.Equal(HttpStatusCode.Unauthorized, (await TradeAsync(code, "not-the-verifier-but-long-enough-0000000000")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await TradeAsync(code, verifier)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await TradeAsync(code, verifier)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await TradeAsync(other, otherVerifier, "http://127.0.0.1:1/callback")).StatusCode);
    }

    [Fact]
    public async Task A_code_lasts_two_minutes()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var browser = await TestAccounts.SignedInClientAsync(_factory, user);
        var (code, verifier) = await ApproveAsync(browser);

        _time.Advance(TimeSpan.FromMinutes(3));

        Assert.Equal(HttpStatusCode.Unauthorized, (await TradeAsync(code, verifier)).StatusCode);
    }

    [Theory]
    [InlineData("https://evil.example/callback", "runova-desktop")]
    [InlineData("http://192.168.1.5:5000/callback", "runova-desktop")]
    [InlineData("http://127.0.0.1:5000/elsewhere", "runova-desktop")]
    [InlineData(Redirect, "someone-else")]
    public async Task Only_the_desktop_app_on_a_loopback_address_can_be_approved(string redirectUri, string clientId)
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var browser = await TestAccounts.SignedInClientAsync(_factory, user);

        var response = await browser.SendAsync(HttpMethod.Post, "/api/v1/device-authorizations", Approval(Pkce().Challenge, redirectUri, clientId));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task A_phone_signs_in_through_its_own_redirect_and_shows_as_the_runova_app()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var browser = await TestAccounts.SignedInClientAsync(_factory, user);
        var (verifier, challenge) = Pkce();

        var approved = await ApiClient.ReadJsonAsync(
            await browser.SendAsync(HttpMethod.Post, "/api/v1/device-authorizations", PhoneApproval(challenge)),
            HttpStatusCode.Created);
        var redirect = approved.GetProperty("redirectUrl").GetString()!;
        var code = System.Web.HttpUtility.ParseQueryString(new Uri(redirect).Query)["code"]!;
        await ApiClient.ReadJsonAsync(await TradeAsync(code, verifier, PhoneRedirect), HttpStatusCode.OK);

        Assert.StartsWith($"{PhoneRedirect}?code=", redirect, StringComparison.Ordinal);
        var sessions = await ApiClient.ReadJsonAsync(await browser.GetAsync("/api/v1/sessions"), HttpStatusCode.OK);
        var phone = Assert.Single(sessions.GetProperty("items").EnumerateArray(), s => s.GetProperty("kind").GetString() == "mobile");
        Assert.Equal("Runova app", phone.GetProperty("deviceName").GetString());
        Assert.Equal("Phone", phone.GetProperty("platform").GetString());
    }

    [Theory]
    [InlineData("com.runovahq.app:/elsewhere", "runova-mobile", "ios")]
    [InlineData("com.other.app:/auth/callback", "runova-mobile", "ios")]
    [InlineData("https://evil.example/callback", "runova-mobile", "ios")]
    [InlineData(Redirect, "runova-mobile", "android")]
    [InlineData(PhoneRedirect, "runova-mobile", "windows")]
    [InlineData(PhoneRedirect, "runova-desktop", "ios")]
    public async Task A_phone_sign_in_needs_the_phone_redirect_and_a_phone_platform(string redirectUri, string clientId, string platform)
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var browser = await TestAccounts.SignedInClientAsync(_factory, user);

        var response = await browser.SendAsync(HttpMethod.Post, "/api/v1/device-authorizations", PhoneApproval(Pkce().Challenge, redirectUri, clientId, platform));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Approving_needs_a_signed_in_browser()
    {
        var response = await _factory.CreateApiClient().SendAsync(HttpMethod.Post, "/api/v1/device-authorizations", Approval(Pkce().Challenge));

        Assert.True(response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task A_refresh_rotates_both_tokens()
    {
        var (_, _, tokens) = await SignedInDeviceAsync();

        var refreshed = await ApiClient.ReadJsonAsync(await RefreshAsync(tokens.GetProperty("refreshToken").GetString()!), HttpStatusCode.OK);

        Assert.NotEqual(tokens.GetProperty("refreshToken").GetString(), refreshed.GetProperty("refreshToken").GetString());
        Assert.Equal(tokens.GetProperty("sessionId").GetInt64(), refreshed.GetProperty("sessionId").GetInt64());
        Assert.Equal(HttpStatusCode.OK, (await Bearer(refreshed.GetProperty("accessToken").GetString()!).GetAsync("/api/v1/accounts/me", TestContext.Current.CancellationToken)).StatusCode);
    }

    [Fact]
    public async Task A_refresh_token_used_twice_ends_the_session()
    {
        var (_, _, tokens) = await SignedInDeviceAsync();
        var first = tokens.GetProperty("refreshToken").GetString()!;
        var refreshed = await ApiClient.ReadJsonAsync(await RefreshAsync(first), HttpStatusCode.OK);
        _time.Advance(TimeSpan.FromMinutes(2));

        var reused = await RefreshAsync(first);

        Assert.Equal(HttpStatusCode.Unauthorized, reused.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await RefreshAsync(refreshed.GetProperty("refreshToken").GetString()!)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Bearer(refreshed.GetProperty("accessToken").GetString()!).GetAsync("/api/v1/accounts/me", TestContext.Current.CancellationToken)).StatusCode);
    }

    [Fact]
    public async Task A_retry_with_the_old_token_right_after_a_refresh_is_refused_but_ends_nothing()
    {
        var (_, _, tokens) = await SignedInDeviceAsync();
        var first = tokens.GetProperty("refreshToken").GetString()!;
        var refreshed = await ApiClient.ReadJsonAsync(await RefreshAsync(first), HttpStatusCode.OK);

        Assert.Equal(HttpStatusCode.Unauthorized, (await RefreshAsync(first)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await RefreshAsync(refreshed.GetProperty("refreshToken").GetString()!)).StatusCode);
    }

    [Fact]
    public async Task Ending_the_computer_s_session_in_the_browser_stops_its_tokens_at_once()
    {
        var (_, browser, tokens) = await SignedInDeviceAsync();
        var sessionId = tokens.GetProperty("sessionId").GetInt64();

        await browser.SendAsync(HttpMethod.Delete, $"/api/v1/sessions/{sessionId}");

        Assert.Equal(HttpStatusCode.Unauthorized, (await Bearer(tokens.GetProperty("accessToken").GetString()!).GetAsync("/api/v1/accounts/me", TestContext.Current.CancellationToken)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await RefreshAsync(tokens.GetProperty("refreshToken").GetString()!)).StatusCode);
    }

    [Fact]
    public async Task A_bearer_request_needs_no_antiforgery_and_can_sign_the_computer_out()
    {
        var (_, browser, tokens) = await SignedInDeviceAsync();
        var bearer = Bearer(tokens.GetProperty("accessToken").GetString()!);

        var signOut = await bearer.DeleteAsync("/api/v1/sessions/current", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.NoContent, signOut.StatusCode);
        var sessions = await ApiClient.ReadJsonAsync(await browser.GetAsync("/api/v1/sessions"), HttpStatusCode.OK);
        Assert.DoesNotContain(sessions.GetProperty("items").EnumerateArray(), s => s.GetProperty("kind").GetString() == "desktop");
    }

    [Fact]
    public async Task Signing_the_same_computer_in_again_replaces_its_old_session()
    {
        var deviceId = Guid.NewGuid();
        var (user, browser, first) = await SignedInDeviceAsync(deviceId);
        var (code, verifier) = await ApproveAsync(browser, deviceId);

        await ApiClient.ReadJsonAsync(await TradeAsync(code, verifier), HttpStatusCode.OK);

        var sessions = await ApiClient.ReadJsonAsync(await browser.GetAsync("/api/v1/sessions"), HttpStatusCode.OK);
        Assert.Single(sessions.GetProperty("items").EnumerateArray(), s => s.GetProperty("kind").GetString() == "desktop");
        Assert.Equal(HttpStatusCode.Unauthorized, (await Bearer(first.GetProperty("accessToken").GetString()!).GetAsync("/api/v1/accounts/me", TestContext.Current.CancellationToken)).StatusCode);
        _ = user;
    }

    [Fact]
    public async Task A_made_up_or_changed_access_token_is_refused()
    {
        var (_, _, tokens) = await SignedInDeviceAsync();
        var token = tokens.GetProperty("accessToken").GetString()!;

        Assert.Equal(HttpStatusCode.Unauthorized, (await Bearer("rd1.made-up").GetAsync("/api/v1/accounts/me", TestContext.Current.CancellationToken)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Bearer(token[..^2] + "xx").GetAsync("/api/v1/accounts/me", TestContext.Current.CancellationToken)).StatusCode);
    }

    [Fact]
    public async Task A_device_token_never_reaches_staff_routes_even_for_an_admin()
    {
        var admin = await TestUsers.CreateAsync(_factory.Services, Core.Identity.Roles.Admin);
        var browser = await TestUsers.SignedInClientAsync(_factory, admin);
        var (code, verifier) = await ApproveAsync(browser);
        var tokens = await ApiClient.ReadJsonAsync(await TradeAsync(code, verifier), HttpStatusCode.OK);

        var users = await Bearer(tokens.GetProperty("accessToken").GetString()!).GetAsync("/api/v1/users", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Forbidden, users.StatusCode);
    }

    [Fact]
    public async Task Disabling_a_user_ends_their_computer_sessions_at_once()
    {
        var (user, _, tokens) = await SignedInDeviceAsync();
        var admin = await TestUsers.CreateAsync(_factory.Services, Core.Identity.Roles.Admin);
        var adminClient = await TestUsers.SignedInClientAsync(_factory, admin);
        var current = await adminClient.GetAsync($"/api/v1/users/{user.Id}");

        var disabled = await adminClient.SendAsync(HttpMethod.Patch, $"/api/v1/users/{user.Id}", new { disabled = true }, ifMatch: current.Headers.ETag!.Tag);

        Assert.Equal(HttpStatusCode.OK, disabled.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Bearer(tokens.GetProperty("accessToken").GetString()!).GetAsync("/api/v1/accounts/me", TestContext.Current.CancellationToken)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await RefreshAsync(tokens.GetProperty("refreshToken").GetString()!)).StatusCode);
    }

    [Fact]
    public async Task A_new_computer_is_in_the_activity_and_gets_an_email()
    {
        var (user, browser, _) = await SignedInDeviceAsync();

        var activity = await ApiClient.ReadJsonAsync(await browser.GetAsync("/api/v1/activities"), HttpStatusCode.OK);

        Assert.Contains(activity.GetProperty("items").EnumerateArray(), a => a.GetProperty("action").GetString() == "device-sign-in");
        Assert.Contains(await TestAccounts.EmailsToAsync(_factory.Services, user.Email!), e => e.Kind == "new-sign-in");
    }
}
