using System.Net;
using System.Text.Json;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Accounts;

public sealed class GoogleSignInTests : IDisposable
{
    private readonly FakeGoogle _google = new();
    private readonly WebsiteApiFactory _factory;
    private readonly string _connection;

    public GoogleSignInTests(PostgresFixture postgres)
    {
        _connection = postgres.ConnectionString;
        _google.Email = TestAccounts.NewEmail();
        _google.Subject = Guid.NewGuid().ToString("N");
        _factory = new WebsiteApiFactory(postgres.ConnectionString, settings: FakeGoogle.Settings, services: _google.Register);
    }

    public void Dispose() => _factory.Dispose();

    [Fact]
    public async Task The_providers_list_names_google_when_it_is_set_up()
    {
        var body = await ApiClient.ReadJsonAsync(await _factory.CreateApiClient().GetAsync("/api/v1/sign-in-providers"), HttpStatusCode.OK);

        Assert.Equal(["google"], body.GetProperty("items").EnumerateArray().Select(p => p.GetString()));
    }

    [Fact]
    public async Task The_providers_list_is_empty_without_google_settings()
    {
        using var plain = new WebsiteApiFactory(_connection);

        var body = await ApiClient.ReadJsonAsync(await plain.CreateApiClient().GetAsync("/api/v1/sign-in-providers"), HttpStatusCode.OK);

        Assert.Empty(body.GetProperty("items").EnumerateArray());
    }

    [Fact]
    public async Task A_new_google_user_gets_a_confirmed_account_and_is_signed_in()
    {
        var client = _factory.CreateApiClient();

        var done = await FakeGoogle.SignInAsync(client);

        Assert.Equal(HttpStatusCode.Redirect, done.StatusCode);
        Assert.Equal("/account", done.Headers.Location!.OriginalString);
        var me = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/accounts/me"), HttpStatusCode.OK);
        Assert.Equal(_google.Email, me.GetProperty("email").GetString());
        Assert.True(me.GetProperty("emailConfirmed").GetBoolean());
        Assert.False(me.GetProperty("hasPassword").GetBoolean());
        Assert.Equal(["google"], me.GetProperty("logins").EnumerateArray().Select(l => l.GetString()));
        Assert.Equal("Sam Google", me.GetProperty("displayName").GetString());
    }

    [Fact]
    public async Task Signing_in_again_finds_the_same_account()
    {
        await FakeGoogle.SignInAsync(_factory.CreateApiClient());
        var client = _factory.CreateApiClient();

        await FakeGoogle.SignInAsync(client);

        var me = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/accounts/me"), HttpStatusCode.OK);
        Assert.Equal(_google.Email, me.GetProperty("email").GetString());
    }

    [Fact]
    public async Task An_existing_confirmed_account_is_never_linked_by_email_alone()
    {
        var owner = await TestAccounts.CreateAsync(_factory.Services);
        _google.Email = owner.Email!;
        var client = _factory.CreateApiClient();

        var done = await FakeGoogle.SignInAsync(client);

        Assert.StartsWith("/account/sign-in?error=link-needed", done.Headers.Location!.OriginalString, StringComparison.Ordinal);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/v1/accounts/me")).StatusCode);
        var stored = await TestAccounts.ReloadAsync(_factory.Services, owner.Id);
        Assert.Equal(owner.PasswordHash, stored.PasswordHash);
    }

    [Fact]
    public async Task An_account_nobody_confirmed_is_taken_over_by_the_google_owner_and_loses_its_password()
    {
        var squatter = await TestAccounts.CreateAsync(_factory.Services, emailConfirmed: false);
        _google.Email = squatter.Email!;
        var client = _factory.CreateApiClient();

        await FakeGoogle.SignInAsync(client);

        var me = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/accounts/me"), HttpStatusCode.OK);
        Assert.False(me.GetProperty("hasPassword").GetBoolean());
        Assert.True(me.GetProperty("emailConfirmed").GetBoolean());
    }

    [Fact]
    public async Task An_unverified_google_email_is_refused()
    {
        _google.EmailVerified = false;
        var client = _factory.CreateApiClient();

        var done = await FakeGoogle.SignInAsync(client);

        Assert.StartsWith("/account/sign-in?error=email-unverified", done.Headers.Location!.OriginalString, StringComparison.Ordinal);
        Assert.Null(await TestAccounts.FindAsync(_factory.Services, _google.Email));
    }

    [Fact]
    public async Task A_signed_in_account_can_link_google_and_then_sign_in_with_it()
    {
        var owner = await TestAccounts.CreateAsync(_factory.Services);
        var client = await TestAccounts.SignedInClientAsync(_factory, owner);

        var done = await FakeGoogle.SignInAsync(client, "/api/v1/external-sign-ins/google?returnUrl=%2Faccount%2Fsecurity&link=true");

        Assert.Equal("/account/security?linked=google", done.Headers.Location!.OriginalString);
        var fresh = _factory.CreateApiClient();
        await FakeGoogle.SignInAsync(fresh);
        var me = await ApiClient.ReadJsonAsync(await fresh.GetAsync("/api/v1/accounts/me"), HttpStatusCode.OK);
        Assert.Equal(owner.Id, me.GetProperty("id").GetInt64());
    }

    [Fact]
    public async Task A_google_login_used_by_someone_else_is_not_linked_again()
    {
        await FakeGoogle.SignInAsync(_factory.CreateApiClient());
        var owner = await TestAccounts.CreateAsync(_factory.Services);
        var client = await TestAccounts.SignedInClientAsync(_factory, owner);

        var done = await FakeGoogle.SignInAsync(client, "/api/v1/external-sign-ins/google?returnUrl=%2Faccount%2Fsecurity&link=true");

        Assert.Equal("/account/security?error=login-taken", done.Headers.Location!.OriginalString);
    }

    [Fact]
    public async Task Google_can_be_unlinked_while_a_password_is_left()
    {
        var owner = await TestAccounts.CreateAsync(_factory.Services);
        var client = await TestAccounts.SignedInClientAsync(_factory, owner);
        await FakeGoogle.SignInAsync(client, "/api/v1/external-sign-ins/google?returnUrl=%2Faccount%2Fsecurity&link=true");

        var response = await client.SendAsync(HttpMethod.Delete, "/api/v1/accounts/me/logins/google");

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        var me = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/accounts/me"), HttpStatusCode.OK);
        Assert.Empty(me.GetProperty("logins").EnumerateArray());
    }

    [Fact]
    public async Task The_last_way_in_can_not_be_unlinked()
    {
        var client = _factory.CreateApiClient();
        await FakeGoogle.SignInAsync(client);
        await client.RefreshAntiforgeryTokenAsync();

        var response = await client.SendAsync(HttpMethod.Delete, "/api/v1/accounts/me/logins/google");

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Conflict, ProblemAssert.Type("conflict"), "/api/v1/accounts/me/logins/google");
    }

    [Fact]
    public async Task Cancelling_at_google_lands_on_the_sign_in_page_with_a_reason()
    {
        var response = await FakeGoogle.CancelAsync(_factory.CreateApiClient());

        Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
        Assert.Equal("/account/sign-in?error=google-failed", response.Headers.Location!.OriginalString);
    }

    [Fact]
    public async Task A_return_url_off_the_site_is_replaced_with_the_account_page()
    {
        var done = await FakeGoogle.SignInAsync(_factory.CreateApiClient(), "/api/v1/external-sign-ins/google?returnUrl=https%3A%2F%2Fevil.example%2F");

        Assert.Equal("/account", done.Headers.Location!.OriginalString);
    }

    [Fact]
    public async Task An_account_with_two_factor_must_still_give_a_code()
    {
        var client = _factory.CreateApiClient();
        await FakeGoogle.SignInAsync(client);
        var user = (await TestAccounts.FindAsync(_factory.Services, _google.Email))!;
        var key = await TestUsers.EnableTwoFactorAsync(_factory.Services, user);
        var next = _factory.CreateApiClient();

        var done = await FakeGoogle.SignInAsync(next);

        Assert.StartsWith("/account/sign-in?step=two-factor", done.Headers.Location!.OriginalString, StringComparison.Ordinal);
        Assert.Equal(HttpStatusCode.Unauthorized, (await next.GetAsync("/api/v1/accounts/me")).StatusCode);
        await next.RefreshAntiforgeryTokenAsync();
        var code = Core.Identity.Totp.Code(key, Core.Identity.Totp.TimeStep(DateTimeOffset.UtcNow));
        var finished = await next.SendAsync(HttpMethod.Post, "/api/v1/two-factor-sign-ins", new { code, recoveryCode = (string?)null });
        Assert.Equal(HttpStatusCode.NoContent, finished.StatusCode);
        var me = await ApiClient.ReadJsonAsync(await next.GetAsync("/api/v1/accounts/me"), HttpStatusCode.OK);
        Assert.Equal(JsonValueKind.Number, me.GetProperty("id").ValueKind);
    }
}
