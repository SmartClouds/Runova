using System.Net;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.Data;
using Runova.Website.Data.Identity;
using Runova.Website.IntegrationTests.Infrastructure;
using static Runova.Website.IntegrationTests.Infrastructure.TestPasskeys;

namespace Runova.Website.IntegrationTests.Identity;

/// <summary>Signing in with a passkey on the website (E115).</summary>
public sealed class PasskeySignInTests : IDisposable
{
    private readonly FakeTimeProvider _time = new(DateTimeOffset.UtcNow);
    private readonly WebsiteApiFactory _factory;
    private readonly SoftwarePasskey _passkey = new();

    public PasskeySignInTests(PostgresFixture postgres) => _factory = new(postgres.ConnectionString, time: _time);

    public void Dispose()
    {
        _passkey.Dispose();
        _factory.Dispose();
    }

    private async Task<AppUser> AccountWithPasskeyAsync()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        await AddAsync(await TestAccounts.SignedInClientAsync(_factory, user), _passkey);
        return user;
    }

    [Fact]
    public async Task A_passkey_added_in_security_signs_the_account_in_with_a_session()
    {
        var user = await AccountWithPasskeyAsync();
        var client = _factory.CreateApiClient();

        var response = await SignInAsync(client, _passkey);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Contains(response.Headers.GetValues("Set-Cookie"), c => c.StartsWith("__Host-runova-session=", StringComparison.Ordinal));
        var me = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/accounts/me"), HttpStatusCode.OK);
        Assert.Equal(user.Id, me.GetProperty("id").GetInt64());
        Assert.Equal(1, me.GetProperty("passkeyCount").GetInt32());

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        Assert.Equal(2, await db.AccountSessions.CountAsync(s => s.UserId == user.Id, TestContext.Current.CancellationToken));
        var signIn = await db.AccountActivities.Where(a => a.UserId == user.Id && a.Action == "sign-in").OrderBy(a => a.Id).LastAsync(TestContext.Current.CancellationToken);
        Assert.Contains("\"passkey\"", signIn.Details, StringComparison.Ordinal);
    }

    [Fact]
    public async Task An_account_with_two_step_sign_in_is_not_asked_for_a_code()
    {
        var user = await AccountWithPasskeyAsync();
        await TestUsers.EnableTwoFactorAsync(_factory.Services, user);

        var response = await SignInAsync(_factory.CreateApiClient(), _passkey);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
    }

    [Fact]
    public async Task The_sign_count_the_passkey_reports_is_kept()
    {
        var user = await AccountWithPasskeyAsync();
        _passkey.SignCount = 41;

        Assert.Equal(HttpStatusCode.NoContent, (await SignInAsync(_factory.CreateApiClient(), _passkey)).StatusCode);

        using var scope = _factory.Services.CreateScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<AppUser>>();
        var stored = await users.GetPasskeyAsync((await users.FindByIdAsync(user.Id.ToString(System.Globalization.CultureInfo.InvariantCulture)))!, _passkey.CredentialId);
        Assert.Equal(42u, stored!.SignCount);
    }

    [Fact]
    public async Task A_sign_in_challenge_works_once()
    {
        await AccountWithPasskeyAsync();
        var client = _factory.CreateApiClient();
        await client.RefreshAntiforgeryTokenAsync();
        var challenge = await ChallengeAsync(client, "sign-in");
        var answer = _passkey.Get(challenge.Options);
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(HttpMethod.Post, SignIns, new { challengeId = challenge.Id, credential = answer })).StatusCode);

        var again = _factory.CreateApiClient();
        await again.RefreshAntiforgeryTokenAsync();
        var replay = await again.SendAsync(HttpMethod.Post, SignIns, new { challengeId = challenge.Id, credential = answer });

        await ProblemAssert.IsAsync(replay, HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task A_challenge_older_than_five_minutes_is_refused()
    {
        await AccountWithPasskeyAsync();
        var client = _factory.CreateApiClient();
        await client.RefreshAntiforgeryTokenAsync();
        var challenge = await ChallengeAsync(client, "sign-in");
        _time.Advance(TimeSpan.FromMinutes(5) + TimeSpan.FromSeconds(1));

        var response = await client.SendAsync(HttpMethod.Post, SignIns, new { challengeId = challenge.Id, credential = _passkey.Get(challenge.Options) });

        await ProblemAssert.IsAsync(response, HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task A_register_challenge_can_not_sign_in()
    {
        var user = await AccountWithPasskeyAsync();
        var signedIn = await TestAccounts.SignedInClientAsync(_factory, user);
        var register = await ChallengeAsync(signedIn, "register");
        var signIn = await ChallengeAsync(signedIn, "step-up");

        var client = _factory.CreateApiClient();
        await client.RefreshAntiforgeryTokenAsync();
        var response = await client.SendAsync(HttpMethod.Post, SignIns, new { challengeId = register.Id, credential = _passkey.Get(signIn.Options) });

        await ProblemAssert.IsAsync(response, HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task An_answer_from_another_site_is_refused()
    {
        await AccountWithPasskeyAsync();
        _passkey.Origin = "https://runovahq.com.evil.test";

        var response = await SignInAsync(_factory.CreateApiClient(), _passkey);

        await ProblemAssert.IsAsync(response, HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task An_answer_without_user_verification_is_refused()
    {
        await AccountWithPasskeyAsync();
        _passkey.UserVerified = false;

        var response = await SignInAsync(_factory.CreateApiClient(), _passkey);

        await ProblemAssert.IsAsync(response, HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task A_passkey_the_site_never_saw_is_refused()
    {
        await AccountWithPasskeyAsync();
        using var stranger = new SoftwarePasskey { UserHandle = _passkey.UserHandle };

        var response = await SignInAsync(_factory.CreateApiClient(), stranger);

        await ProblemAssert.IsAsync(response, HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task A_disabled_account_can_not_sign_in_with_its_passkey()
    {
        var user = await AccountWithPasskeyAsync();
        await UpdateUserAsync(user, u => u.DisabledAt = _time.GetUtcNow());

        var response = await SignInAsync(_factory.CreateApiClient(), _passkey);

        await ProblemAssert.IsAsync(response, HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task A_locked_account_stays_locked()
    {
        var user = await AccountWithPasskeyAsync();
        await UpdateUserAsync(user, u => u.LockoutEnd = _time.GetUtcNow().AddMinutes(10));

        var response = await SignInAsync(_factory.CreateApiClient(), _passkey);

        Assert.Equal((HttpStatusCode)423, response.StatusCode);
    }

    [Fact]
    public async Task A_failed_answer_is_logged_on_the_account_whose_passkey_it_was()
    {
        var user = await AccountWithPasskeyAsync();
        _passkey.Origin = "https://elsewhere.test";

        await SignInAsync(_factory.CreateApiClient(), _passkey);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var failed = await db.AccountActivities.SingleAsync(a => a.UserId == user.Id && a.Action == "sign-in-failed", TestContext.Current.CancellationToken);
        Assert.Contains("passkey", failed.Details, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Sign_in_options_ask_for_user_verification_and_name_no_credentials()
    {
        var client = _factory.CreateApiClient();
        await client.RefreshAntiforgeryTokenAsync();

        var options = (await ChallengeAsync(client, "sign-in")).Options;

        Assert.Equal(SoftwarePasskey.SiteRpId, options.GetProperty("rpId").GetString());
        Assert.Equal("required", options.GetProperty("userVerification").GetString());
        Assert.True(!options.TryGetProperty("allowCredentials", out var allowed) || allowed.GetArrayLength() == 0);
    }

    [Fact]
    public async Task An_unknown_purpose_is_a_validation_problem()
    {
        var client = _factory.CreateApiClient();
        await client.RefreshAntiforgeryTokenAsync();

        var response = await client.SendAsync(HttpMethod.Post, Challenges, new { purpose = "anything" });

        await ProblemAssert.IsAsync(response, HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Register_and_step_up_challenges_need_a_signed_in_account()
    {
        var client = _factory.CreateApiClient();
        await client.RefreshAntiforgeryTokenAsync();

        Assert.Equal(HttpStatusCode.Unauthorized, (await client.SendAsync(HttpMethod.Post, Challenges, new { purpose = "register" })).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.SendAsync(HttpMethod.Post, Challenges, new { purpose = "step-up" })).StatusCode);
    }

    [Fact]
    public async Task A_sign_in_challenge_needs_no_cookie_so_the_phone_can_ask_but_signing_in_needs_the_antiforgery_token()
    {
        await AccountWithPasskeyAsync();
        var client = _factory.CreateApiClient();
        var challenge = await ChallengeAsync(client, "sign-in");

        var response = await client.SendAsync(HttpMethod.Post, SignIns, new { challengeId = challenge.Id, credential = _passkey.Get(challenge.Options) });

        var problem = await ProblemAssert.IsAsync(response, HttpStatusCode.BadRequest);
        Assert.True(problem.GetProperty("errors").TryGetProperty("antiforgery", out _));
    }

    private async Task UpdateUserAsync(AppUser user, Action<AppUser> change)
    {
        using var scope = _factory.Services.CreateScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<AppUser>>();
        var stored = (await users.FindByIdAsync(user.Id.ToString(System.Globalization.CultureInfo.InvariantCulture)))!;
        change(stored);
        Assert.True((await users.UpdateAsync(stored)).Succeeded);
    }

}
