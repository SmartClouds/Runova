using System.Net;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Accounts;

public sealed class DeleteAccountTests(PostgresFixture postgres) : IDisposable
{
    private const string Me = "/api/v1/accounts/me";

    private readonly WebsiteApiFactory _factory = new(postgres.ConnectionString);

    public void Dispose() => _factory.Dispose();

    [Fact]
    public async Task Deleting_the_account_needs_the_password_and_then_removes_it_everywhere()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var client = await TestAccounts.SignedInClientAsync(_factory, user);
        var other = await TestAccounts.SignedInClientAsync(_factory, user);

        var wrong = await client.SendAsync(HttpMethod.Delete, Me, new { password = "nope nope nope", code = (string?)null });
        var right = await client.SendAsync(HttpMethod.Delete, Me, new { password = TestAccounts.Password, code = (string?)null });

        await ProblemAssert.IsProblemAsync(wrong, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Me);
        Assert.Equal(HttpStatusCode.NoContent, right.StatusCode);
        Assert.Null(await TestAccounts.FindAsync(_factory.Services, user.Email!));
        Assert.Equal(HttpStatusCode.Unauthorized, (await other.GetAsync(Me)).StatusCode);
    }

    [Fact]
    public async Task Staff_can_not_delete_themselves_here()
    {
        var editor = await TestUsers.CreateAsync(_factory.Services);
        var client = await TestUsers.SignedInClientAsync(_factory, editor);

        var response = await client.SendAsync(HttpMethod.Delete, Me, new { password = TestUsers.Password, code = (string?)null });

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Conflict, ProblemAssert.Type("conflict"), Me);
    }

    [Fact]
    public async Task An_account_with_a_password_steps_up_with_it_and_not_with_a_code_alone()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var key = await TestUsers.EnableTwoFactorAsync(_factory.Services, user);
        var client = _factory.CreateApiClient();
        await client.SignInAsync(user.Email!, TestAccounts.Password, Core.Identity.Totp.Code(key, Core.Identity.Totp.TimeStep(DateTimeOffset.UtcNow.AddSeconds(-30))));

        var response = await client.SendAsync(HttpMethod.Delete, Me, new { password = (string?)null, code = Core.Identity.Totp.Code(key, Core.Identity.Totp.TimeStep(DateTimeOffset.UtcNow)) });

        // The account has a password, so the code alone is not enough.
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
