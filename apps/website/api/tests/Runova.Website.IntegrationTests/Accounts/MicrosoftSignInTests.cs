using System.Net;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Accounts;

/// <summary>
/// Microsoft's common endpoint (E116). A personal account's email is always verified; a work or
/// school account's only when the token says so with <c>xms_edov</c>, since any tenant's admin can
/// set any address on their own users.
/// </summary>
public sealed class MicrosoftSignInTests : ProviderSignInTests
{
    private const string WorkTenant = "72f988bf-0000-4000-8000-0000000000aa";

    public MicrosoftSignInTests(PostgresFixture postgres)
        : base(postgres, new FakeMicrosoft(), FakeMicrosoft.Settings)
    {
    }

    private new FakeMicrosoft Fake => (FakeMicrosoft)base.Fake;

    [Fact]
    public async Task The_sign_in_asks_microsoft_for_a_code_with_the_saved_client()
    {
        var start = await Factory.CreateApiClient().GetAsync(Fake.StartPath());

        var query = start.Headers.Location!.Query;
        Assert.StartsWith("https://login.microsoftonline.com/common/v2.0/authorize", start.Headers.Location!.GetLeftPart(UriPartial.Path), StringComparison.Ordinal);
        Assert.Contains("client_id=6f1c2c1e-0000-4000-8000-000000000001", query, StringComparison.Ordinal);
        Assert.Contains("response_type=code", query, StringComparison.Ordinal);
        Assert.Contains("redirect_uri=" + Uri.EscapeDataString("https://localhost/api/oauth/microsoft/callback"), query, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_display_name_comes_from_microsoft()
    {
        var client = Factory.CreateApiClient();

        await Fake.SignInAsync(client);

        var me = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/accounts/me"), HttpStatusCode.OK);
        Assert.Equal("Sam Microsoft", me.GetProperty("displayName").GetString());
    }

    [Fact]
    public async Task A_work_account_without_a_verified_email_can_not_make_an_account()
    {
        Fake.Tenant = WorkTenant;

        var done = await Fake.SignInAsync(Factory.CreateApiClient());

        Assert.Equal("/account/sign-in?error=email-unverified", done.Headers.Location!.OriginalString);
        Assert.Null(await TestAccounts.FindAsync(Factory.Services, Fake.Email));
    }

    [Fact]
    public async Task A_work_account_can_not_take_over_an_address_nobody_confirmed_without_a_verified_email()
    {
        var squatter = await TestAccounts.CreateAsync(Factory.Services, emailConfirmed: false);
        Fake.Tenant = WorkTenant;
        Fake.Email = squatter.Email!;

        var done = await Fake.SignInAsync(Factory.CreateApiClient());

        Assert.Equal("/account/sign-in?error=email-unverified", done.Headers.Location!.OriginalString);
        Assert.Equal(squatter.PasswordHash, (await TestAccounts.ReloadAsync(Factory.Services, squatter.Id)).PasswordHash);
    }

    [Fact]
    public async Task A_work_account_whose_email_microsoft_verified_makes_an_account()
    {
        Fake.Tenant = WorkTenant;
        Fake.ExtraClaims["xms_edov"] = true;
        var client = Factory.CreateApiClient();

        var done = await Fake.SignInAsync(client);

        Assert.Equal("/account", done.Headers.Location!.OriginalString);
        var me = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/accounts/me"), HttpStatusCode.OK);
        Assert.Equal(Fake.Email, me.GetProperty("email").GetString());
    }

    [Fact]
    public async Task A_token_from_an_issuer_that_does_not_match_its_tenant_is_refused()
    {
        Fake.ExtraClaims["tid"] = WorkTenant;
        Fake.ExtraClaims["xms_edov"] = true;

        // The issuer still names the consumers tenant, while the token claims another.
        var done = await Fake.CallbackAsync(Factory.CreateApiClient());

        Assert.Equal("/account/sign-in?error=microsoft-failed", done.Headers.Location!.OriginalString);
        Assert.Null(await TestAccounts.FindAsync(Factory.Services, Fake.Email));
    }

    [Fact]
    public async Task A_microsoft_account_with_no_email_is_refused()
    {
        Fake.Email = "";
        Fake.ExtraClaims["email"] = "";

        var done = await Fake.SignInAsync(Factory.CreateApiClient());

        Assert.Equal("/account/sign-in?error=email-unverified", done.Headers.Location!.OriginalString);
    }
}
