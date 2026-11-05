using System.Net;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Runova.Website.Api.Identity;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Identity;

public sealed class AuthorizationTests(PostgresFixture postgres) : IDisposable
{
    private readonly WebsiteApiFactory _factory = new(postgres.ConnectionString);

    public void Dispose() => _factory.Dispose();

    [Fact]
    public async Task Every_endpoint_not_marked_anonymous_answers_401_without_a_cookie()
    {
        var protectedEndpoints = _factory.Services.GetRequiredService<EndpointDataSource>().Endpoints
            .OfType<RouteEndpoint>()
            .Where(e => e.Metadata.GetMetadata<IAllowAnonymous>() is null)
            .SelectMany(e => (e.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods ?? ["GET"])
                .Select(method => (Method: method, Path: SamplePath(e))))
            .ToList();
        Assert.Contains(("GET", "/api/v1/users/me"), protectedEndpoints);
        Assert.Contains(("DELETE", "/api/v1/sessions/current"), protectedEndpoints);
        Assert.Contains(("PUT", "/api/v1/users/me/password"), protectedEndpoints);
        Assert.Contains(("DELETE", "/api/v1/users/me/two-factor"), protectedEndpoints);
        Assert.Contains(("POST", "/api/v1/users/me/two-factor/recovery-codes"), protectedEndpoints);
        Assert.Contains(("GET", "/api/v1/audit-entries"), protectedEndpoints);
        Assert.Contains(("GET", "/api/v1/media"), protectedEndpoints);
        Assert.Contains(("DELETE", "/api/v1/media/1"), protectedEndpoints);
        var client = _factory.CreateApiClient();

        foreach (var (method, path) in protectedEndpoints)
        {
            var response = await client.SendAsync(new HttpMethod(method), path, antiforgeryToken: "");

            await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Unauthorized, ProblemAssert.Type("unauthorized"), path);
            Assert.Null(response.Headers.Location);
        }
    }

    [Fact]
    public void Every_write_needs_credentials_except_sign_in_sign_up_and_email_links_which_need_antiforgery()
    {
        string[] safe = ["GET", "HEAD", "OPTIONS"];
        var anonymousWrites = _factory.Services.GetRequiredService<EndpointDataSource>().Endpoints
            .OfType<RouteEndpoint>()
            .Where(e => e.Metadata.GetMetadata<IAllowAnonymous>() is not null)
            .SelectMany(e => (e.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods ?? ["*"])
                .Where(method => !safe.Contains(method))
                .Select(method => (Method: method, Path: e.RoutePattern.RawText, Antiforgery: e.Metadata.GetMetadata<RequiresAntiforgery>() is not null)))
            .OrderBy(w => w.Path, StringComparer.Ordinal)
            .ToList();

        Assert.Equal(
            [
                ("POST", "/api/v1/accounts", true),
                ("POST", "/api/v1/email-verifications", true),
                ("POST", "/api/v1/password-resets", true),
                ("POST", "/api/v1/password-setups", true),
                ("POST", "/api/v1/sessions", true),
                ("POST", "/api/v1/verification-emails", true),
            ],
            anonymousWrites);
    }

    [Theory]
    [InlineData("/api/v1/csrf-tokens/current")]
    [InlineData("/health/live")]
    [InlineData("/health/ready")]
    [InlineData("/openapi/v1.json")]
    public async Task Anonymous_endpoints_answer_without_a_cookie(string path)
    {
        var response = await _factory.CreateApiClient().GetAsync(path);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Theory]
    [InlineData("DELETE", "/api/v1/sessions/current")]
    [InlineData("POST", "/api/v1/users/me/two-factor")]
    [InlineData("PUT", "/api/v1/users/me/password")]
    [InlineData("DELETE", "/api/v1/users/me/two-factor")]
    [InlineData("POST", "/api/v1/users/me/two-factor/recovery-codes")]
    [InlineData("DELETE", "/api/v1/media/1")]
    public async Task An_unsafe_request_with_the_cookie_but_no_antiforgery_token_answers_400(string method, string path)
    {
        var client = await SignedInClientAsync();

        var response = await client.SendAsync(new HttpMethod(method), path, antiforgeryToken: "");

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), path);
        Assert.True(problem.GetProperty("errors").TryGetProperty("antiforgery", out _));
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/v1/users/me")).StatusCode);
    }

    [Fact]
    public async Task An_antiforgery_token_from_another_session_answers_400()
    {
        var client = await SignedInClientAsync();
        var otherToken = await (await SignedInClientAsync()).RefreshAntiforgeryTokenAsync();

        var response = await client.SendAsync(HttpMethod.Delete, "/api/v1/sessions/current", antiforgeryToken: otherToken);

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), "/api/v1/sessions/current");
    }

    [Fact]
    public async Task A_safe_request_needs_no_antiforgery_token()
    {
        var client = await SignedInClientAsync();

        var response = await client.SendAsync(HttpMethod.Get, "/api/v1/users/me", antiforgeryToken: "");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    private async Task<ApiClient> SignedInClientAsync()
    {
        var user = await TestUsers.CreateAsync(_factory.Services);
        var client = _factory.CreateApiClient();
        Assert.Equal(HttpStatusCode.NoContent, (await client.SignInAsync(user.Email!, TestUsers.Password)).StatusCode);
        return client;
    }

    // Every route parameter becomes 1, which fits {id:long} and any slug.
    private static string SamplePath(RouteEndpoint endpoint) =>
        "/" + string.Join('/', endpoint.RoutePattern.PathSegments.Select(segment => string.Concat(segment.Parts.Select(part => part switch
        {
            Microsoft.AspNetCore.Routing.Patterns.RoutePatternLiteralPart literal => literal.Content,
            Microsoft.AspNetCore.Routing.Patterns.RoutePatternSeparatorPart separator => separator.Content,
            _ => "1",
        }))));
}
