using System.Net;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Accounts;

/// <summary>An account is not staff: it reaches its own resources and nothing an Editor or Admin can.</summary>
public sealed class AccountPolicyTests(PostgresFixture postgres) : IDisposable
{
    private readonly WebsiteApiFactory _factory = new(postgres.ConnectionString);

    public void Dispose() => _factory.Dispose();

    [Theory]
    [InlineData("GET", "/api/v1/users")]
    [InlineData("GET", "/api/v1/audit-entries")]
    [InlineData("GET", "/api/v1/api-clients")]
    [InlineData("GET", "/api/v1/media")]
    [InlineData("POST", "/api/v1/news")]
    [InlineData("POST", "/api/v1/posts")]
    public async Task An_account_gets_403_on_staff_routes(string method, string path)
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var client = await TestAccounts.SignedInClientAsync(_factory, user);

        var response = await client.SendAsync(new HttpMethod(method), path, method == "GET" ? null : new { });

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Theory]
    [InlineData("/api/v1/users/me")]
    [InlineData("/api/v1/users/me/two-factor")]
    [InlineData("/api/v1/accounts/me")]
    public async Task An_account_reaches_its_own_resources(string path)
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var client = await TestAccounts.SignedInClientAsync(_factory, user);

        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync(path)).StatusCode);
    }

    [Fact]
    public async Task An_account_can_sign_out()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var client = await TestAccounts.SignedInClientAsync(_factory, user);

        var response = await client.SendAsync(HttpMethod.Delete, "/api/v1/sessions/current");

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/v1/accounts/me")).StatusCode);
    }

    [Fact]
    public async Task Signed_out_gets_401_on_account_routes()
    {
        Assert.Equal(HttpStatusCode.Unauthorized, (await _factory.CreateApiClient().GetAsync("/api/v1/accounts/me")).StatusCode);
    }
}
