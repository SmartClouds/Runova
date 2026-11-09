using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Accounts;

/// <summary>Signing the app in by scanning a QR code that a signed-in browser or desktop app shows.</summary>
public sealed class QrSignInTests : IAsyncLifetime
{
    private const string Codes = "/api/v1/qr-sign-ins";
    private const string Claims = "/api/v1/qr-sign-in-claims";
    private const string Polls = "/api/v1/qr-sign-in-polls";
    private const string PhoneRedirect = "com.runovahq.app:/auth/callback";

    private readonly PostgresFixture _postgres;
    private readonly FakeTimeProvider _time = new(DateTimeOffset.UtcNow);
    private WebsiteApiFactory _factory = null!;

    public QrSignInTests(PostgresFixture postgres) => _postgres = postgres;

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

    private async Task<ApiClient> BrowserAsync() =>
        await TestAccounts.SignedInClientAsync(_factory, await TestAccounts.CreateAsync(_factory.Services));

    private static async Task<(long Id, string Code)> ShowAsync(ApiClient browser)
    {
        var body = await ApiClient.ReadJsonAsync(await browser.SendAsync(HttpMethod.Post, Codes, new { }), HttpStatusCode.Created);
        var text = body.GetProperty("qrText").GetString()!;
        Assert.StartsWith("rq1.", text, StringComparison.Ordinal);
        return (body.GetProperty("id").GetInt64(), text["rq1.".Length..]);
    }

    private Task<HttpResponseMessage> ClaimAsync(string code, string challenge, string platform = "android") =>
        _factory.CreateClient().PostAsJsonAsync(
            Claims,
            new { code, codeChallenge = challenge, codeChallengeMethod = "S256", platform, appVersion = "3.4.0", deviceId = Guid.NewGuid() },
            TestContext.Current.CancellationToken);

    private Task<HttpResponseMessage> PollAsync(string code, string verifier) =>
        _factory.CreateClient().PostAsJsonAsync(Polls, new { code, codeVerifier = verifier }, TestContext.Current.CancellationToken);

    private static Task<HttpResponseMessage> DecideAsync(ApiClient browser, long id, bool approve) =>
        browser.SendAsync(HttpMethod.Post, $"{Codes}/{id}/decisions", new { approve });

    private static async Task<JsonElement> StatusAsync(ApiClient browser, long id) =>
        await ApiClient.ReadJsonAsync(await browser.GetAsync($"{Codes}/{id}"), HttpStatusCode.OK);

    [Fact]
    public async Task A_scanned_and_approved_code_signs_the_app_in()
    {
        var browser = await BrowserAsync();
        var (id, code) = await ShowAsync(browser);
        Assert.Equal("waiting", (await StatusAsync(browser, id)).GetProperty("status").GetString());

        var (verifier, challenge) = Pkce();
        var claim = await ApiClient.ReadJsonAsync(await ClaimAsync(code, challenge), HttpStatusCode.OK);
        var matchCode = claim.GetProperty("matchCode").GetString()!;
        Assert.Matches("^[0-9]{4}$", matchCode);

        var seen = await StatusAsync(browser, id);
        Assert.Equal("scanned", seen.GetProperty("status").GetString());
        Assert.Equal(matchCode, seen.GetProperty("matchCode").GetString());

        var waiting = await ApiClient.ReadJsonAsync(await PollAsync(code, verifier), HttpStatusCode.OK);
        Assert.Equal("waiting", waiting.GetProperty("status").GetString());
        Assert.Equal(JsonValueKind.Null, waiting.GetProperty("code").ValueKind);

        Assert.Equal(HttpStatusCode.NoContent, (await DecideAsync(browser, id, approve: true)).StatusCode);
        var approved = await ApiClient.ReadJsonAsync(await PollAsync(code, verifier), HttpStatusCode.OK);
        Assert.Equal("approved", approved.GetProperty("status").GetString());

        var tokens = await ApiClient.ReadJsonAsync(
            await _factory.CreateClient().PostAsJsonAsync(
                "/api/v1/device-tokens",
                new { grantType = "authorization_code", code = approved.GetProperty("code").GetString(), codeVerifier = verifier, redirectUri = PhoneRedirect },
                TestContext.Current.CancellationToken),
            HttpStatusCode.OK);
        Assert.StartsWith("rd1.", tokens.GetProperty("accessToken").GetString(), StringComparison.Ordinal);

        var sessions = await ApiClient.ReadJsonAsync(await browser.GetAsync("/api/v1/sessions"), HttpStatusCode.OK);
        var phone = sessions.GetProperty("items").EnumerateArray().Single(s => s.GetProperty("kind").GetString() == "mobile");
        Assert.Equal("Runova app", phone.GetProperty("deviceName").GetString());
        Assert.Equal("approved", (await StatusAsync(browser, id)).GetProperty("status").GetString());
    }

    [Fact]
    public async Task A_second_scanner_is_refused()
    {
        var (_, code) = await ShowAsync(await BrowserAsync());
        Assert.Equal(HttpStatusCode.OK, (await ClaimAsync(code, Pkce().Challenge)).StatusCode);

        Assert.Equal(HttpStatusCode.Unauthorized, (await ClaimAsync(code, Pkce().Challenge)).StatusCode);
    }

    [Fact]
    public async Task A_poll_without_the_scanners_verifier_is_refused()
    {
        var browser = await BrowserAsync();
        var (id, code) = await ShowAsync(browser);
        await ClaimAsync(code, Pkce().Challenge);
        await DecideAsync(browser, id, approve: true);

        Assert.Equal(HttpStatusCode.Unauthorized, (await PollAsync(code, Pkce().Verifier)).StatusCode);
    }

    [Fact]
    public async Task The_sign_in_code_is_handed_over_once()
    {
        var browser = await BrowserAsync();
        var (id, code) = await ShowAsync(browser);
        var (verifier, challenge) = Pkce();
        await ClaimAsync(code, challenge);
        await DecideAsync(browser, id, approve: true);

        Assert.Equal(HttpStatusCode.OK, (await PollAsync(code, verifier)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await PollAsync(code, verifier)).StatusCode);
    }

    [Fact]
    public async Task A_declined_scan_tells_the_app_and_gets_no_code()
    {
        var browser = await BrowserAsync();
        var (id, code) = await ShowAsync(browser);
        var (verifier, challenge) = Pkce();
        await ClaimAsync(code, challenge);

        Assert.Equal(HttpStatusCode.NoContent, (await DecideAsync(browser, id, approve: false)).StatusCode);

        var poll = await ApiClient.ReadJsonAsync(await PollAsync(code, verifier), HttpStatusCode.OK);
        Assert.Equal("declined", poll.GetProperty("status").GetString());
        Assert.Equal(JsonValueKind.Null, poll.GetProperty("code").ValueKind);
        Assert.Equal("declined", (await StatusAsync(browser, id)).GetProperty("status").GetString());
    }

    [Fact]
    public async Task A_code_nobody_scanned_can_not_be_approved()
    {
        var browser = await BrowserAsync();
        var (id, _) = await ShowAsync(browser);

        Assert.Equal(HttpStatusCode.Conflict, (await DecideAsync(browser, id, approve: true)).StatusCode);
    }

    [Fact]
    public async Task A_closed_code_can_not_be_scanned()
    {
        var browser = await BrowserAsync();
        var (id, code) = await ShowAsync(browser);
        Assert.Equal(HttpStatusCode.NoContent, (await DecideAsync(browser, id, approve: false)).StatusCode);

        Assert.Equal(HttpStatusCode.Unauthorized, (await ClaimAsync(code, Pkce().Challenge)).StatusCode);
    }

    [Fact]
    public async Task An_old_code_expires()
    {
        var browser = await BrowserAsync();
        var (id, code) = await ShowAsync(browser);

        _time.Advance(TimeSpan.FromMinutes(2) + TimeSpan.FromSeconds(1));

        Assert.Equal("expired", (await StatusAsync(browser, id)).GetProperty("status").GetString());
        Assert.Equal(HttpStatusCode.Unauthorized, (await ClaimAsync(code, Pkce().Challenge)).StatusCode);
    }

    [Fact]
    public async Task A_new_code_retires_one_nobody_scanned()
    {
        var browser = await BrowserAsync();
        var (id, code) = await ShowAsync(browser);

        await ShowAsync(browser);

        Assert.Equal(HttpStatusCode.NotFound, (await browser.GetAsync($"{Codes}/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await ClaimAsync(code, Pkce().Challenge)).StatusCode);
    }

    [Fact]
    public async Task Someone_elses_code_is_not_found()
    {
        var (id, _) = await ShowAsync(await BrowserAsync());
        var other = await BrowserAsync();

        Assert.Equal(HttpStatusCode.NotFound, (await other.GetAsync($"{Codes}/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await DecideAsync(other, id, approve: true)).StatusCode);
    }

    [Fact]
    public async Task A_signed_out_caller_can_not_ask_for_a_code()
    {
        var response = await _factory.CreateClient().PostAsJsonAsync(Codes, new { }, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Theory]
    [InlineData("windows")]
    [InlineData("nothing")]
    public async Task Only_the_phone_platforms_can_claim(string platform)
    {
        var (_, code) = await ShowAsync(await BrowserAsync());

        Assert.Equal(HttpStatusCode.BadRequest, (await ClaimAsync(code, Pkce().Challenge, platform)).StatusCode);
    }
}
