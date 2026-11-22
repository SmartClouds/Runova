using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Accounts;

/// <summary>
/// The phone's demo account: tokens anyone may get, that reach the account routes only, and that
/// never leave a trace in the database.
/// </summary>
public sealed class DemoSignInTests(PostgresFixture postgres) : IAsyncLifetime
{
    private readonly FakeTimeProvider _time = new(DateTimeOffset.UtcNow);
    private readonly DatabaseWrites _writes = new();
    private string _database = null!;
    private WebsiteApiFactory _factory = null!;
    private DemoDatabase _db = null!;

    public async ValueTask InitializeAsync()
    {
        _database = await postgres.CreateDatabaseAsync();
        _factory = Factory();
        _db = new DemoDatabase(_database, _writes);
        await _db.ReadyAsync(_factory);
    }

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    private WebsiteApiFactory Factory(IReadOnlyDictionary<string, string>? settings = null) =>
        new(_database, time: _time, settings: settings, services: _writes.Register);

    private static Task<HttpResponseMessage> PostAsync(WebsiteApiFactory factory, object body, string? ip = null)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, DemoRequests.Tokens) { Content = JsonContent.Create(body) };
        if (ip is not null)
        {
            request.Headers.Add(TestApiClients.RemoteIpHeader, ip);
        }

        return factory.CreateClient().SendAsync(request, TestContext.Current.CancellationToken);
    }

    private async Task<JsonElement> DemoTokensAsync() =>
        await ApiClient.ReadJsonAsync(await PostAsync(_factory, DemoRequests.Grant()), HttpStatusCode.OK);

    [Fact]
    public async Task The_demo_grant_gives_demo_tokens_and_writes_nothing()
    {
        var tokens = await DemoTokensAsync();

        Assert.StartsWith("rdm1.", tokens.GetProperty("accessToken").GetString(), StringComparison.Ordinal);
        Assert.StartsWith("rrm1.", tokens.GetProperty("refreshToken").GetString(), StringComparison.Ordinal);
        Assert.Equal(900, tokens.GetProperty("expiresIn").GetInt32());
        Assert.Equal(-1, tokens.GetProperty("sessionId").GetInt64());
        var account = tokens.GetProperty("account");
        Assert.Equal(-1, account.GetProperty("id").GetInt64());
        Assert.Equal("Demo", account.GetProperty("displayName").GetString());
        Assert.Equal("demo@runovahq.com", account.GetProperty("email").GetString());
        Assert.False(account.GetProperty("staff").GetBoolean());

        var me = await DemoRequests.Bearer(_factory, tokens.GetProperty("accessToken").GetString()!).GetAsync("/api/v1/accounts/me", TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.OK, me.StatusCode);
        await _db.AssertUnchangedAsync();
    }

    [Theory]
    [InlineData("ios")]
    [InlineData("android")]
    public async Task Both_phone_platforms_get_the_demo(string platform)
    {
        var response = await PostAsync(_factory, DemoRequests.Grant(platform));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task The_demo_grant_is_for_the_phone_app_only()
    {
        var windows = await PostAsync(_factory, DemoRequests.Grant("windows"));
        var none = await PostAsync(_factory, new { grantType = "demo" });

        await ProblemAssert.IsAsync(windows, HttpStatusCode.BadRequest);
        await ProblemAssert.IsAsync(none, HttpStatusCode.BadRequest);
        await _db.AssertUnchangedAsync();
    }

    [Fact]
    public async Task A_demo_refresh_token_gives_a_fresh_pair_and_writes_nothing()
    {
        var first = await DemoTokensAsync();

        var refreshed = await ApiClient.ReadJsonAsync(
            await PostAsync(_factory, DemoRequests.Refresh(first.GetProperty("refreshToken").GetString()!)), HttpStatusCode.OK);

        Assert.StartsWith("rdm1.", refreshed.GetProperty("accessToken").GetString(), StringComparison.Ordinal);
        Assert.StartsWith("rrm1.", refreshed.GetProperty("refreshToken").GetString(), StringComparison.Ordinal);
        Assert.NotEqual(first.GetProperty("refreshToken").GetString(), refreshed.GetProperty("refreshToken").GetString());
        Assert.Equal(-1, refreshed.GetProperty("sessionId").GetInt64());
        Assert.Equal(-1, refreshed.GetProperty("account").GetProperty("id").GetInt64());
        var me = await DemoRequests.Bearer(_factory, refreshed.GetProperty("accessToken").GetString()!).GetAsync("/api/v1/accounts/me", TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.OK, me.StatusCode);
        await _db.AssertUnchangedAsync();
    }

    [Fact]
    public async Task An_expired_demo_token_is_refused_and_a_refresh_lasts_30_days()
    {
        var tokens = await DemoTokensAsync();
        var access = tokens.GetProperty("accessToken").GetString()!;
        var refresh = tokens.GetProperty("refreshToken").GetString()!;

        _time.Advance(TimeSpan.FromMinutes(16));
        var me = await DemoRequests.Bearer(_factory, access).GetAsync("/api/v1/accounts/me", TestContext.Current.CancellationToken);
        await ProblemAssert.IsAsync(me, HttpStatusCode.Unauthorized);
        Assert.Equal(HttpStatusCode.OK, (await PostAsync(_factory, DemoRequests.Refresh(refresh))).StatusCode);

        _time.Advance(TimeSpan.FromDays(31));
        await ProblemAssert.IsAsync(await PostAsync(_factory, DemoRequests.Refresh(refresh)), HttpStatusCode.Unauthorized);
        await _db.AssertUnchangedAsync();
    }

    [Fact]
    public async Task A_changed_demo_token_is_refused()
    {
        var tokens = await DemoTokensAsync();
        var access = tokens.GetProperty("accessToken").GetString()!;
        var refresh = tokens.GetProperty("refreshToken").GetString()!;
        static string Changed(string token) => token[..^2] + (token[^2] == 'A' ? 'B' : 'A') + token[^1];

        var me = await DemoRequests.Bearer(_factory, Changed(access)).GetAsync("/api/v1/accounts/me", TestContext.Current.CancellationToken);
        var refreshed = await PostAsync(_factory, DemoRequests.Refresh(Changed(refresh)));
        var swapped = await DemoRequests.Bearer(_factory, refresh).GetAsync("/api/v1/accounts/me", TestContext.Current.CancellationToken);

        await ProblemAssert.IsAsync(me, HttpStatusCode.Unauthorized);
        await ProblemAssert.IsAsync(refreshed, HttpStatusCode.Unauthorized);
        await ProblemAssert.IsAsync(swapped, HttpStatusCode.Unauthorized);
        await _db.AssertUnchangedAsync();
    }

    [Fact]
    public async Task With_the_demo_off_the_grant_the_refresh_and_old_tokens_are_refused()
    {
        var tokens = await DemoTokensAsync();
        using var off = Factory(new Dictionary<string, string> { ["Demo:Enabled"] = "false" });

        var grant = await PostAsync(off, DemoRequests.Grant());
        var refresh = await PostAsync(off, DemoRequests.Refresh(tokens.GetProperty("refreshToken").GetString()!));
        var me = await DemoRequests.Bearer(off, tokens.GetProperty("accessToken").GetString()!).GetAsync("/api/v1/accounts/me", TestContext.Current.CancellationToken);

        await ProblemAssert.IsAsync(grant, HttpStatusCode.Unauthorized);
        await ProblemAssert.IsAsync(refresh, HttpStatusCode.Unauthorized);
        await ProblemAssert.IsAsync(me, HttpStatusCode.Unauthorized);
        await _db.AssertUnchangedAsync();
    }

    [Theory]
    [InlineData("/hubs/remote/negotiate?negotiateVersion=1")]
    [InlineData("/hubs/notifications/negotiate?negotiateVersion=1")]
    public async Task The_hubs_refuse_a_demo_token(string path)
    {
        var access = (await DemoTokensAsync()).GetProperty("accessToken").GetString()!;

        var header = await DemoRequests.Bearer(_factory, access).PostAsync(path, null, TestContext.Current.CancellationToken);
        var query = await _factory.CreateClient().PostAsync($"{path}&access_token={Uri.EscapeDataString(access)}", null, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Unauthorized, header.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, query.StatusCode);
        await _db.AssertUnchangedAsync();
    }

    [Fact]
    public async Task A_demo_token_is_forbidden_on_a_staff_route()
    {
        var access = (await DemoTokensAsync()).GetProperty("accessToken").GetString()!;

        var response = await DemoRequests.Bearer(_factory, access).GetAsync("/api/v1/audit-entries", TestContext.Current.CancellationToken);

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Forbidden, ProblemAssert.Type("forbidden"), "/api/v1/audit-entries");
        await _db.AssertUnchangedAsync();
    }

    [Fact]
    public async Task The_demo_grant_has_the_sign_in_rate_limit()
    {
        using var limited = Factory(new Dictionary<string, string> { ["RateLimits:Auth:PermitLimit"] = "3" });

        for (var i = 0; i < 3; i++)
        {
            Assert.Equal(HttpStatusCode.OK, (await PostAsync(limited, DemoRequests.Grant(), "203.0.113.70")).StatusCode);
        }

        var over = await PostAsync(limited, DemoRequests.Grant(), "203.0.113.70");

        await ProblemAssert.IsAsync(over, HttpStatusCode.TooManyRequests, "rate-limited");
        await _db.AssertUnchangedAsync();
    }
}
