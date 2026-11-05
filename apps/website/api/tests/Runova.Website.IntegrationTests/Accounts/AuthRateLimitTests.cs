using System.Net;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Accounts;

/// <summary>The per-address limit on sign-in, registration and the email links (the contract's 10 a minute).</summary>
public sealed class AuthRateLimitTests(PostgresFixture postgres) : IDisposable
{
    private readonly WebsiteApiFactory _factory = new(
        postgres.ConnectionString,
        settings: new Dictionary<string, string> { ["RateLimits:Auth:PermitLimit"] = "3" });

    public void Dispose() => _factory.Dispose();

    private static Dictionary<string, string> From(string ip) => new() { [TestApiClients.RemoteIpHeader] = ip };

    [Fact]
    public async Task Sign_in_attempts_over_the_limit_answer_429_with_retry_after()
    {
        var client = _factory.CreateApiClient();
        await client.RefreshAntiforgeryTokenAsync();
        var body = new { email = "nobody@example.test", password = "wrong password here", twoFactorCode = (string?)null, recoveryCode = (string?)null };

        for (var i = 0; i < 3; i++)
        {
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.SendAsync(HttpMethod.Post, "/api/v1/sessions", body, headers: From("203.0.113.7"))).StatusCode);
        }

        var limited = await client.SendAsync(HttpMethod.Post, "/api/v1/sessions", body, headers: From("203.0.113.7"));

        await ProblemAssert.IsProblemAsync(limited, HttpStatusCode.TooManyRequests, ProblemAssert.Type("rate-limited"), "/api/v1/sessions");
        Assert.NotNull(limited.Headers.RetryAfter);
    }

    [Fact]
    public async Task Another_address_has_its_own_limit()
    {
        var client = _factory.CreateApiClient();
        await client.RefreshAntiforgeryTokenAsync();
        var body = new { email = "nobody@example.test" };

        for (var i = 0; i < 4; i++)
        {
            await client.SendAsync(HttpMethod.Post, "/api/v1/password-resets", body, headers: From("203.0.113.8"));
        }

        var other = await client.SendAsync(HttpMethod.Post, "/api/v1/password-resets", body, headers: From("203.0.113.9"));

        Assert.Equal(HttpStatusCode.Accepted, other.StatusCode);
    }

    [Theory]
    [InlineData("/api/v1/accounts")]
    [InlineData("/api/v1/password-resets")]
    [InlineData("/api/v1/verification-emails")]
    [InlineData("/api/v1/email-verifications")]
    public async Task Each_email_route_is_limited(string path)
    {
        var client = _factory.CreateApiClient();
        await client.RefreshAntiforgeryTokenAsync();

        HttpResponseMessage last = null!;
        for (var i = 0; i < 4; i++)
        {
            last = await client.SendAsync(HttpMethod.Post, path, new { }, headers: From("198.51.100.4"));
        }

        Assert.Equal(HttpStatusCode.TooManyRequests, last.StatusCode);
    }
}
