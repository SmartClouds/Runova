using System.Net;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using Runova.Website.Data.Identity;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Accounts;

/// <summary>
/// Sign in with Apple (E116): Apple posts the code back, sends the name only the first time,
/// takes a JWT the website signs as its client secret, and wants its token revoked when the
/// person deletes their account or unlinks Apple.
/// </summary>
public sealed class AppleSignInTests : ProviderSignInTests
{
    public AppleSignInTests(PostgresFixture postgres)
        : base(postgres, new FakeApple(), FakeApple.Settings)
    {
    }

    private new FakeApple Fake => (FakeApple)base.Fake;

    [Fact]
    public async Task The_sign_in_asks_apple_for_a_form_post_with_the_name_and_email()
    {
        var start = await Factory.CreateApiClient().GetAsync(Fake.StartPath());

        var query = start.Headers.Location!.Query;
        Assert.StartsWith("https://appleid.apple.com/authorize", start.Headers.Location!.GetLeftPart(UriPartial.Path), StringComparison.Ordinal);
        Assert.Contains("client_id=" + FakeApple.ServicesId, query, StringComparison.Ordinal);
        Assert.Contains("response_mode=form_post", query, StringComparison.Ordinal);
        Assert.Contains("scope=openid%20name%20email", query, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_name_apple_sends_the_first_time_becomes_the_display_name()
    {
        var client = Factory.CreateApiClient();

        await Fake.SignInAsync(client);

        var me = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/accounts/me"), HttpStatusCode.OK);
        Assert.Equal("Sam Apple", me.GetProperty("displayName").GetString());
    }

    [Fact]
    public async Task Without_a_name_the_display_name_is_the_start_of_the_email()
    {
        Fake.FirstTimeName = null;
        Fake.Email = "hidden.relay@privaterelay.appleid.com";
        Fake.ExtraClaims["is_private_email"] = "true";
        var client = Factory.CreateApiClient();

        await Fake.SignInAsync(client);

        var me = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/accounts/me"), HttpStatusCode.OK);
        Assert.Equal("hidden.relay@privaterelay.appleid.com", me.GetProperty("email").GetString());
        Assert.Equal("hidden.relay", me.GetProperty("displayName").GetString());
    }

    [Theory]
    [InlineData(true)]
    [InlineData("true")]
    public async Task A_verified_email_is_trusted_whether_apple_sends_a_bool_or_a_string(object verified)
    {
        Fake.ExtraClaims["email_verified"] = verified;
        var client = Factory.CreateApiClient();

        var done = await Fake.SignInAsync(client);

        Assert.Equal("/account", done.Headers.Location!.OriginalString);
    }

    [Fact]
    public async Task An_unverified_apple_email_is_refused()
    {
        Fake.ExtraClaims["email_verified"] = "false";

        var done = await Fake.SignInAsync(Factory.CreateApiClient());

        Assert.Equal("/account/sign-in?error=email-unverified", done.Headers.Location!.OriginalString);
    }

    [Fact]
    public async Task The_client_secret_is_a_fresh_es256_jwt_signed_with_the_saved_key()
    {
        await Fake.SignInAsync(Factory.CreateApiClient());

        var request = Assert.Single(Fake.TokenRequests);
        Assert.Equal(FakeApple.ServicesId, request["client_id"]);
        var result = await new JsonWebTokenHandler().ValidateTokenAsync(request["client_secret"], new TokenValidationParameters
        {
            ValidIssuer = FakeApple.TeamId,
            ValidAudience = "https://appleid.apple.com",
            IssuerSigningKey = FakeApple.PublicKey(),
        });
        Assert.True(result.IsValid, result.Exception?.Message);
        var token = (JsonWebToken)result.SecurityToken;
        Assert.Equal(FakeApple.ServicesId, token.Subject);
        Assert.Equal(FakeApple.KeyId, token.Kid);
        Assert.Equal("ES256", token.Alg);
        Assert.True(token.ValidTo - token.IssuedAt <= TimeSpan.FromMinutes(5));
    }

    [Fact]
    public async Task Apples_refresh_token_is_kept_sealed_for_revoking_later()
    {
        await Fake.SignInAsync(Factory.CreateApiClient());
        var user = (await TestAccounts.FindAsync(Factory.Services, Fake.Email))!;

        using var scope = Factory.Services.CreateScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<AppUser>>();
        var saved = await users.GetAuthenticationTokenAsync(user, "Apple", "refresh_token");

        Assert.NotNull(saved);
        Assert.DoesNotContain($"fake-refresh-{Fake.Subject}", saved, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Deleting_the_account_revokes_apples_token()
    {
        var client = Factory.CreateApiClient();
        await Fake.SignInAsync(client);
        await client.RefreshAntiforgeryTokenAsync();

        // An account with only Apple proves itself with a recent sign-in.
        var deleted = await client.SendAsync(HttpMethod.Delete, "/api/v1/accounts/me", new { });

        Assert.Equal(HttpStatusCode.NoContent, deleted.StatusCode);
        var revoke = Assert.Single(Fake.OtherPosts, p => p.Path == "/auth/revoke");
        Assert.Equal($"fake-refresh-{Fake.Subject}", revoke.Form["token"]);
        Assert.Equal("refresh_token", revoke.Form["token_type_hint"]);
        Assert.Equal(FakeApple.ServicesId, revoke.Form["client_id"]);
        Assert.False(string.IsNullOrEmpty(revoke.Form["client_secret"]));
    }

    [Fact]
    public async Task Unlinking_apple_revokes_its_token_and_forgets_it()
    {
        var owner = await TestAccounts.CreateAsync(Factory.Services);
        var client = await TestAccounts.SignedInClientAsync(Factory, owner);
        await Fake.SignInAsync(client, Fake.StartPath("/account/security", link: true));

        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(HttpMethod.Delete, "/api/v1/accounts/me/logins/apple")).StatusCode);

        var revoke = Assert.Single(Fake.OtherPosts, p => p.Path == "/auth/revoke");
        Assert.Equal($"fake-refresh-{Fake.Subject}", revoke.Form["token"]);
        using var scope = Factory.Services.CreateScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<AppUser>>();
        Assert.Null(await users.GetAuthenticationTokenAsync((await users.FindByIdAsync(owner.Id.ToString(System.Globalization.CultureInfo.InvariantCulture)))!, "Apple", "refresh_token"));
    }
}
