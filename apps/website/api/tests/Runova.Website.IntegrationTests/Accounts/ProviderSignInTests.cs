using System.Net;
using System.Text.Json;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Accounts;

/// <summary>
/// The rules every OpenID Connect provider shares with Google (E116): a new account on the first
/// sign-in, never a link by email alone, only a verified email, linking and unlinking, Cancel, and
/// two-factor after the provider.
/// </summary>
public abstract class ProviderSignInTests : IDisposable
{
    private protected readonly FakeOidcProvider Fake;
    private protected readonly WebsiteApiFactory Factory;

    private protected ProviderSignInTests(PostgresFixture postgres, FakeOidcProvider fake, IReadOnlyDictionary<string, string> settings)
    {
        Fake = fake;
        Factory = new WebsiteApiFactory(postgres.ConnectionString, settings: settings, services: fake.Register);
    }

    public void Dispose()
    {
        Factory.Dispose();
        GC.SuppressFinalize(this);
    }

    private string Name => Fake.Provider;

    [Fact]
    public async Task The_providers_list_names_it()
    {
        var body = await ApiClient.ReadJsonAsync(await Factory.CreateApiClient().GetAsync("/api/v1/sign-in-providers"), HttpStatusCode.OK);

        Assert.Contains(Name, body.GetProperty("items").EnumerateArray().Select(p => p.GetString()));
    }

    [Fact]
    public async Task A_new_person_gets_a_confirmed_account_and_is_signed_in()
    {
        var client = Factory.CreateApiClient();

        var done = await Fake.SignInAsync(client);

        Assert.Equal(HttpStatusCode.Redirect, done.StatusCode);
        Assert.Equal("/account", done.Headers.Location!.OriginalString);
        var me = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/accounts/me"), HttpStatusCode.OK);
        Assert.Equal(Fake.Email, me.GetProperty("email").GetString());
        Assert.True(me.GetProperty("emailConfirmed").GetBoolean());
        Assert.False(me.GetProperty("hasPassword").GetBoolean());
        Assert.Equal([Name], me.GetProperty("logins").EnumerateArray().Select(l => l.GetString()));
        var user = (await TestAccounts.FindAsync(Factory.Services, Fake.Email))!;
        Assert.Equal([Name], await TestAccounts.SignInMethodsAsync(Factory.Services, user.Id));
    }

    [Fact]
    public async Task Signing_in_again_finds_the_same_account()
    {
        await Fake.SignInAsync(Factory.CreateApiClient());
        var client = Factory.CreateApiClient();

        await Fake.SignInAsync(client);

        var me = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/accounts/me"), HttpStatusCode.OK);
        Assert.Equal(Fake.Email, me.GetProperty("email").GetString());
    }

    [Fact]
    public async Task An_existing_confirmed_account_is_never_linked_by_email_alone()
    {
        var owner = await TestAccounts.CreateAsync(Factory.Services);
        Fake.Email = owner.Email!;
        var client = Factory.CreateApiClient();

        var done = await Fake.SignInAsync(client);

        Assert.Equal("/account/sign-in?error=link-needed", done.Headers.Location!.OriginalString);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/v1/accounts/me")).StatusCode);
        Assert.Equal(owner.PasswordHash, (await TestAccounts.ReloadAsync(Factory.Services, owner.Id)).PasswordHash);
    }

    [Fact]
    public async Task An_account_nobody_confirmed_is_taken_over_and_loses_its_password()
    {
        var squatter = await TestAccounts.CreateAsync(Factory.Services, emailConfirmed: false);
        Fake.Email = squatter.Email!;
        var client = Factory.CreateApiClient();

        await Fake.SignInAsync(client);

        var me = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/accounts/me"), HttpStatusCode.OK);
        Assert.Equal(squatter.Id, me.GetProperty("id").GetInt64());
        Assert.False(me.GetProperty("hasPassword").GetBoolean());
    }

    [Fact]
    public async Task A_signed_in_account_can_link_it_and_then_sign_in_with_it()
    {
        var owner = await TestAccounts.CreateAsync(Factory.Services);
        var client = await TestAccounts.SignedInClientAsync(Factory, owner);
        await TestAccounts.GrantLinkAsync(client);

        var done = await Fake.SignInAsync(client, Fake.StartPath("/account/security", link: true));

        Assert.Equal($"/account/security?linked={Name}", done.Headers.Location!.OriginalString);
        var fresh = Factory.CreateApiClient();
        await Fake.SignInAsync(fresh);
        var me = await ApiClient.ReadJsonAsync(await fresh.GetAsync("/api/v1/accounts/me"), HttpStatusCode.OK);
        Assert.Equal(owner.Id, me.GetProperty("id").GetInt64());
    }

    [Fact]
    public async Task A_login_used_by_someone_else_is_not_linked_again()
    {
        await Fake.SignInAsync(Factory.CreateApiClient());
        var owner = await TestAccounts.CreateAsync(Factory.Services);
        var client = await TestAccounts.SignedInClientAsync(Factory, owner);
        await TestAccounts.GrantLinkAsync(client);

        var done = await Fake.SignInAsync(client, Fake.StartPath("/account/security", link: true));

        Assert.Equal("/account/security?error=login-taken", done.Headers.Location!.OriginalString);
    }

    [Fact]
    public async Task It_can_be_unlinked_while_a_password_is_left_but_not_when_it_is_the_last_way_in()
    {
        var owner = await TestAccounts.CreateAsync(Factory.Services);
        var client = await TestAccounts.SignedInClientAsync(Factory, owner);
        await TestAccounts.GrantLinkAsync(client);
        await Fake.SignInAsync(client, Fake.StartPath("/account/security", link: true));

        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(HttpMethod.Delete, $"/api/v1/accounts/me/logins/{Name}")).StatusCode);

        Fake.Subject = Guid.NewGuid().ToString("N");
        Fake.Email = TestAccounts.NewEmail();
        var only = Factory.CreateApiClient();
        await Fake.SignInAsync(only);
        await only.RefreshAntiforgeryTokenAsync();
        var refused = await only.SendAsync(HttpMethod.Delete, $"/api/v1/accounts/me/logins/{Name}");
        await ProblemAssert.IsProblemAsync(refused, HttpStatusCode.Conflict, ProblemAssert.Type("conflict"), $"/api/v1/accounts/me/logins/{Name}");
    }

    [Fact]
    public async Task Cancelling_lands_on_the_sign_in_page_with_a_reason_and_where_it_was_going()
    {
        var plain = await Fake.CancelAsync(Factory.CreateApiClient());
        var fromApp = await Fake.CancelAsync(Factory.CreateApiClient(), Fake.StartPath("/account/authorize?client_id=runova-mobile"));

        Assert.Equal($"/account/sign-in?error={Name}-failed", plain.Headers.Location!.OriginalString);
        Assert.Equal(
            $"/account/sign-in?error={Name}-failed&next=" + Uri.EscapeDataString("/account/authorize?client_id=runova-mobile"),
            fromApp.Headers.Location!.OriginalString);
    }

    [Fact]
    public async Task A_return_url_off_the_site_is_replaced_with_the_account_page()
    {
        var done = await Fake.SignInAsync(Factory.CreateApiClient(), Fake.StartPath("https://evil.example/"));

        Assert.Equal("/account", done.Headers.Location!.OriginalString);
    }

    [Fact]
    public async Task An_account_with_two_factor_must_still_give_a_code()
    {
        await Fake.SignInAsync(Factory.CreateApiClient());
        var user = (await TestAccounts.FindAsync(Factory.Services, Fake.Email))!;
        var key = await TestUsers.EnableTwoFactorAsync(Factory.Services, user);
        var next = Factory.CreateApiClient();

        var done = await Fake.SignInAsync(next);

        Assert.StartsWith("/account/sign-in?step=two-factor", done.Headers.Location!.OriginalString, StringComparison.Ordinal);
        Assert.Equal(HttpStatusCode.Unauthorized, (await next.GetAsync("/api/v1/accounts/me")).StatusCode);
        await next.RefreshAntiforgeryTokenAsync();
        var code = Core.Identity.Totp.Code(key, Core.Identity.Totp.TimeStep(DateTimeOffset.UtcNow));
        var finished = await next.SendAsync(HttpMethod.Post, "/api/v1/two-factor-sign-ins", new { code, recoveryCode = (string?)null });
        Assert.Equal(HttpStatusCode.NoContent, finished.StatusCode);
        var me = await ApiClient.ReadJsonAsync(await next.GetAsync("/api/v1/accounts/me"), HttpStatusCode.OK);
        Assert.Equal(JsonValueKind.Number, me.GetProperty("id").ValueKind);
        Assert.Equal(Name, (await TestAccounts.SignInMethodsAsync(Factory.Services, user.Id))[^1]);
    }
}
