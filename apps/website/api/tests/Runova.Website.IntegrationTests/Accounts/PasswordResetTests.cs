using System.Net;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Accounts;

public sealed class PasswordResetTests(PostgresFixture postgres) : IDisposable
{
    private const string Resets = "/api/v1/password-resets";

    private readonly WebsiteApiFactory _factory = new(postgres.ConnectionString);

    public void Dispose() => _factory.Dispose();

    [Fact]
    public async Task A_reset_link_sets_a_new_password()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var client = _factory.CreateApiClient();
        await client.RefreshAntiforgeryTokenAsync();

        var asked = await client.SendAsync(HttpMethod.Post, Resets, new { email = user.Email });
        var token = await TestAccounts.TokenFromLatestEmailAsync(_factory.Services, user.Email!, "/account/reset-password");
        var set = await client.SendAsync(HttpMethod.Post, "/api/v1/password-setups", new { token, password = "a brand new long password" });

        Assert.Equal(HttpStatusCode.Accepted, asked.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, set.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await _factory.CreateApiClient().SignInAsync(user.Email!, "a brand new long password")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await _factory.CreateApiClient().SignInAsync(user.Email!, TestAccounts.Password)).StatusCode);
    }

    [Fact]
    public async Task An_unknown_email_gets_the_same_answer_and_no_email()
    {
        var client = _factory.CreateApiClient();
        await client.RefreshAntiforgeryTokenAsync();
        var email = TestAccounts.NewEmail();

        var response = await client.SendAsync(HttpMethod.Post, Resets, new { email });

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        Assert.Empty(await TestAccounts.EmailsToAsync(_factory.Services, email));
    }

    [Fact]
    public async Task A_reset_ends_the_other_sessions()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var signedIn = await TestAccounts.SignedInClientAsync(_factory, user);
        var client = _factory.CreateApiClient();
        await client.RefreshAntiforgeryTokenAsync();
        await client.SendAsync(HttpMethod.Post, Resets, new { email = user.Email });
        var token = await TestAccounts.TokenFromLatestEmailAsync(_factory.Services, user.Email!, "/account/reset-password");

        await client.SendAsync(HttpMethod.Post, "/api/v1/password-setups", new { token, password = "a brand new long password" });

        var reloaded = await TestAccounts.ReloadAsync(_factory.Services, user.Id);
        Assert.NotEqual(user.SecurityStamp, reloaded.SecurityStamp);
        _ = signedIn;
    }
}
