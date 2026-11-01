using System.Net;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Identity;

public sealed class PasswordChangeTests(PostgresFixture postgres) : IDisposable
{
    private const string Password = "/api/v1/users/me/password";
    private const string NewPassword = "a brand new passphrase";

    private readonly WebsiteApiFactory _factory = new(postgres.ConnectionString);

    public void Dispose() => _factory.Dispose();

    [Fact]
    public async Task The_right_current_password_changes_it_and_the_session_goes_on()
    {
        var user = await TestUsers.CreateAsync(_factory.Services);
        var client = await TestUsers.SignedInClientAsync(_factory, user);

        var response = await client.SendAsync(HttpMethod.Put, Password, new { currentPassword = TestUsers.Password, newPassword = NewPassword });

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/v1/users/me")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await _factory.CreateApiClient().SignInAsync(user.Email!, TestUsers.Password)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await _factory.CreateApiClient().SignInAsync(user.Email!, NewPassword)).StatusCode);
    }

    [Fact]
    public async Task A_wrong_current_password_gets_400_and_changes_nothing()
    {
        var user = await TestUsers.CreateAsync(_factory.Services);
        var client = await TestUsers.SignedInClientAsync(_factory, user);

        var response = await client.SendAsync(HttpMethod.Put, Password, new { currentPassword = "not the password at all", newPassword = NewPassword });

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Password);
        Assert.Equal(["currentPassword"], problem.GetProperty("errors").EnumerateObject().Select(p => p.Name));
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/v1/users/me")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await _factory.CreateApiClient().SignInAsync(user.Email!, TestUsers.Password)).StatusCode);
    }

    [Theory]
    [InlineData("too short", "newPassword")]
    [InlineData("", "newPassword")]
    [InlineData(null, "newPassword")]
    public async Task A_new_password_the_rules_refuse_gets_400(string? newPassword, string field)
    {
        var user = await TestUsers.CreateAsync(_factory.Services);
        var client = await TestUsers.SignedInClientAsync(_factory, user);

        var response = await client.SendAsync(HttpMethod.Put, Password, new { currentPassword = TestUsers.Password, newPassword });

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Password);
        Assert.Equal([field], problem.GetProperty("errors").EnumerateObject().Select(p => p.Name));
        Assert.Equal(HttpStatusCode.NoContent, (await _factory.CreateApiClient().SignInAsync(user.Email!, TestUsers.Password)).StatusCode);
    }

    [Fact]
    public async Task No_current_password_or_an_unknown_field_gets_400()
    {
        var client = await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services));

        var missing = await client.SendAsync(HttpMethod.Put, Password, new { newPassword = NewPassword });
        var unknown = await client.SendAsync(HttpMethod.Put, Password, new { currentPassword = TestUsers.Password, newPassword = NewPassword, password = NewPassword });

        var problem = await ProblemAssert.IsProblemAsync(missing, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Password);
        Assert.Equal(["currentPassword"], problem.GetProperty("errors").EnumerateObject().Select(p => p.Name));
        await ProblemAssert.IsProblemAsync(unknown, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Password);
    }

    [Fact]
    public async Task Without_a_session_it_answers_401()
    {
        var response = await _factory.CreateApiClient().SendAsync(HttpMethod.Put, Password, new { currentPassword = TestUsers.Password, newPassword = NewPassword });

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Unauthorized, ProblemAssert.Type("unauthorized"), Password);
    }
}
