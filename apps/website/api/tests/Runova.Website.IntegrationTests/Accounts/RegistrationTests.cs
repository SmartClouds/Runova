using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.DependencyInjection;
using Runova.Website.Data.Identity;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Accounts;

public sealed class RegistrationTests(PostgresFixture postgres) : IDisposable
{
    private const string Accounts = "/api/v1/accounts";
    private const string Verifications = "/api/v1/email-verifications";

    private readonly WebsiteApiFactory _factory = new(postgres.ConnectionString);

    public void Dispose() => _factory.Dispose();

    [Fact]
    public async Task Registering_answers_202_and_sends_a_verification_link()
    {
        var email = TestAccounts.NewEmail();

        var response = await TestAccounts.RegisterAsync(_factory.CreateApiClient(), email);

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        var user = await TestAccounts.FindAsync(_factory.Services, email);
        Assert.NotNull(user);
        Assert.False(user.EmailConfirmed);
        Assert.Equal("Sam Account", user.DisplayName);
        var mail = await TestAccounts.LatestEmailAsync(_factory.Services, email);
        Assert.Contains("Confirm", mail.Subject, StringComparison.Ordinal);
        Assert.Contains("/account/verify-email#token=", mail.TextBody, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_new_account_has_no_staff_role()
    {
        var email = TestAccounts.NewEmail();
        await TestAccounts.RegisterAsync(_factory.CreateApiClient(), email);

        using var scope = _factory.Services.CreateScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<AppUser>>();
        var user = await users.FindByEmailAsync(email);

        Assert.Empty(await users.GetRolesAsync(user!));
    }

    [Fact]
    public async Task Registering_a_taken_email_answers_the_same_202_and_tells_the_owner_instead()
    {
        var owner = await TestAccounts.CreateAsync(_factory.Services);

        var response = await TestAccounts.RegisterAsync(_factory.CreateApiClient(), owner.Email!, "another long password");

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        var mail = await TestAccounts.LatestEmailAsync(_factory.Services, owner.Email!);
        Assert.Contains("already", mail.Subject, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("#token=", mail.TextBody, StringComparison.Ordinal);
        // The owner's password is untouched.
        await TestAccounts.SignedInClientAsync(_factory, owner);
    }

    [Fact]
    public async Task Registering_again_before_verifying_replaces_the_first_password()
    {
        var email = TestAccounts.NewEmail();
        var client = _factory.CreateApiClient();
        await TestAccounts.RegisterAsync(client, email, "the first long password");
        await TestAccounts.RegisterAsync(client, email, "the second long password");
        var token = await TestAccounts.TokenFromLatestEmailAsync(_factory.Services, email, "/account/verify-email");
        await client.SendAsync(HttpMethod.Post, Verifications, new { token });

        var first = await _factory.CreateApiClient().SignInAsync(email, "the first long password");
        var second = await _factory.CreateApiClient().SignInAsync(email, "the second long password");

        Assert.Equal(HttpStatusCode.Unauthorized, first.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, second.StatusCode);
    }

    [Theory]
    [InlineData("not-an-email", "a long enough password", "Sam", "email")]
    [InlineData("", "a long enough password", "Sam", "email")]
    [InlineData("sam@example.test", "short", "Sam", "password")]
    [InlineData("sam@example.test", "a long enough password", "", "displayName")]
    public async Task A_bad_field_answers_400(string email, string password, string displayName, string field)
    {
        var response = await TestAccounts.RegisterAsync(_factory.CreateApiClient(), email, password, displayName);

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Accounts);
        Assert.True(problem.GetProperty("errors").TryGetProperty(field, out _));
    }

    [Fact]
    public async Task Registering_needs_the_antiforgery_header()
    {
        var client = _factory.CreateApiClient();

        var response = await client.SendAsync(HttpMethod.Post, Accounts, new { email = TestAccounts.NewEmail(), password = TestAccounts.Password, displayName = "Sam" });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task An_unverified_account_can_not_sign_in()
    {
        var email = TestAccounts.NewEmail();
        await TestAccounts.RegisterAsync(_factory.CreateApiClient(), email);

        var response = await _factory.CreateApiClient().SignInAsync(email, TestAccounts.Password);

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Forbidden, ProblemAssert.Type("email-unverified"), "/api/v1/sessions");
    }

    [Fact]
    public async Task Verifying_confirms_the_email_and_signs_in()
    {
        var email = TestAccounts.NewEmail();
        var client = _factory.CreateApiClient();
        await TestAccounts.RegisterAsync(client, email);
        var token = await TestAccounts.TokenFromLatestEmailAsync(_factory.Services, email, "/account/verify-email");

        var response = await client.SendAsync(HttpMethod.Post, Verifications, new { token });

        var body = await ApiClient.ReadJsonAsync(response, HttpStatusCode.OK);
        Assert.True(body.GetProperty("signedIn").GetBoolean());
        var me = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/accounts/me"), HttpStatusCode.OK);
        Assert.True(me.GetProperty("emailConfirmed").GetBoolean());
        Assert.Equal(email, me.GetProperty("email").GetString());
    }

    [Fact]
    public async Task A_verification_link_works_once()
    {
        var email = TestAccounts.NewEmail();
        var client = _factory.CreateApiClient();
        await TestAccounts.RegisterAsync(client, email);
        var token = await TestAccounts.TokenFromLatestEmailAsync(_factory.Services, email, "/account/verify-email");
        await client.SendAsync(HttpMethod.Post, Verifications, new { token });

        var other = _factory.CreateApiClient();
        await other.RefreshAntiforgeryTokenAsync();
        var again = await other.SendAsync(HttpMethod.Post, Verifications, new { token });

        await ProblemAssert.IsProblemAsync(again, HttpStatusCode.NotFound, ProblemAssert.Type("not-found"), Verifications);
    }

    [Fact]
    public async Task A_verification_token_can_not_set_a_password()
    {
        var email = TestAccounts.NewEmail();
        var client = _factory.CreateApiClient();
        await TestAccounts.RegisterAsync(client, email);
        var token = await TestAccounts.TokenFromLatestEmailAsync(_factory.Services, email, "/account/verify-email");

        var response = await client.SendAsync(HttpMethod.Post, "/api/v1/password-setups", new { token, password = "a password the attacker picked" });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task A_new_verification_email_can_be_asked_for_and_an_unknown_address_gets_the_same_answer()
    {
        var email = TestAccounts.NewEmail();
        var client = _factory.CreateApiClient();
        await TestAccounts.RegisterAsync(client, email);

        var known = await client.SendAsync(HttpMethod.Post, "/api/v1/verification-emails", new { email });
        var unknown = await client.SendAsync(HttpMethod.Post, "/api/v1/verification-emails", new { email = "nobody@example.test" });

        Assert.Equal(HttpStatusCode.Accepted, known.StatusCode);
        Assert.Equal(HttpStatusCode.Accepted, unknown.StatusCode);
        Assert.Equal(2, (await TestAccounts.EmailsToAsync(_factory.Services, email)).Count);
        Assert.Empty(await TestAccounts.EmailsToAsync(_factory.Services, "nobody@example.test"));
    }

    [Fact]
    public async Task The_account_can_change_its_display_name()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var client = await TestAccounts.SignedInClientAsync(_factory, user);
        var me = await client.GetAsync("/api/v1/accounts/me");
        var etag = me.Headers.ETag!.Tag;

        var response = await client.SendAsync(HttpMethod.Patch, "/api/v1/accounts/me", new { displayName = "Sam Renamed" }, ifMatch: etag);

        var body = await ApiClient.ReadJsonAsync(response, HttpStatusCode.OK);
        Assert.Equal("Sam Renamed", body.GetProperty("displayName").GetString());
    }

    [Fact]
    public async Task The_account_dto_says_what_signs_it_in_and_holds_no_secret()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var client = await TestAccounts.SignedInClientAsync(_factory, user);

        var me = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/accounts/me"), HttpStatusCode.OK);

        Assert.True(me.GetProperty("hasPassword").GetBoolean());
        Assert.False(me.GetProperty("twoFactorEnabled").GetBoolean());
        Assert.False(me.GetProperty("staff").GetBoolean());
        Assert.Equal(JsonValueKind.Array, me.GetProperty("logins").ValueKind);
        var text = me.GetRawText();
        Assert.DoesNotContain("passwordHash", text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("securityStamp", text, StringComparison.OrdinalIgnoreCase);
    }
}
