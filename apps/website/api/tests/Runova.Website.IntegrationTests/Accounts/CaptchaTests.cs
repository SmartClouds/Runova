using System.Net;
using Runova.Website.Api.Accounts;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Accounts;

/// <summary>The Turnstile captcha on the anonymous account forms, once an Admin turned it on (E52).</summary>
public sealed class CaptchaTests(PostgresFixture postgres) : IAsyncLifetime
{
    private readonly FakeTurnstile _turnstile = new();
    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync() =>
        _factory = new(await postgres.CreateDatabaseAsync(), services: _turnstile.Register);

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    public static TheoryData<string, string> Forms => new()
    {
        { "/api/v1/accounts", CaptchaActions.Register },
        { "/api/v1/sessions", CaptchaActions.SignIn },
        { "/api/v1/password-resets", CaptchaActions.PasswordReset },
        { "/api/v1/verification-emails", CaptchaActions.VerificationEmail },
    };

    private static object Body(string path, string email, string? captchaToken) => path switch
    {
        "/api/v1/accounts" => new { email, password = TestAccounts.Password, displayName = "Sam", captchaToken },
        "/api/v1/sessions" => new { email, password = TestAccounts.Password, captchaToken },
        _ => new { email, captchaToken },
    };

    private static HttpStatusCode Answer(string path) => path == "/api/v1/sessions" ? HttpStatusCode.NoContent : HttpStatusCode.Accepted;

    /// <summary>The Admin who turned it on stays signed in, since signing in now needs a token too.</summary>
    private ApiClient _admin = null!;

    private async Task<(ApiClient Client, string Email)> CaptchaOnAsync()
    {
        var account = await TestAccounts.CreateAsync(_factory.Services);
        _admin = await TestSignInSettings.AdminAsync(_factory);
        await TestSignInSettings.TurnOnCaptchaAsync(_admin, _turnstile);
        var client = _factory.CreateApiClient();
        await client.RefreshAntiforgeryTokenAsync();
        return (client, account.Email!);
    }

    private static async Task AssertCaptchaRefusedAsync(HttpResponseMessage response, string path)
    {
        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), path);
        Assert.Equal(["captchaToken"], problem.GetProperty("errors").EnumerateObject().Select(p => p.Name));
    }

    [Theory]
    [MemberData(nameof(Forms))]
    public async Task With_the_captcha_off_no_token_is_needed(string path, string action)
    {
        _ = action;
        var account = await TestAccounts.CreateAsync(_factory.Services);
        var client = _factory.CreateApiClient();
        await client.RefreshAntiforgeryTokenAsync();

        var response = await client.SendAsync(HttpMethod.Post, path, Body(path, account.Email!, captchaToken: null));

        Assert.Equal(Answer(path), response.StatusCode);
    }

    [Theory]
    [MemberData(nameof(Forms))]
    public async Task With_the_captcha_on_a_form_without_a_token_is_refused(string path, string action)
    {
        _ = action;
        var (client, email) = await CaptchaOnAsync();

        await AssertCaptchaRefusedAsync(await client.SendAsync(HttpMethod.Post, path, Body(path, email, captchaToken: null)), path);
    }

    [Theory]
    [MemberData(nameof(Forms))]
    public async Task A_token_the_widget_issued_for_the_form_passes(string path, string action)
    {
        var (client, email) = await CaptchaOnAsync();

        var response = await client.SendAsync(HttpMethod.Post, path, Body(path, email, _turnstile.Issue(action)));

        Assert.Equal(Answer(path), response.StatusCode);
    }

    [Theory]
    [MemberData(nameof(Forms))]
    public async Task A_token_for_another_form_is_refused(string path, string action)
    {
        var (client, email) = await CaptchaOnAsync();
        var other = action == CaptchaActions.Register ? CaptchaActions.SignIn : CaptchaActions.Register;

        await AssertCaptchaRefusedAsync(await client.SendAsync(HttpMethod.Post, path, Body(path, email, _turnstile.Issue(other))), path);
    }

    [Fact]
    public async Task A_token_works_once()
    {
        var (client, email) = await CaptchaOnAsync();
        var token = _turnstile.Issue(CaptchaActions.PasswordReset);
        await client.SendAsync(HttpMethod.Post, "/api/v1/password-resets", Body("/api/v1/password-resets", email, token));

        var again = await client.SendAsync(HttpMethod.Post, "/api/v1/password-resets", Body("/api/v1/password-resets", email, token));

        await AssertCaptchaRefusedAsync(again, "/api/v1/password-resets");
    }

    [Fact]
    public async Task Without_a_token_a_wrong_password_says_nothing_about_the_password()
    {
        var (client, email) = await CaptchaOnAsync();

        var response = await client.SendAsync(HttpMethod.Post, "/api/v1/sessions", new { email, password = "not the right password" });

        await AssertCaptchaRefusedAsync(response, "/api/v1/sessions");
    }

    [Fact]
    public async Task The_two_factor_step_of_a_sign_in_needs_a_token_too()
    {
        var (client, email) = await CaptchaOnAsync();

        var response = await client.SendAsync(HttpMethod.Post, "/api/v1/sessions", new { email, password = TestAccounts.Password, twoFactorCode = "123456" });

        await AssertCaptchaRefusedAsync(response, "/api/v1/sessions");
    }

    [Fact]
    public async Task Cloudflare_out_of_reach_refuses_the_form()
    {
        var (client, email) = await CaptchaOnAsync();
        var token = _turnstile.Issue(CaptchaActions.Register);
        _turnstile.Unreachable = true;

        var response = await client.SendAsync(HttpMethod.Post, "/api/v1/accounts", Body("/api/v1/accounts", TestAccounts.NewEmail(), token));

        await AssertCaptchaRefusedAsync(response, "/api/v1/accounts");
        Assert.NotEmpty(email);
    }

    [Fact]
    public async Task Turned_off_again_the_forms_need_no_token()
    {
        var (client, email) = await CaptchaOnAsync();
        await TestSignInSettings.PatchAsync(_admin, new { captchaEnabled = false });

        var response = await client.SendAsync(HttpMethod.Post, "/api/v1/password-resets", Body("/api/v1/password-resets", email, captchaToken: null));

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
    }
}
