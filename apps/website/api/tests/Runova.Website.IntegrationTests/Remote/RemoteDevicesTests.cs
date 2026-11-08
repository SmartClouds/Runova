using System.Net;
using Runova.Website.IntegrationTests.Infrastructure;
using static Runova.Website.IntegrationTests.Infrastructure.TestDependencies;
using static Runova.Website.IntegrationTests.Infrastructure.TestRemote;

namespace Runova.Website.IntegrationTests.Remote;

/// <summary>Registering computers, their access settings, and who sees which (E60).</summary>
public sealed class RemoteDevicesTests(PostgresFixture postgres) : IAsyncLifetime
{
    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync() => _factory = new WebsiteApiFactory(await postgres.CreateDatabaseAsync());

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    [Fact]
    public async Task A_computer_gets_a_runova_id_once_and_keeps_it()
    {
        var (_, sam) = await AccountAsync(_factory);
        var deviceId = Guid.NewGuid();
        var key = NewIdentityKey();

        var first = await sam.SendAsync(HttpMethod.Post, "/api/v1/remote-devices", new { deviceId, name = "Sam's laptop", platform = "windows", identityKey = key });
        var created = await ApiClient.ReadJsonAsync(first, HttpStatusCode.Created);
        var again = await ApiClient.ReadJsonAsync(
            await sam.SendAsync(HttpMethod.Post, "/api/v1/remote-devices", new { deviceId, name = "Sam's new name", platform = "windows", identityKey = key }),
            HttpStatusCode.OK);

        Assert.Matches("^[1-9][0-9]{8}$", created.GetProperty("remoteId").GetString());
        Assert.Equal(created.GetProperty("remoteId").GetString(), again.GetProperty("remoteId").GetString());
        Assert.Equal(created.GetProperty("id").GetInt64(), again.GetProperty("id").GetInt64());
        Assert.Equal("Sam's new name", again.GetProperty("name").GetString());
        Assert.Equal($"/api/v1/remote-devices/{created.GetProperty("id").GetInt64()}", first.Headers.Location?.OriginalString);
    }

    [Fact]
    public async Task A_new_computer_takes_nothing_until_its_owner_allows_it()
    {
        var (_, sam) = await AccountAsync(_factory);

        var device = await RegisterAsync(sam);

        Assert.False(device.GetProperty("allowOwnDevices").GetBoolean());
        Assert.False(device.GetProperty("unattendedEnabled").GetBoolean());
        Assert.Empty(device.GetProperty("teamIds").EnumerateArray());
        Assert.False(device.GetProperty("online").GetBoolean());
    }

    [Theory]
    [InlineData("", "windows", true)]
    [InlineData("Laptop", "amiga", true)]
    [InlineData("Laptop", "windows", false)]
    public async Task A_bad_registration_is_refused(string name, string platform, bool goodKey)
    {
        var (_, sam) = await AccountAsync(_factory);

        var response = await sam.SendAsync(HttpMethod.Post, "/api/v1/remote-devices", new
        {
            deviceId = Guid.NewGuid(),
            name,
            platform,
            identityKey = goodKey ? NewIdentityKey() : "not-a-key",
        });

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), "/api/v1/remote-devices");
    }

    [Fact]
    public async Task A_phone_registers_but_is_never_listed_as_a_computer()
    {
        var (_, sam) = await AccountAsync(_factory);

        var phone = await RegisterAsync(sam, name: "Runova app", platform: "ios");
        var devices = await ApiClient.ReadJsonAsync(await sam.GetAsync("/api/v1/remote-devices"), HttpStatusCode.OK);
        var directory = await ApiClient.ReadJsonAsync(await sam.GetAsync("/api/v1/reachable-devices"), HttpStatusCode.OK);

        Assert.Equal("phone", phone.GetProperty("kind").GetString());
        Assert.Empty(devices.GetProperty("items").EnumerateArray());
        Assert.Empty(directory.GetProperty("mine").EnumerateArray());
    }

    [Fact]
    public async Task A_phone_can_not_be_shown_to_a_team()
    {
        var (_, sam) = await AccountAsync(_factory);
        var team = await CreateTeamAsync(sam, "Ops");
        var phone = await RegisterAsync(sam, name: "Runova app", platform: "android");

        var response = await sam.SendAsync(HttpMethod.Patch, $"/api/v1/remote-devices/{phone.GetProperty("id").GetInt64()}", new { teamIds = new[] { team } });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Each_account_lists_only_its_own_computers()
    {
        var (_, sam) = await AccountAsync(_factory);
        var (_, kim) = await AccountAsync(_factory, "Kim");
        await RegisterAsync(sam, name: "Desk");
        await RegisterAsync(sam, name: "Laptop", platform: "macos");
        await RegisterAsync(kim, name: "Kim's");

        var list = await ApiClient.ReadJsonAsync(await sam.GetAsync("/api/v1/remote-devices"), HttpStatusCode.OK);

        Assert.Equal(["Desk", "Laptop"], list.GetProperty("items").EnumerateArray().Select(d => d.GetProperty("name").GetString()).Order());
    }

    [Fact]
    public async Task The_owner_changes_the_access_settings()
    {
        var (_, sam) = await AccountAsync(_factory);
        var teamId = await CreateTeamAsync(sam);
        var device = await RegisterAsync(sam);

        var updated = await UpdateAsync(sam, device.GetProperty("id").GetInt64(), new { allowOwnDevices = true, unattendedEnabled = true, teamIds = new[] { teamId }, name = "Desk" });
        var partly = await UpdateAsync(sam, device.GetProperty("id").GetInt64(), new { unattendedEnabled = false });

        Assert.True(updated.GetProperty("allowOwnDevices").GetBoolean());
        Assert.True(updated.GetProperty("unattendedEnabled").GetBoolean());
        Assert.Equal([teamId], updated.GetProperty("teamIds").EnumerateArray().Select(t => t.GetInt64()));
        Assert.Equal("Desk", updated.GetProperty("name").GetString());
        Assert.True(partly.GetProperty("allowOwnDevices").GetBoolean());
        Assert.False(partly.GetProperty("unattendedEnabled").GetBoolean());
        Assert.Equal([teamId], partly.GetProperty("teamIds").EnumerateArray().Select(t => t.GetInt64()));
    }

    [Fact]
    public async Task A_computer_can_be_shown_only_to_the_owners_own_teams()
    {
        var (_, sam) = await AccountAsync(_factory);
        var (_, kim) = await AccountAsync(_factory, "Kim");
        var kimsTeam = await CreateTeamAsync(kim, "Kim's team");
        var device = await RegisterAsync(sam);

        var response = await sam.SendAsync(HttpMethod.Patch, $"/api/v1/remote-devices/{device.GetProperty("id").GetInt64()}", new { teamIds = new[] { kimsTeam } });

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), $"/api/v1/remote-devices/{device.GetProperty("id").GetInt64()}");
    }

    [Fact]
    public async Task Another_accounts_computer_is_not_found()
    {
        var (_, sam) = await AccountAsync(_factory);
        var (_, kim) = await AccountAsync(_factory, "Kim");
        var device = await RegisterAsync(sam);
        var id = device.GetProperty("id").GetInt64();

        Assert.Equal(HttpStatusCode.NotFound, (await kim.SendAsync(HttpMethod.Patch, $"/api/v1/remote-devices/{id}", new { unattendedEnabled = true })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await kim.SendAsync(HttpMethod.Delete, $"/api/v1/remote-devices/{id}")).StatusCode);
    }

    [Fact]
    public async Task A_removed_computer_loses_its_id_for_good()
    {
        var (_, sam) = await AccountAsync(_factory);
        var deviceId = Guid.NewGuid();
        var device = await RegisterAsync(sam, deviceId);

        Assert.Equal(HttpStatusCode.NoContent, (await sam.SendAsync(HttpMethod.Delete, $"/api/v1/remote-devices/{device.GetProperty("id").GetInt64()}")).StatusCode);
        var list = await ApiClient.ReadJsonAsync(await sam.GetAsync("/api/v1/remote-devices"), HttpStatusCode.OK);
        var again = await RegisterAsync(sam, deviceId);

        Assert.Empty(list.GetProperty("items").EnumerateArray());
        Assert.NotEqual(device.GetProperty("remoteId").GetString(), again.GetProperty("remoteId").GetString());
    }

    [Fact]
    public async Task The_directory_shows_my_computers_and_teammates_computers_shown_to_a_shared_team()
    {
        var (_, sam) = await AccountAsync(_factory);
        var (kimUser, kim) = await AccountAsync(_factory, "Kim");
        var (_, lee) = await AccountAsync(_factory, "Lee");
        var team = await CreateTeamAsync(sam, "Ops");
        await JoinAsync(sam, team, kimUser, kim);
        var shown = await RegisterAsync(kim, name: "Kim's desk");
        await RegisterAsync(kim, name: "Kim's private laptop");
        await UpdateAsync(kim, shown.GetProperty("id").GetInt64(), new { teamIds = new[] { team } });
        await RegisterAsync(lee, name: "Lee's");
        await RegisterAsync(sam, name: "Sam's");

        var directory = await ApiClient.ReadJsonAsync(await sam.GetAsync("/api/v1/reachable-devices"), HttpStatusCode.OK);

        Assert.Equal(["Sam's"], directory.GetProperty("mine").EnumerateArray().Select(d => d.GetProperty("name").GetString()));
        var teammate = Assert.Single(directory.GetProperty("teammates").EnumerateArray());
        Assert.Equal("Kim's desk", teammate.GetProperty("name").GetString());
        Assert.Equal("Kim", teammate.GetProperty("owner").GetProperty("displayName").GetString());
        Assert.Equal(["Ops"], teammate.GetProperty("teams").EnumerateArray().Select(t => t.GetProperty("name").GetString()));
        Assert.Equal(shown.GetProperty("identityKey").GetString(), teammate.GetProperty("identityKey").GetString());
    }

    [Fact]
    public async Task Leaving_the_team_hides_the_computer_from_it()
    {
        var (_, sam) = await AccountAsync(_factory);
        var (kimUser, kim) = await AccountAsync(_factory, "Kim");
        var team = await CreateTeamAsync(sam, "Ops");
        await JoinAsync(sam, team, kimUser, kim);
        var shown = await RegisterAsync(kim, name: "Kim's desk");
        await UpdateAsync(kim, shown.GetProperty("id").GetInt64(), new { teamIds = new[] { team } });

        Assert.Equal(HttpStatusCode.NoContent, (await kim.SendAsync(HttpMethod.Delete, $"/api/v1/teams/{team}/members/{kimUser.Id}", new { })).StatusCode);
        var directory = await ApiClient.ReadJsonAsync(await sam.GetAsync("/api/v1/reachable-devices"), HttpStatusCode.OK);

        Assert.Empty(directory.GetProperty("teammates").EnumerateArray());
    }

    [Fact]
    public async Task Signed_out_callers_get_nothing()
    {
        var anonymous = _factory.CreateApiClient();

        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/v1/remote-devices")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/v1/reachable-devices")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/v1/remote-sessions")).StatusCode);
    }
}
