using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Runova.Website.Api.Remote;
using Runova.Website.IntegrationTests.Infrastructure;
using static Runova.Website.IntegrationTests.Infrastructure.TestDependencies;
using static Runova.Website.IntegrationTests.Infrastructure.TestRemote;

namespace Runova.Website.IntegrationTests.Remote;

/// <summary>
/// Sending files (E112): a `send` rings only a computer whose app said, on going online, that it
/// takes files; only from an app of the owner or a teammate, and never by password. The hub only
/// passes it on: what an app can do lives with its presence, and a send leaves no record.
/// </summary>
public sealed class RemoteSendTests(PostgresFixture postgres) : IAsyncLifetime
{
    private static readonly string[] _takesFiles = [RemoteFeatures.ReceiveFiles];

    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync() => _factory = new WebsiteApiFactory(await postgres.CreateDatabaseAsync());

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>Sam's desk is online, saying it takes files (or not); Sam's laptop sends.</summary>
    private async Task<(ApiClient Sam, JsonElement Desk, JsonElement Laptop, RemoteApp DeskApp, RemoteApp LaptopApp)> OwnAsync(bool deskTakesFiles = true)
    {
        var (_, sam) = await AccountAsync(_factory);
        var desk = await RegisterAsync(sam, name: "Sam's desk");
        var laptop = await RegisterAsync(sam, name: "Sam's laptop");
        var deskApp = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, sam));
        var laptopApp = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, sam));
        var deskId = desk.GetProperty("id").GetInt64();
        if (deskTakesFiles)
        {
            await deskApp.GoOnlineWithFeaturesAsync(deskId, _takesFiles);
        }
        else
        {
            await deskApp.GoOnlineAsync(deskId);
        }

        return (sam, desk, laptop, deskApp, laptopApp);
    }

    [Fact]
    public async Task A_send_rings_the_owners_other_computer()
    {
        var (_, desk, laptop, deskApp, laptopApp) = await OwnAsync();
        await using var _d = deskApp;
        await using var _l = laptopApp;

        var result = await laptopApp.RequestAsync(desk.GetProperty("remoteId").GetString()!, "ask", laptop.GetProperty("id").GetInt64(), RemoteIntents.Send);
        var incoming = await RemoteApp.NextAsync(deskApp.Incoming);

        Assert.Equal(RemoteConnectStatuses.Ringing, result.Status);
        Assert.Equal("own", result.Relation);
        Assert.Equal(RemoteIntents.Send, incoming.Intent);
        Assert.Equal("Sam's laptop", incoming.Controller.DeviceName);
    }

    [Fact]
    public async Task A_send_rings_a_teammates_computer_shown_to_a_shared_team()
    {
        var (_, sam) = await AccountAsync(_factory);
        var (kimUser, kim) = await AccountAsync(_factory, "Kim");
        var team = await CreateTeamAsync(sam, "Ops");
        await JoinAsync(sam, team, kimUser, kim);
        var desk = await RegisterAsync(sam, name: "Sam's desk");
        await UpdateAsync(sam, desk.GetProperty("id").GetInt64(), new { teamIds = new[] { team } });
        var laptop = await RegisterAsync(kim, name: "Kim's laptop", platform: "macos");
        await using var deskApp = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, sam));
        await using var laptopApp = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, kim));
        await deskApp.GoOnlineWithFeaturesAsync(desk.GetProperty("id").GetInt64(), _takesFiles);

        var result = await laptopApp.RequestAsync(desk.GetProperty("remoteId").GetString()!, "ask", laptop.GetProperty("id").GetInt64(), RemoteIntents.Send);
        var incoming = await RemoteApp.NextAsync(deskApp.Incoming);

        Assert.Equal(RemoteConnectStatuses.Ringing, result.Status);
        Assert.Equal("teammate", incoming.Relation);
        Assert.Equal(["Ops"], incoming.Teams);
    }

    [Fact]
    public async Task A_teammate_sees_a_computer_come_online_ready_for_files()
    {
        var (_, sam) = await AccountAsync(_factory);
        var (kimUser, kim) = await AccountAsync(_factory, "Kim");
        var team = await CreateTeamAsync(sam, "Ops");
        await JoinAsync(sam, team, kimUser, kim);
        var desk = await RegisterAsync(sam, name: "Sam's desk");
        await UpdateAsync(sam, desk.GetProperty("id").GetInt64(), new { teamIds = new[] { team } });
        await using var deskApp = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, sam));
        await using var kimsApp = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, kim));

        await deskApp.GoOnlineWithFeaturesAsync(desk.GetProperty("id").GetInt64(), [RemoteFeatures.ReceiveFiles, "teleport"]);
        var presence = await RemoteApp.NextAsync(kimsApp.Presence);

        Assert.True(presence.Online);
        Assert.Equal(_takesFiles, presence.Features);
    }

    [Fact]
    public async Task A_computer_whose_app_did_not_say_it_takes_files_is_never_rung_for_a_send()
    {
        var (_, desk, laptop, deskApp, laptopApp) = await OwnAsync(deskTakesFiles: false);
        await using var _d = deskApp;
        await using var _l = laptopApp;

        var result = await laptopApp.RequestAsync(desk.GetProperty("remoteId").GetString()!, "ask", laptop.GetProperty("id").GetInt64(), RemoteIntents.Send);

        Assert.Equal(RemoteConnectStatuses.Unavailable, result.Status);
        await RemoteApp.NothingAsync(deskApp.Incoming);
    }

    [Fact]
    public async Task A_send_to_a_computer_that_is_not_online_says_offline()
    {
        var (_, sam) = await AccountAsync(_factory);
        var desk = await RegisterAsync(sam, name: "Sam's desk");
        var laptop = await RegisterAsync(sam, name: "Sam's laptop");
        await using var laptopApp = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, sam));

        var result = await laptopApp.RequestAsync(desk.GetProperty("remoteId").GetString()!, "ask", laptop.GetProperty("id").GetInt64(), RemoteIntents.Send);

        Assert.Equal(RemoteConnectStatuses.Offline, result.Status);
    }

    [Fact]
    public async Task A_send_never_goes_by_password_and_never_from_a_stranger()
    {
        var (sam, desk, _, deskApp, laptopApp) = await OwnAsync();
        await using var _d = deskApp;
        await using var _l = laptopApp;
        await UpdateAsync(sam, desk.GetProperty("id").GetInt64(), new { unattendedEnabled = true });
        var (_, lee) = await AccountAsync(_factory, "Lee");
        var leesLaptop = await RegisterAsync(lee, name: "Lee's laptop");
        await using var leesApp = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, lee));
        var remoteId = desk.GetProperty("remoteId").GetString()!;
        var leesId = leesLaptop.GetProperty("id").GetInt64();

        var asking = await leesApp.RequestAsync(remoteId, "ask", leesId, RemoteIntents.Send);
        var byPassword = await leesApp.RequestAsync(remoteId, "password", leesId, RemoteIntents.Send);

        Assert.Equal(RemoteConnectStatuses.Unavailable, asking.Status);
        Assert.Equal(RemoteConnectStatuses.Unavailable, byPassword.Status);
        await RemoteApp.NothingAsync(deskApp.Incoming);
    }

    [Fact]
    public async Task A_send_needs_the_app_it_comes_from()
    {
        var (sam, desk, _, deskApp, laptopApp) = await OwnAsync();
        await using var _d = deskApp;
        await using var _l = laptopApp;
        var phone = await RegisterAsync(sam, name: "Runova app", platform: "android");
        var remoteId = desk.GetProperty("remoteId").GetString()!;

        var fromNoDevice = await laptopApp.RequestAsync(remoteId, "ask", null, RemoteIntents.Send);
        var fromPhone = await laptopApp.RequestAsync(remoteId, "ask", phone.GetProperty("id").GetInt64(), RemoteIntents.Send);

        Assert.Equal(RemoteConnectStatuses.Unavailable, fromNoDevice.Status);
        Assert.Equal(RemoteConnectStatuses.Unavailable, fromPhone.Status);
        await RemoteApp.NothingAsync(deskApp.Incoming);
    }

    [Fact]
    public async Task A_computer_only_its_background_agent_keeps_online_is_offline_for_a_send()
    {
        var (_, sam) = await AccountAsync(_factory);
        var desk = await RegisterAsync(sam, name: "Sam's desk");
        var laptop = await RegisterAsync(sam, name: "Sam's laptop");
        var deskId = desk.GetProperty("id").GetInt64();
        var remoteId = desk.GetProperty("remoteId").GetString()!;
        var created = await ApiClient.ReadJsonAsync(
            await sam.SendAsync(HttpMethod.Post, $"/api/v1/remote-devices/{deskId}/agents", new { identityKey = NewIdentityKey() }),
            HttpStatusCode.Created);
        var token = await ApiClient.ReadJsonAsync(
            await _factory.CreateClient().PostAsJsonAsync("/api/v1/remote-agent-tokens", new { remoteId, secret = created.GetProperty("agentSecret").GetString() }, Ct),
            HttpStatusCode.OK);
        await using var agent = await ConnectAsync(_factory, token.GetProperty("accessToken").GetString()!);
        // An agent that claims it takes files is not believed: it only shows the screen.
        await agent.GoOnlineWithFeaturesAsync(deskId, _takesFiles);
        await using var laptopApp = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, sam));

        var result = await laptopApp.RequestAsync(remoteId, "ask", laptop.GetProperty("id").GetInt64(), RemoteIntents.Send);

        Assert.Equal(RemoteConnectStatuses.Offline, result.Status);
        await RemoteApp.NothingAsync(agent.Incoming);
    }

    [Fact]
    public async Task A_send_leaves_no_record_behind()
    {
        var (sam, desk, laptop, deskApp, laptopApp) = await OwnAsync();
        await using var _d = deskApp;
        await using var _l = laptopApp;
        await laptopApp.RequestAsync(desk.GetProperty("remoteId").GetString()!, "ask", laptop.GetProperty("id").GetInt64(), RemoteIntents.Send);
        var sessionId = (await RemoteApp.NextAsync(deskApp.Incoming)).SessionId;

        await deskApp.RespondAsync(sessionId, accept: true);
        await RemoteApp.NextAsync(laptopApp.Resolved);
        await deskApp.ConnectedAsync(sessionId, "relay");
        await laptopApp.EndAsync(sessionId);
        await RemoteApp.NextAsync(deskApp.Ended);

        var sessions = await ApiClient.ReadJsonAsync(await sam.GetAsync("/api/v1/remote-sessions"), HttpStatusCode.OK);
        Assert.Empty(sessions.GetProperty("items").EnumerateArray());
    }

    [Fact]
    public async Task The_directory_says_which_online_computers_take_files_and_forgets_it_when_they_go()
    {
        var (sam, desk, laptop, deskApp, laptopApp) = await OwnAsync();
        await using var _l = laptopApp;
        await laptopApp.GoOnlineAsync(laptop.GetProperty("id").GetInt64());

        var features = await FeaturesAsync(sam);
        Assert.Equal(_takesFiles, features["Sam's desk"]);
        Assert.Equal([], features["Sam's laptop"]);

        await deskApp.DisposeAsync();
        await WaitUntilAsync(async () => (await FeaturesAsync(sam))["Sam's desk"].Length == 0);
        Assert.False(desk.GetProperty("online").GetBoolean());
    }

    private static async Task<Dictionary<string, string?[]>> FeaturesAsync(ApiClient client)
    {
        var directory = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/reachable-devices"), HttpStatusCode.OK);
        return directory.GetProperty("mine").EnumerateArray().ToDictionary(
            e => e.GetProperty("name").GetString()!,
            e => e.GetProperty("features").EnumerateArray().Select(f => f.GetString()).ToArray());
    }

    private static async Task WaitUntilAsync(Func<Task<bool>> condition)
    {
        for (var i = 0; i < 100; i++)
        {
            if (await condition())
            {
                return;
            }

            await Task.Delay(100, Ct);
        }

        Assert.Fail("The condition did not come true in time.");
    }
}
