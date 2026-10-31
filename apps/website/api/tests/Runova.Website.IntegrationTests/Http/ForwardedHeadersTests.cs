using System.Net;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.IntegrationTests.Infrastructure;
using Runova.Website.IntegrationTests.News;

namespace Runova.Website.IntegrationTests.Http;

/// <summary>
/// Behind the reverse proxy the API is reached over plain HTTP from the proxy's address, so it
/// takes the caller's address and scheme from <c>X-Forwarded-For</c> and <c>X-Forwarded-Proto</c>,
/// but only when the request comes from a network in <c>Website:KnownProxies</c>.
/// </summary>
public sealed class ForwardedHeadersTests(PostgresFixture postgres) : IAsyncLifetime
{
    private const string Proxy = "172.20.0.5";
    private const string Stranger = "198.51.100.7";
    private const string Visitor = "203.0.113.9";

    private readonly FakeTimeProvider _time = new(TestApiClients.Now);
    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync() =>
        _factory = new(
            await postgres.CreateDatabaseAsync(),
            time: _time,
            settings: new Dictionary<string, string> { ["Website:KnownProxies"] = "10.0.0.0/8, 172.16.0.0/12" });

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    [Theory]
    [InlineData(Proxy, HttpStatusCode.Created)]
    [InlineData(Stranger, HttpStatusCode.Unauthorized)]
    public async Task The_allowlist_sees_the_forwarded_address_only_from_a_known_proxy(string from, HttpStatusCode expected)
    {
        var (keyId, secret) = await TestApiClients.AddAsync(_factory.Services, ipAllowlist: [Visitor + "/32"]);
        using var request = TestApiClients.Signed(keyId, secret, HttpMethod.Post, "/api/v1/news", NewsWriteTests.Body("forwarded-from-" + from.Replace('.', '-')).ToJsonString());
        request.Headers.TryAddWithoutValidation(TestApiClients.RemoteIpHeader, from);
        request.Headers.TryAddWithoutValidation("X-Forwarded-For", Visitor);

        var response = await TestApiClients.Raw(_factory).SendAsync(request, TestContext.Current.CancellationToken);

        Assert.Equal(expected, response.StatusCode);
    }

    [Theory]
    [InlineData(Proxy, HttpStatusCode.OK)]
    [InlineData(Stranger, HttpStatusCode.InternalServerError)]
    public async Task The_secure_antiforgery_cookie_works_over_http_only_from_a_known_proxy(string from, HttpStatusCode expected)
    {
        var http = _factory.CreateClient(new() { BaseAddress = new Uri("http://localhost"), AllowAutoRedirect = false });
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/v1/csrf-tokens/current");
        request.Headers.TryAddWithoutValidation(TestApiClients.RemoteIpHeader, from);
        request.Headers.TryAddWithoutValidation("X-Forwarded-For", Visitor);
        request.Headers.TryAddWithoutValidation("X-Forwarded-Proto", "https");

        var response = await http.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.Equal(expected, response.StatusCode);
    }
}
