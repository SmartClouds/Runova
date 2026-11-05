using System.Net;
using System.Text.Json;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Accounts;

public sealed class AccountSessionsTests(PostgresFixture postgres) : IDisposable
{
    private const string Sessions = "/api/v1/sessions";

    private readonly WebsiteApiFactory _factory = new(postgres.ConnectionString);

    public void Dispose() => _factory.Dispose();

    private static async Task<JsonElement[]> ListAsync(ApiClient client)
    {
        var body = await ApiClient.ReadJsonAsync(await client.GetAsync(Sessions), HttpStatusCode.OK);
        return [.. body.GetProperty("items").EnumerateArray()];
    }

    [Fact]
    public async Task Signing_in_starts_a_session_that_is_listed_as_this_one()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var client = await TestAccounts.SignedInClientAsync(_factory, user);

        var session = Assert.Single(await ListAsync(client));

        Assert.True(session.GetProperty("current").GetBoolean());
        Assert.Equal("web", session.GetProperty("kind").GetString());
        Assert.Equal(JsonValueKind.String, session.GetProperty("createdAt").ValueKind);
        Assert.Equal(JsonValueKind.String, session.GetProperty("lastSeenAt").ValueKind);
        Assert.True(session.TryGetProperty("ip", out _));
        Assert.True(session.TryGetProperty("deviceName", out _));
    }

    [Fact]
    public async Task Ending_another_session_signs_it_out_at_its_next_request()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var laptop = await TestAccounts.SignedInClientAsync(_factory, user);
        var phone = await TestAccounts.SignedInClientAsync(_factory, user);
        var other = (await ListAsync(laptop)).Single(s => !s.GetProperty("current").GetBoolean());

        var response = await laptop.SendAsync(HttpMethod.Delete, $"{Sessions}/{other.GetProperty("id").GetInt64()}");

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await phone.GetAsync("/api/v1/accounts/me")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await laptop.GetAsync("/api/v1/accounts/me")).StatusCode);
        Assert.Single(await ListAsync(laptop));
    }

    [Fact]
    public async Task Someone_else_s_session_is_not_found()
    {
        var sam = await TestAccounts.CreateAsync(_factory.Services);
        var kim = await TestAccounts.CreateAsync(_factory.Services);
        var samClient = await TestAccounts.SignedInClientAsync(_factory, sam);
        var kimClient = await TestAccounts.SignedInClientAsync(_factory, kim);
        var kimSession = Assert.Single(await ListAsync(kimClient)).GetProperty("id").GetInt64();

        var response = await samClient.SendAsync(HttpMethod.Delete, $"{Sessions}/{kimSession}");

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.NotFound, ProblemAssert.Type("not-found"), $"{Sessions}/{kimSession}");
        Assert.Equal(HttpStatusCode.OK, (await kimClient.GetAsync("/api/v1/accounts/me")).StatusCode);
    }

    [Fact]
    public async Task Ending_every_other_session_needs_the_password_and_keeps_this_one()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var laptop = await TestAccounts.SignedInClientAsync(_factory, user);
        var phone = await TestAccounts.SignedInClientAsync(_factory, user);
        var tablet = await TestAccounts.SignedInClientAsync(_factory, user);

        var wrong = await laptop.SendAsync(HttpMethod.Delete, Sessions, new { password = "not the password", code = (string?)null });
        var right = await laptop.SendAsync(HttpMethod.Delete, Sessions, new { password = TestAccounts.Password, code = (string?)null });

        Assert.Equal(HttpStatusCode.BadRequest, wrong.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, right.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await phone.GetAsync("/api/v1/accounts/me")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await tablet.GetAsync("/api/v1/accounts/me")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await laptop.GetAsync("/api/v1/accounts/me")).StatusCode);
    }

    [Fact]
    public async Task The_same_account_signing_in_from_many_places_at_once_gets_a_session_each()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);

        var clients = await Task.WhenAll(Enumerable.Range(0, 8).Select(async _ =>
        {
            var client = _factory.CreateApiClient();
            var response = await client.SignInAsync(user.Email!, TestAccounts.Password);
            Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
            return client;
        }));

        Assert.Equal(8, (await ListAsync(clients[0])).Length);
    }

    [Fact]
    public async Task Signing_out_ends_the_session_for_good()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var client = await TestAccounts.SignedInClientAsync(_factory, user);
        var watcher = await TestAccounts.SignedInClientAsync(_factory, user);

        await client.SendAsync(HttpMethod.Delete, "/api/v1/sessions/current");

        Assert.Single(await ListAsync(watcher));
    }

    [Fact]
    public async Task Changing_the_password_keeps_this_session_and_ends_the_others()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var laptop = await TestAccounts.SignedInClientAsync(_factory, user);
        var phone = await TestAccounts.SignedInClientAsync(_factory, user);

        var changed = await laptop.SendAsync(HttpMethod.Put, "/api/v1/users/me/password", new { currentPassword = TestAccounts.Password, newPassword = "a fresh long password" });

        Assert.Equal(HttpStatusCode.NoContent, changed.StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await laptop.GetAsync("/api/v1/accounts/me")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await phone.GetAsync("/api/v1/accounts/me")).StatusCode);
    }

    [Fact]
    public async Task A_new_browser_gets_a_new_sign_in_email_and_the_same_one_again_does_not()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var first = new Dictionary<string, string> { [TestApiClients.RemoteIpHeader] = "203.0.113.19", ["User-Agent"] = "Mozilla/5.0 (Macintosh) Safari/605.1.15" };
        var headers = new Dictionary<string, string> { [TestApiClients.RemoteIpHeader] = "203.0.113.20", ["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0) Firefox/140.0" };

        // The very first session is the person signing up, so it sends nothing.
        await SignInWithAsync(user, first);
        Assert.Empty(await TestAccounts.EmailsToAsync(_factory.Services, user.Email!));

        await SignInWithAsync(user, headers);
        await SignInWithAsync(user, headers);

        var emails = await TestAccounts.EmailsToAsync(_factory.Services, user.Email!);
        Assert.Single(emails, e => e.Kind == "new-sign-in");
    }

    private async Task SignInWithAsync(Data.Identity.AppUser user, Dictionary<string, string> headers)
    {
        var client = _factory.CreateApiClient();
        await client.RefreshAntiforgeryTokenAsync();
        var response = await client.SendAsync(
            HttpMethod.Post,
            Sessions,
            new { email = user.Email, password = TestAccounts.Password, twoFactorCode = (string?)null, recoveryCode = (string?)null },
            headers: headers);
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
    }
}
