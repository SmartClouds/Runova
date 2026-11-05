using System.Net;
using System.Text.Json;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Accounts;

public sealed class AccountActivityTests(PostgresFixture postgres) : IDisposable
{
    private const string Activities = "/api/v1/activities";

    private readonly WebsiteApiFactory _factory = new(postgres.ConnectionString);

    public void Dispose() => _factory.Dispose();

    private static async Task<JsonElement[]> ListAsync(ApiClient client, string query = "")
    {
        var body = await ApiClient.ReadJsonAsync(await client.GetAsync(Activities + query), HttpStatusCode.OK);
        return [.. body.GetProperty("items").EnumerateArray()];
    }

    [Fact]
    public async Task A_sign_in_is_recorded_with_where_it_came_from()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var client = _factory.CreateApiClient();
        await client.RefreshAntiforgeryTokenAsync();
        await client.SendAsync(
            HttpMethod.Post,
            "/api/v1/sessions",
            new { email = user.Email, password = TestAccounts.Password, twoFactorCode = (string?)null, recoveryCode = (string?)null },
            headers: new Dictionary<string, string> { [TestApiClients.RemoteIpHeader] = "203.0.113.30", ["User-Agent"] = "Mozilla/5.0 Chrome/141.0" });
        await client.RefreshAntiforgeryTokenAsync();

        var entry = Assert.Single(await ListAsync(client), a => a.GetProperty("action").GetString() == "sign-in");

        Assert.Equal("203.0.113.30", entry.GetProperty("ip").GetString());
        Assert.Contains("Chrome", entry.GetProperty("device").GetString(), StringComparison.Ordinal);
        Assert.Equal(JsonValueKind.String, entry.GetProperty("at").ValueKind);
    }

    [Fact]
    public async Task A_wrong_password_for_an_account_is_recorded()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        await _factory.CreateApiClient().SignInAsync(user.Email!, "not the right password");
        var client = await TestAccounts.SignedInClientAsync(_factory, user);

        Assert.Contains(await ListAsync(client), a => a.GetProperty("action").GetString() == "sign-in-failed");
    }

    [Fact]
    public async Task The_list_is_newest_first_and_holds_only_this_account()
    {
        var sam = await TestAccounts.CreateAsync(_factory.Services);
        var kim = await TestAccounts.CreateAsync(_factory.Services);
        await TestAccounts.SignedInClientAsync(_factory, kim);
        var client = await TestAccounts.SignedInClientAsync(_factory, sam);
        await client.SendAsync(HttpMethod.Put, "/api/v1/users/me/password", new { currentPassword = TestAccounts.Password, newPassword = "a fresh long password" });

        var entries = await ListAsync(client);

        Assert.Equal(["password-changed", "sign-in"], entries.Select(e => e.GetProperty("action").GetString()));
    }

    [Fact]
    public async Task Entries_can_be_filtered_by_action_and_are_paged()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var client = await TestAccounts.SignedInClientAsync(_factory, user);
        await client.SendAsync(HttpMethod.Put, "/api/v1/users/me/password", new { currentPassword = TestAccounts.Password, newPassword = "a fresh long password" });

        var filtered = await ListAsync(client, "?action=password-changed");
        var page = await ApiClient.ReadJsonAsync(await client.GetAsync(Activities + "?pageSize=1"), HttpStatusCode.OK);

        Assert.Single(filtered);
        Assert.Equal(2, page.GetProperty("totalItems").GetInt32());
        Assert.Single(page.GetProperty("items").EnumerateArray());
    }

    [Fact]
    public async Task No_entry_holds_a_password()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var client = await TestAccounts.SignedInClientAsync(_factory, user);
        await client.SendAsync(HttpMethod.Put, "/api/v1/users/me/password", new { currentPassword = TestAccounts.Password, newPassword = "a fresh long password" });

        var text = (await client.GetAsync(Activities)).Content.ReadAsStringAsync(TestContext.Current.CancellationToken);

        Assert.DoesNotContain("a fresh long password", await text, StringComparison.Ordinal);
        Assert.DoesNotContain(TestAccounts.Password, await text, StringComparison.Ordinal);
    }
}
