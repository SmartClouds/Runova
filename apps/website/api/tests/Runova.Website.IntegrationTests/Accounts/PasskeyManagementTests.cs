using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.Website.Data;
using Runova.Website.IntegrationTests.Infrastructure;
using static Runova.Website.IntegrationTests.Infrastructure.TestPasskeys;

namespace Runova.Website.IntegrationTests.Accounts;

/// <summary>The account's own passkeys on the Security page (E115).</summary>
public sealed class PasskeyManagementTests(PostgresFixture postgres) : IDisposable
{
    private readonly WebsiteApiFactory _factory = new(postgres.ConnectionString);
    private readonly SoftwarePasskey _passkey = new();

    public void Dispose()
    {
        _passkey.Dispose();
        _factory.Dispose();
    }

    private async Task<ApiClient> SignedInAsync() =>
        await TestAccounts.SignedInClientAsync(_factory, await TestAccounts.CreateAsync(_factory.Services));

    [Fact]
    public async Task Adding_a_passkey_lists_it_by_name_without_its_key()
    {
        var client = await SignedInAsync();

        var added = await AddAsync(client, _passkey, "  Work laptop  ");

        Assert.Equal(_passkey.Id, added.GetProperty("id").GetString());
        Assert.Equal("Work laptop", added.GetProperty("name").GetString());
        var list = await ApiClient.ReadJsonAsync(await client.GetAsync(Mine), HttpStatusCode.OK);
        var item = Assert.Single(list.GetProperty("items").EnumerateArray());
        Assert.Equal("Work laptop", item.GetProperty("name").GetString());
        Assert.False(item.TryGetProperty("publicKey", out _));
    }

    [Fact]
    public async Task Adding_a_passkey_asks_for_the_password_first()
    {
        var client = await SignedInAsync();

        var response = await SendAddAsync(client, _passkey, password: null);

        var problem = await ProblemAssert.IsAsync(response, HttpStatusCode.BadRequest);
        Assert.True(problem.GetProperty("errors").TryGetProperty("password", out _));
        Assert.Empty((await ApiClient.ReadJsonAsync(await client.GetAsync(Mine), HttpStatusCode.OK)).GetProperty("items").EnumerateArray());
    }

    [Fact]
    public async Task A_passkey_with_no_name_is_called_passkey()
    {
        Assert.Equal("Passkey", (await AddAsync(await SignedInAsync(), _passkey, "")).GetProperty("name").GetString());
    }

    [Fact]
    public async Task A_register_challenge_belongs_to_the_account_that_asked()
    {
        var first = await SignedInAsync();
        var second = await SignedInAsync();
        var challenge = await ChallengeAsync(first, "register");

        var response = await second.SendAsync(HttpMethod.Post, Mine, new { challengeId = challenge.Id, credential = _passkey.Create(challenge.Options), name = "Stolen", password = TestAccounts.Password });

        var problem = await ProblemAssert.IsAsync(response, HttpStatusCode.BadRequest);
        Assert.True(problem.GetProperty("errors").TryGetProperty("credential", out _));
    }

    [Fact]
    public async Task The_same_passkey_can_not_be_added_twice()
    {
        var client = await SignedInAsync();
        await AddAsync(client, _passkey);

        var response = await SendAddAsync(client, _passkey);

        await ProblemAssert.IsAsync(response, HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Renaming_a_passkey_keeps_it()
    {
        var client = await SignedInAsync();
        await AddAsync(client, _passkey);

        var renamed = await ApiClient.ReadJsonAsync(await client.SendAsync(HttpMethod.Patch, $"{Mine}/{_passkey.Id}", new { name = "Phone" }), HttpStatusCode.OK);

        Assert.Equal("Phone", renamed.GetProperty("name").GetString());
        Assert.Equal(HttpStatusCode.NoContent, (await SignInAsync(_factory.CreateApiClient(), _passkey)).StatusCode);
    }

    [Fact]
    public async Task A_name_longer_than_fifty_characters_is_refused()
    {
        var client = await SignedInAsync();
        await AddAsync(client, _passkey);

        var response = await client.SendAsync(HttpMethod.Patch, $"{Mine}/{_passkey.Id}", new { name = new string('a', 51) });

        await ProblemAssert.IsAsync(response, HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Removing_a_passkey_asks_for_the_password_and_then_it_no_longer_signs_in()
    {
        var client = await SignedInAsync();
        await AddAsync(client, _passkey);

        var refused = await client.SendAsync(HttpMethod.Delete, $"{Mine}/{_passkey.Id}", new { password = "wrong password!" });
        await ProblemAssert.IsAsync(refused, HttpStatusCode.BadRequest);

        var removed = await client.SendAsync(HttpMethod.Delete, $"{Mine}/{_passkey.Id}", new { password = TestAccounts.Password });

        Assert.Equal(HttpStatusCode.NoContent, removed.StatusCode);
        await ProblemAssert.IsAsync(await SignInAsync(_factory.CreateApiClient(), _passkey), HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Another_account_s_passkey_is_not_found()
    {
        await AddAsync(await SignedInAsync(), _passkey);
        var other = await SignedInAsync();

        await ProblemAssert.IsAsync(await other.SendAsync(HttpMethod.Patch, $"{Mine}/{_passkey.Id}", new { name = "Mine now" }), HttpStatusCode.NotFound);
        await ProblemAssert.IsAsync(await other.SendAsync(HttpMethod.Delete, $"{Mine}/{_passkey.Id}", new { password = TestAccounts.Password }), HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Adding_and_removing_are_in_the_activity_log()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var client = await TestAccounts.SignedInClientAsync(_factory, user);
        await AddAsync(client, _passkey, "Laptop");
        await client.SendAsync(HttpMethod.Delete, $"{Mine}/{_passkey.Id}", new { password = TestAccounts.Password });

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var actions = await db.AccountActivities.Where(a => a.UserId == user.Id).OrderBy(a => a.Id).Select(a => a.Action).ToListAsync(TestContext.Current.CancellationToken);
        Assert.Equal(["passkey-added", "passkey-removed"], actions.Where(a => a.StartsWith("passkey", StringComparison.Ordinal)));
    }

    [Fact]
    public async Task Listing_passkeys_needs_a_signed_in_account()
    {
        Assert.Equal(HttpStatusCode.Unauthorized, (await _factory.CreateApiClient().GetAsync(Mine)).StatusCode);
    }

    [Fact]
    public async Task A_passkey_confirms_a_sensitive_change_in_place_of_the_password()
    {
        var client = await SignedInAsync();
        await AddAsync(client, _passkey);
        using var second = new SoftwarePasskey();
        await AddAsync(client, second, "Second");
        var stepUp = await ChallengeAsync(client, "step-up");

        var removed = await client.SendAsync(HttpMethod.Delete, $"{Mine}/{second.Id}", new { passkeyChallengeId = stepUp.Id, passkeyCredential = _passkey.Get(stepUp.Options) });

        Assert.Equal(HttpStatusCode.NoContent, removed.StatusCode);
    }

    [Fact]
    public async Task Step_up_options_name_only_the_account_s_passkeys()
    {
        var client = await SignedInAsync();
        await AddAsync(client, _passkey);

        var options = (await ChallengeAsync(client, "step-up")).Options;

        var allowed = Assert.Single(options.GetProperty("allowCredentials").EnumerateArray());
        Assert.Equal(_passkey.Id, allowed.GetProperty("id").GetString());
    }

    [Fact]
    public async Task Another_account_s_passkey_does_not_confirm_a_change()
    {
        var owner = await SignedInAsync();
        await AddAsync(owner, _passkey);
        var client = await SignedInAsync();
        using var mine = new SoftwarePasskey();
        await AddAsync(client, mine);
        var stepUp = await ChallengeAsync(client, "step-up");

        var response = await client.SendAsync(HttpMethod.Delete, $"{Mine}/{mine.Id}", new { passkeyChallengeId = stepUp.Id, passkeyCredential = _passkey.Get(stepUp.Options) });

        var problem = await ProblemAssert.IsAsync(response, HttpStatusCode.BadRequest);
        Assert.True(problem.GetProperty("errors").TryGetProperty("passkey", out _));
    }

    [Fact]
    public async Task A_step_up_challenge_works_once()
    {
        var client = await SignedInAsync();
        await AddAsync(client, _passkey);
        var stepUp = await ChallengeAsync(client, "step-up");
        var answer = _passkey.Get(stepUp.Options);
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(HttpMethod.Delete, "/api/v1/sessions", new { passkeyChallengeId = stepUp.Id, passkeyCredential = answer })).StatusCode);

        var replay = await client.SendAsync(HttpMethod.Delete, "/api/v1/sessions", new { passkeyChallengeId = stepUp.Id, passkeyCredential = answer });

        await ProblemAssert.IsAsync(replay, HttpStatusCode.BadRequest);
    }
}
