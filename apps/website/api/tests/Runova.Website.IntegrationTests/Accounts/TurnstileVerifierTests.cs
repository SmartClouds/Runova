using System.Net;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Runova.Website.Api.Accounts;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Accounts;

/// <summary>The Turnstile check against a fake siteverify. No database needed.</summary>
public sealed class TurnstileVerifierTests
{
    private readonly FakeTurnstile _turnstile = new();

    private TurnstileVerifier Verifier(string? verifyUrl = null) => new(
        new HttpClient(_turnstile.Handler()),
        Options.Create(new CaptchaOptions { VerifyUrl = verifyUrl ?? CaptchaOptions.DefaultVerifyUrl }),
        NullLogger<TurnstileVerifier>.Instance);

    private Task<bool> VerifyAsync(string? token, string action = CaptchaActions.Register, string secret = FakeTurnstile.Secret, IPAddress? ip = null) =>
        Verifier().VerifyAsync(secret, token, action, ip, TestContext.Current.CancellationToken);

    [Fact]
    public async Task A_token_the_widget_issued_for_this_form_passes()
    {
        Assert.True(await VerifyAsync(_turnstile.Issue(CaptchaActions.Register)));
    }

    [Fact]
    public async Task A_token_works_only_once()
    {
        var token = _turnstile.Issue(CaptchaActions.Register);
        await VerifyAsync(token);

        Assert.False(await VerifyAsync(token));
    }

    [Fact]
    public async Task An_unknown_token_fails()
    {
        Assert.False(await VerifyAsync("made-up"));
    }

    [Fact]
    public async Task A_token_from_another_form_fails()
    {
        Assert.False(await VerifyAsync(_turnstile.Issue(CaptchaActions.SignIn), CaptchaActions.Register));
    }

    [Fact]
    public async Task A_token_checked_with_another_secret_fails()
    {
        Assert.False(await VerifyAsync(_turnstile.Issue(CaptchaActions.Register), secret: "0x4AAAAAAAothersecret"));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public async Task No_token_fails_without_asking_cloudflare(string? token)
    {
        Assert.False(await VerifyAsync(token));
        Assert.Empty(_turnstile.Checks);
    }

    [Fact]
    public async Task A_token_longer_than_cloudflare_allows_fails_without_asking()
    {
        Assert.False(await VerifyAsync(new string('a', 2049)));
        Assert.Empty(_turnstile.Checks);
    }

    [Theory]
    [InlineData(HttpStatusCode.InternalServerError)]
    [InlineData(HttpStatusCode.ServiceUnavailable)]
    public async Task An_error_from_cloudflare_fails_closed(HttpStatusCode status)
    {
        var token = _turnstile.Issue(CaptchaActions.Register);
        _turnstile.Failing = status;

        Assert.False(await VerifyAsync(token));
    }

    [Fact]
    public async Task Cloudflare_out_of_reach_fails_closed()
    {
        var token = _turnstile.Issue(CaptchaActions.Register);
        _turnstile.Unreachable = true;

        Assert.False(await VerifyAsync(token));
    }

    [Fact]
    public async Task The_check_sends_the_secret_the_token_and_the_callers_address()
    {
        var token = _turnstile.Issue(CaptchaActions.Register);

        await VerifyAsync(token, ip: IPAddress.Parse("203.0.113.7"));

        var check = Assert.Single(_turnstile.Checks);
        Assert.Equal(FakeTurnstile.Secret, check["secret"]);
        Assert.Equal(token, check["response"]);
        Assert.Equal("203.0.113.7", check["remoteip"]);
    }

    [Fact]
    public async Task Without_an_address_none_is_sent()
    {
        await VerifyAsync(_turnstile.Issue(CaptchaActions.Register));

        Assert.False(Assert.Single(_turnstile.Checks).ContainsKey("remoteip"));
    }
}
