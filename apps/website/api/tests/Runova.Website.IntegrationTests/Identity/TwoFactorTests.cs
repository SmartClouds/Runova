using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.Core.Identity;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Identity;

public sealed class TwoFactorTests : IDisposable
{
    private const string Sessions = "/api/v1/sessions";
    private const string TwoFactor = "/api/v1/users/me/two-factor";
    private const string RecoveryCodes = "/api/v1/users/me/two-factor/recovery-codes";

    // Five seconds into a time step, so a test knows which step "now" is.
    private readonly FakeTimeProvider _time = new(
        DateTimeOffset.FromUnixTimeSeconds((DateTimeOffset.UtcNow.ToUnixTimeSeconds() / 30 * 30) + 5));

    private readonly WebsiteApiFactory _factory;

    public TwoFactorTests(PostgresFixture postgres) => _factory = new(postgres.ConnectionString, time: _time);

    public void Dispose() => _factory.Dispose();

    [Fact]
    public async Task Setup_starts_with_a_shared_key_and_a_right_code_turns_it_on_with_ten_recovery_codes()
    {
        var client = await SignedInClientAsync(await TestUsers.CreateAsync(_factory.Services));

        var setup = await ReadJsonAsync(await client.SendAsync(HttpMethod.Post, TwoFactor));
        var key = Base32.Decode(setup.GetProperty("sharedKey").GetString()!);
        Assert.StartsWith("otpauth://totp/", setup.GetProperty("authenticatorUri").GetString(), StringComparison.Ordinal);
        Assert.False((await ReadJsonAsync(await client.GetAsync(TwoFactor))).GetProperty("enabled").GetBoolean());

        var confirmed = await client.SendAsync(HttpMethod.Put, TwoFactor, new { code = CodeNow(key) });

        Assert.Equal(HttpStatusCode.OK, confirmed.StatusCode);
        var recoveryCodes = (await ReadJsonAsync(confirmed)).GetProperty("recoveryCodes").EnumerateArray().Select(c => c.GetString()).ToList();
        Assert.Equal(10, recoveryCodes.Distinct().Count());
        var status = await ReadJsonAsync(await client.GetAsync(TwoFactor));
        Assert.True(status.GetProperty("enabled").GetBoolean());
        Assert.Equal(10, status.GetProperty("recoveryCodesLeft").GetInt32());
    }

    [Fact]
    public async Task A_wrong_code_does_not_turn_two_factor_on()
    {
        var client = await SignedInClientAsync(await TestUsers.CreateAsync(_factory.Services));
        var key = Base32.Decode((await ReadJsonAsync(await client.SendAsync(HttpMethod.Post, TwoFactor))).GetProperty("sharedKey").GetString()!);

        var response = await client.SendAsync(HttpMethod.Put, TwoFactor, new { code = Totp.Code(key, Totp.TimeStep(_time.GetUtcNow()) + 5) });

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), TwoFactor);
        Assert.False((await ReadJsonAsync(await client.GetAsync(TwoFactor))).GetProperty("enabled").GetBoolean());
    }

    [Fact]
    public async Task With_two_factor_on_the_password_alone_answers_two_factor_required()
    {
        var user = await TestUsers.CreateAsync(_factory.Services);
        await TestUsers.EnableTwoFactorAsync(_factory.Services, user);

        var response = await _factory.CreateApiClient().SignInAsync(user.Email!, TestUsers.Password);

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Unauthorized, ProblemAssert.Type("two-factor-required"), Sessions);
    }

    [Fact]
    public async Task A_valid_code_signs_in_and_works_only_once()
    {
        var user = await TestUsers.CreateAsync(_factory.Services);
        var key = await TestUsers.EnableTwoFactorAsync(_factory.Services, user);
        var code = CodeNow(key);

        Assert.Equal(HttpStatusCode.NoContent, (await _factory.CreateApiClient().SignInAsync(user.Email!, TestUsers.Password, code)).StatusCode);
        var again = await _factory.CreateApiClient().SignInAsync(user.Email!, TestUsers.Password, code);

        await ProblemAssert.IsProblemAsync(again, HttpStatusCode.Unauthorized, ProblemAssert.Type("two-factor-required"), Sessions);

        // An earlier step's code is refused too once a later one was used.
        var earlier = Totp.Code(key, Totp.TimeStep(_time.GetUtcNow()) - 1);
        Assert.Equal(HttpStatusCode.Unauthorized, (await _factory.CreateApiClient().SignInAsync(user.Email!, TestUsers.Password, earlier)).StatusCode);

        _time.Advance(Totp.Step);
        Assert.Equal(HttpStatusCode.NoContent, (await _factory.CreateApiClient().SignInAsync(user.Email!, TestUsers.Password, CodeNow(key))).StatusCode);
    }

    [Fact]
    public async Task The_code_that_turned_two_factor_on_does_not_sign_in()
    {
        var client = await SignedInClientAsync(await TestUsers.CreateAsync(_factory.Services));
        var user = await ReadJsonAsync(await client.GetAsync("/api/v1/users/me"));
        var key = Base32.Decode((await ReadJsonAsync(await client.SendAsync(HttpMethod.Post, TwoFactor))).GetProperty("sharedKey").GetString()!);
        var code = CodeNow(key);
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(HttpMethod.Put, TwoFactor, new { code })).StatusCode);

        var response = await _factory.CreateApiClient().SignInAsync(user.GetProperty("email").GetString()!, TestUsers.Password, code);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task A_code_two_steps_off_is_refused()
    {
        var user = await TestUsers.CreateAsync(_factory.Services);
        var key = await TestUsers.EnableTwoFactorAsync(_factory.Services, user);

        var response = await _factory.CreateApiClient().SignInAsync(
            user.Email!, TestUsers.Password, Totp.Code(key, Totp.TimeStep(_time.GetUtcNow()) + 2));

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Unauthorized, ProblemAssert.Type("two-factor-required"), Sessions);
    }

    [Fact]
    public async Task A_valid_code_with_a_wrong_password_answers_unauthorized()
    {
        var user = await TestUsers.CreateAsync(_factory.Services);
        var key = await TestUsers.EnableTwoFactorAsync(_factory.Services, user);

        var response = await _factory.CreateApiClient().SignInAsync(user.Email!, "not the password at all", CodeNow(key));

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Unauthorized, ProblemAssert.Type("unauthorized"), Sessions);
    }

    [Fact]
    public async Task A_recovery_code_signs_in_once()
    {
        var user = await TestUsers.CreateAsync(_factory.Services);
        await TestUsers.EnableTwoFactorAsync(_factory.Services, user);
        var recoveryCode = (await TestUsers.GenerateRecoveryCodesAsync(_factory.Services, user))[0];

        var first = await _factory.CreateApiClient().SignInAsync(user.Email!, TestUsers.Password, recoveryCode: recoveryCode);
        var second = await _factory.CreateApiClient().SignInAsync(user.Email!, TestUsers.Password, recoveryCode: recoveryCode);

        Assert.Equal(HttpStatusCode.NoContent, first.StatusCode);
        await ProblemAssert.IsProblemAsync(second, HttpStatusCode.Unauthorized, ProblemAssert.Type("two-factor-required"), Sessions);
    }

    [Fact]
    public async Task The_password_turns_two_factor_off_and_the_recovery_codes_stop_working()
    {
        var (user, _, client) = await SignedInWithTwoFactorAsync();
        await TestUsers.GenerateRecoveryCodesAsync(_factory.Services, user);

        var response = await client.SendAsync(HttpMethod.Delete, TwoFactor, new { password = TestUsers.Password });

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        var status = await ReadJsonAsync(await client.GetAsync(TwoFactor));
        Assert.False(status.GetProperty("enabled").GetBoolean());
        Assert.Equal(0, status.GetProperty("recoveryCodesLeft").GetInt32());
        Assert.Equal(HttpStatusCode.NoContent, (await _factory.CreateApiClient().SignInAsync(user.Email!, TestUsers.Password)).StatusCode);
    }

    [Theory]
    [InlineData("not the password at all")]
    [InlineData("")]
    [InlineData(null)]
    public async Task A_wrong_or_missing_password_leaves_two_factor_on(string? password)
    {
        var (_, _, client) = await SignedInWithTwoFactorAsync();

        var response = await client.SendAsync(HttpMethod.Delete, TwoFactor, new { password });

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), TwoFactor);
        Assert.Equal(["password"], problem.GetProperty("errors").EnumerateObject().Select(p => p.Name));
        Assert.True((await ReadJsonAsync(await client.GetAsync(TwoFactor))).GetProperty("enabled").GetBoolean());
    }

    [Fact]
    public async Task Turning_two_factor_off_with_no_body_gets_400()
    {
        var (_, _, client) = await SignedInWithTwoFactorAsync();

        var response = await client.SendAsync(HttpMethod.Delete, TwoFactor);

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), TwoFactor);
        Assert.True((await ReadJsonAsync(await client.GetAsync(TwoFactor))).GetProperty("enabled").GetBoolean());
    }

    [Fact]
    public async Task A_code_makes_ten_new_recovery_codes_once_and_the_old_ones_stop_working()
    {
        var (user, key, client) = await SignedInWithTwoFactorAsync();
        var old = await TestUsers.GenerateRecoveryCodesAsync(_factory.Services, user);

        // The sign-in used this step's code; drift lets the next step's code in now.
        var response = await client.SendAsync(HttpMethod.Post, RecoveryCodes, new { code = CodeAt(key, 1) });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        Assert.Equal("private, no-store", response.Headers.NonValidated["Cache-Control"].ToString());
        var codes = (await ReadJsonAsync(response)).GetProperty("recoveryCodes").EnumerateArray().Select(c => c.GetString()!).ToList();
        Assert.Equal(10, codes.Distinct().Count());
        Assert.Empty(codes.Intersect(old));
        Assert.Equal(10, (await ReadJsonAsync(await client.GetAsync(TwoFactor))).GetProperty("recoveryCodesLeft").GetInt32());
        Assert.Equal(HttpStatusCode.Unauthorized, (await _factory.CreateApiClient().SignInAsync(user.Email!, TestUsers.Password, recoveryCode: old[0])).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await _factory.CreateApiClient().SignInAsync(user.Email!, TestUsers.Password, recoveryCode: codes[0])).StatusCode);

        var again = await client.SendAsync(HttpMethod.Post, RecoveryCodes, new { code = CodeAt(key, 1) });
        await ProblemAssert.IsProblemAsync(again, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), RecoveryCodes);
    }

    [Theory]
    [InlineData("wrong")]
    [InlineData("")]
    [InlineData(null)]
    public async Task A_wrong_or_missing_code_makes_no_recovery_codes(string? which)
    {
        var (user, key, client) = await SignedInWithTwoFactorAsync();
        var old = await TestUsers.GenerateRecoveryCodesAsync(_factory.Services, user);
        var code = which == "wrong" ? CodeAt(key, 5) : which;

        var response = await client.SendAsync(HttpMethod.Post, RecoveryCodes, new { code });

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), RecoveryCodes);
        Assert.Equal(["code"], problem.GetProperty("errors").EnumerateObject().Select(p => p.Name));
        Assert.Equal(HttpStatusCode.NoContent, (await _factory.CreateApiClient().SignInAsync(user.Email!, TestUsers.Password, recoveryCode: old[0])).StatusCode);
    }

    [Fact]
    public async Task With_two_factor_off_there_are_no_recovery_codes_to_make()
    {
        var client = await SignedInClientAsync(await TestUsers.CreateAsync(_factory.Services));

        var response = await client.SendAsync(HttpMethod.Post, RecoveryCodes, new { code = "123456" });

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), RecoveryCodes);
        Assert.Equal(["code"], problem.GetProperty("errors").EnumerateObject().Select(p => p.Name));
    }

    [Theory]
    [InlineData("DELETE", TwoFactor)]
    [InlineData("POST", RecoveryCodes)]
    public async Task Without_a_session_turning_off_or_new_codes_answer_401(string method, string path)
    {
        var response = await _factory.CreateApiClient().SendAsync(new HttpMethod(method), path, new { password = TestUsers.Password, code = "123456" });

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Unauthorized, ProblemAssert.Type("unauthorized"), path);
    }

    /// <summary>A user with two-factor on, signed in with this step's code.</summary>
    private async Task<(Runova.Website.Data.Identity.AppUser User, byte[] Key, ApiClient Client)> SignedInWithTwoFactorAsync()
    {
        var user = await TestUsers.CreateAsync(_factory.Services);
        var key = await TestUsers.EnableTwoFactorAsync(_factory.Services, user);
        var client = _factory.CreateApiClient();
        Assert.Equal(HttpStatusCode.NoContent, (await client.SignInAsync(user.Email!, TestUsers.Password, CodeNow(key))).StatusCode);
        return (user, key, client);
    }

    private string CodeAt(byte[] key, int stepsAhead) => Totp.Code(key, Totp.TimeStep(_time.GetUtcNow()) + stepsAhead);

    private string CodeNow(byte[] key) => Totp.Code(key, Totp.TimeStep(_time.GetUtcNow()));

    private async Task<ApiClient> SignedInClientAsync(Runova.Website.Data.Identity.AppUser user)
    {
        var client = _factory.CreateApiClient();
        Assert.Equal(HttpStatusCode.NoContent, (await client.SignInAsync(user.Email!, TestUsers.Password)).StatusCode);
        return client;
    }

    private static async Task<JsonElement> ReadJsonAsync(HttpResponseMessage response)
    {
        Assert.True(response.IsSuccessStatusCode, $"{(int)response.StatusCode}: {await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken)}");
        return await response.Content.ReadFromJsonAsync<JsonElement>(TestContext.Current.CancellationToken);
    }
}
