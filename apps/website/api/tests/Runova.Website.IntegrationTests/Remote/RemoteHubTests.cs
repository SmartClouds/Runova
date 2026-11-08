using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using Runova.Website.Api.Remote;
using Runova.Website.IntegrationTests.Infrastructure;
using static Runova.Website.IntegrationTests.Infrastructure.TestDependencies;
using static Runova.Website.IntegrationTests.Infrastructure.TestRemote;

namespace Runova.Website.IntegrationTests.Remote;

/// <summary>Presence, connection requests, signaling and session records through the remote hub (E60).</summary>
public sealed class RemoteHubTests(PostgresFixture postgres) : IAsyncLifetime
{
    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync() => _factory = new WebsiteApiFactory(await postgres.CreateDatabaseAsync());

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    /// <summary>Sam hosts a computer shown to the Ops team, which Kim is in. Both apps are on the hub.</summary>
    private async Task<Pair> TeammatesAsync(bool hostOnline = true)
    {
        var (_, sam) = await AccountAsync(_factory);
        var (kimUser, kim) = await AccountAsync(_factory, "Kim");
        var team = await CreateTeamAsync(sam, "Ops");
        await JoinAsync(sam, team, kimUser, kim);
        var host = await RegisterAsync(sam, name: "Sam's desk");
        await UpdateAsync(sam, host.GetProperty("id").GetInt64(), new { teamIds = new[] { team } });
        var controllerDevice = await RegisterAsync(kim, name: "Kim's laptop", platform: "macos");
        var hostApp = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, sam));
        var controllerApp = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, kim));
        if (hostOnline)
        {
            await hostApp.GoOnlineAsync(host.GetProperty("id").GetInt64());
        }

        return new Pair(sam, kim, host, controllerDevice, hostApp, controllerApp);
    }

    private sealed record Pair(ApiClient Sam, ApiClient Kim, JsonElement Host, JsonElement ControllerDevice, RemoteApp HostApp, RemoteApp ControllerApp) : IAsyncDisposable
    {
        public string HostRemoteId => Host.GetProperty("remoteId").GetString()!;

        public long ControllerDeviceId => ControllerDevice.GetProperty("id").GetInt64();

        public async ValueTask DisposeAsync()
        {
            await HostApp.DisposeAsync();
            await ControllerApp.DisposeAsync();
        }
    }

    [Fact]
    public async Task A_phone_can_not_go_online_or_be_connected_to()
    {
        var (_, sam) = await AccountAsync(_factory);
        var phone = await RegisterAsync(sam, name: "Runova app", platform: "android");
        var desk = await RegisterAsync(sam, name: "Sam's desk");
        await using var app = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, sam));

        await Assert.ThrowsAsync<HubException>(() => app.GoOnlineAsync(phone.GetProperty("id").GetInt64()));
        var result = await app.RequestAsync(phone.GetProperty("remoteId").GetString()!, "ask", desk.GetProperty("id").GetInt64());

        Assert.Equal(RemoteConnectStatuses.Unavailable, result.Status);
    }

    [Fact]
    public async Task A_phone_asks_to_manage_its_owners_computer_and_the_computer_gets_its_key()
    {
        var (_, sam) = await AccountAsync(_factory);
        var desk = await RegisterAsync(sam, name: "Sam's desk");
        var key = NewIdentityKey();
        var phone = await RegisterAsync(sam, name: "Runova app", platform: "ios", identityKey: key);
        await using var deskApp = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, sam));
        await using var phoneApp = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, sam));
        await deskApp.GoOnlineAsync(desk.GetProperty("id").GetInt64());

        var result = await phoneApp.RequestAsync(desk.GetProperty("remoteId").GetString()!, "ask", phone.GetProperty("id").GetInt64(), RemoteIntents.Manage);
        var incoming = await RemoteApp.NextAsync(deskApp.Incoming);

        Assert.Equal(RemoteConnectStatuses.Ringing, result.Status);
        Assert.Equal(RemoteIntents.Manage, incoming.Intent);
        Assert.Equal(key, incoming.Controller.IdentityKey);
        Assert.Equal("ios", incoming.Controller.Platform);
    }

    [Fact]
    public async Task Only_the_owners_phone_can_ask_to_manage_a_computer()
    {
        await using var pair = await TeammatesAsync();
        var kimsPhone = await RegisterAsync(pair.Kim, name: "Runova app", platform: "android");

        var fromLaptop = await pair.ControllerApp.RequestAsync(pair.HostRemoteId, "ask", pair.ControllerDeviceId, RemoteIntents.Manage);
        var fromTeammatesPhone = await pair.ControllerApp.RequestAsync(pair.HostRemoteId, "ask", kimsPhone.GetProperty("id").GetInt64(), RemoteIntents.Manage);
        var fromNoDevice = await pair.ControllerApp.RequestAsync(pair.HostRemoteId, "ask", null, RemoteIntents.Manage);

        Assert.Equal(RemoteConnectStatuses.Unavailable, fromLaptop.Status);
        Assert.Equal(RemoteConnectStatuses.Unavailable, fromTeammatesPhone.Status);
        Assert.Equal(RemoteConnectStatuses.Unavailable, fromNoDevice.Status);
        await RemoteApp.NothingAsync(pair.HostApp.Incoming);
    }

    [Fact]
    public async Task An_app_can_only_go_online_for_its_own_account_computer()
    {
        var (_, sam) = await AccountAsync(_factory);
        var (_, kim) = await AccountAsync(_factory, "Kim");
        var samsDevice = await RegisterAsync(sam);
        await using var kimsApp = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, kim));

        await Assert.ThrowsAsync<HubException>(() => kimsApp.GoOnlineAsync(samsDevice.GetProperty("id").GetInt64()));
    }

    [Fact]
    public async Task Going_online_shows_in_the_directory()
    {
        await using var pair = await TeammatesAsync();

        var directory = await ApiClient.ReadJsonAsync(await pair.Kim.GetAsync("/api/v1/reachable-devices"), HttpStatusCode.OK);
        var mine = await ApiClient.ReadJsonAsync(await pair.Sam.GetAsync("/api/v1/remote-devices"), HttpStatusCode.OK);

        Assert.True(Assert.Single(directory.GetProperty("teammates").EnumerateArray()).GetProperty("online").GetBoolean());
        Assert.True(Assert.Single(mine.GetProperty("items").EnumerateArray()).GetProperty("online").GetBoolean());
    }

    [Fact]
    public async Task A_teammate_rings_and_the_host_sees_who_is_asking()
    {
        await using var pair = await TeammatesAsync();

        var result = await pair.ControllerApp.RequestAsync(pair.HostRemoteId, "ask", pair.ControllerDeviceId);
        var incoming = await RemoteApp.NextAsync(pair.HostApp.Incoming);

        Assert.Equal("ringing", result.Status);
        Assert.Equal("teammate", result.Relation);
        Assert.Equal("Sam's desk", result.Host!.Name);
        Assert.Equal(pair.Host.GetProperty("identityKey").GetString(), result.Host.IdentityKey);
        Assert.Equal(result.SessionId, incoming.SessionId);
        Assert.Equal("ask", incoming.Mode);
        Assert.Equal("teammate", incoming.Relation);
        Assert.Equal("control", incoming.Intent);
        Assert.Equal("Kim", incoming.Controller.DisplayName);
        Assert.Equal("Kim's laptop", incoming.Controller.DeviceName);
        Assert.Equal(pair.ControllerDevice.GetProperty("identityKey").GetString(), incoming.Controller.IdentityKey);
        Assert.Equal(["Ops"], incoming.Teams);
    }

    /// <summary>Everything on the hub needs a Runova account: presence, connecting and relay tickets.</summary>
    [Theory]
    [InlineData(null)]
    [InlineData("not-a-real-token")]
    public async Task The_hub_turns_away_anyone_not_signed_in(string? token)
    {
        using var client = _factory.CreateClient();
        var query = token is null ? string.Empty : $"&access_token={token}";

        var response = await client.PostAsync(new Uri($"{RemoteHub.Path}/negotiate?negotiateVersion=1{query}", UriKind.Relative), null, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    /// <summary>Ending a computer's sign-in, from anywhere, takes it off the hub and ends its sessions.</summary>
    [Fact]
    public async Task Ending_the_sign_in_drops_the_computer_and_tells_the_other_side()
    {
        await using var pair = await TeammatesAsync();
        await pair.ControllerApp.RequestAsync(pair.HostRemoteId, "ask", pair.ControllerDeviceId);
        var sessionId = (await RemoteApp.NextAsync(pair.HostApp.Incoming)).SessionId;
        await pair.HostApp.RespondAsync(sessionId, accept: true);
        await RemoteApp.NextAsync(pair.ControllerApp.Resolved);
        var signIns = await ApiClient.ReadJsonAsync(await pair.Sam.GetAsync("/api/v1/sessions"), HttpStatusCode.OK);
        var desktop = signIns.GetProperty("items").EnumerateArray().Single(s => s.GetProperty("kind").GetString() == "desktop");

        await pair.Sam.SendAsync(HttpMethod.Delete, $"/api/v1/sessions/{desktop.GetProperty("id").GetInt64()}");

        await pair.HostApp.ClosedAsync();
        Assert.Equal(sessionId, (await RemoteApp.NextAsync(pair.ControllerApp.Ended)).SessionId);
        Assert.Equal(Microsoft.AspNetCore.SignalR.Client.HubConnectionState.Connected, pair.ControllerApp.Hub.State);
    }

    [Fact]
    public async Task Accepting_lets_the_two_signal_and_the_host_records_the_session()
    {
        await using var pair = await TeammatesAsync();
        var result = await pair.ControllerApp.RequestAsync(pair.HostRemoteId, "ask", pair.ControllerDeviceId);
        var sessionId = (await RemoteApp.NextAsync(pair.HostApp.Incoming)).SessionId;

        await pair.HostApp.RespondAsync(sessionId, accept: true);
        var resolved = await RemoteApp.NextAsync(pair.ControllerApp.Resolved);
        await pair.ControllerApp.SignalAsync(sessionId, "{\"t\":\"rtc-request\"}");
        var atHost = await RemoteApp.NextAsync(pair.HostApp.Signals);
        await pair.HostApp.SignalAsync(sessionId, "{\"t\":\"rtc-offer\"}");
        var atController = await RemoteApp.NextAsync(pair.ControllerApp.Signals);
        await pair.HostApp.ConnectedAsync(sessionId, "direct");

        Assert.Equal(new RequestResolvedDto(result.SessionId!, true, null), resolved);
        Assert.Equal((sessionId, "{\"t\":\"rtc-request\"}"), atHost);
        Assert.Equal((sessionId, "{\"t\":\"rtc-offer\"}"), atController);
        foreach (var (client, role) in new[] { (pair.Sam, "host"), (pair.Kim, "controller") })
        {
            var sessions = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/remote-sessions"), HttpStatusCode.OK);
            var record = Assert.Single(sessions.GetProperty("items").EnumerateArray());
            Assert.Equal(role, record.GetProperty("role").GetString());
            Assert.Equal("direct", record.GetProperty("transport").GetString());
            Assert.Equal("Sam's desk", record.GetProperty("hostName").GetString());
            Assert.Equal("Kim", record.GetProperty("controllerName").GetString());
            Assert.Equal(JsonValueKind.Null, record.GetProperty("endedAt").ValueKind);
        }
    }

    [Fact]
    public async Task Ending_tells_the_other_side_and_closes_the_record()
    {
        await using var pair = await TeammatesAsync();
        await pair.ControllerApp.RequestAsync(pair.HostRemoteId, "ask", pair.ControllerDeviceId);
        var sessionId = (await RemoteApp.NextAsync(pair.HostApp.Incoming)).SessionId;
        await pair.HostApp.RespondAsync(sessionId, accept: true);
        await pair.HostApp.ConnectedAsync(sessionId, "relay");

        await pair.ControllerApp.EndAsync(sessionId);
        var ended = await RemoteApp.NextAsync(pair.HostApp.Ended);

        Assert.Equal(new SessionEndedDto(sessionId, "ended"), ended);
        var sessions = await ApiClient.ReadJsonAsync(await pair.Sam.GetAsync("/api/v1/remote-sessions"), HttpStatusCode.OK);
        Assert.NotEqual(JsonValueKind.Null, Assert.Single(sessions.GetProperty("items").EnumerateArray()).GetProperty("endedAt").ValueKind);
    }

    [Fact]
    public async Task Declining_tells_the_controller_and_leaves_no_record()
    {
        await using var pair = await TeammatesAsync();
        await pair.ControllerApp.RequestAsync(pair.HostRemoteId, "ask", pair.ControllerDeviceId);
        var sessionId = (await RemoteApp.NextAsync(pair.HostApp.Incoming)).SessionId;

        await pair.HostApp.RespondAsync(sessionId, accept: false);
        var resolved = await RemoteApp.NextAsync(pair.ControllerApp.Resolved);

        Assert.Equal(new RequestResolvedDto(sessionId, false, "declined"), resolved);
        await Assert.ThrowsAsync<HubException>(() => pair.ControllerApp.SignalAsync(sessionId, "{}"));
        var sessions = await ApiClient.ReadJsonAsync(await pair.Sam.GetAsync("/api/v1/remote-sessions"), HttpStatusCode.OK);
        Assert.Empty(sessions.GetProperty("items").EnumerateArray());
    }

    [Fact]
    public async Task No_signal_passes_before_the_host_accepts_or_from_outside_the_session()
    {
        await using var pair = await TeammatesAsync();
        await pair.ControllerApp.RequestAsync(pair.HostRemoteId, "ask", pair.ControllerDeviceId);
        var sessionId = (await RemoteApp.NextAsync(pair.HostApp.Incoming)).SessionId;
        var (_, lee) = await AccountAsync(_factory, "Lee");
        await using var leesApp = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, lee));

        await Assert.ThrowsAsync<HubException>(() => pair.ControllerApp.SignalAsync(sessionId, "{}"));
        await pair.HostApp.RespondAsync(sessionId, accept: true);
        await Assert.ThrowsAsync<HubException>(() => leesApp.SignalAsync(sessionId, "{}"));
        await Assert.ThrowsAsync<HubException>(() => leesApp.RespondAsync(sessionId, true));
        await Assert.ThrowsAsync<HubException>(() => pair.ControllerApp.ConnectedAsync(sessionId, "direct"));
        await RemoteApp.NothingAsync(pair.HostApp.Signals);
    }

    [Fact]
    public async Task An_oversized_signal_is_refused()
    {
        await using var pair = await TeammatesAsync();
        await pair.ControllerApp.RequestAsync(pair.HostRemoteId, "ask", pair.ControllerDeviceId);
        var sessionId = (await RemoteApp.NextAsync(pair.HostApp.Incoming)).SessionId;
        await pair.HostApp.RespondAsync(sessionId, accept: true);

        var refused = await Assert.ThrowsAsync<HubException>(() => pair.ControllerApp.SignalAsync(sessionId, new string('x', RemoteLimits.MaxSignalLength + 1)));

        Assert.Contains("too large", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_largest_signal_arrives_even_when_every_character_needs_escaping()
    {
        await using var pair = await TeammatesAsync();
        await pair.ControllerApp.RequestAsync(pair.HostRemoteId, "ask", pair.ControllerDeviceId);
        var sessionId = (await RemoteApp.NextAsync(pair.HostApp.Incoming)).SessionId;
        await pair.HostApp.RespondAsync(sessionId, accept: true);
        var payload = new string('"', RemoteLimits.MaxSignalLength);

        await pair.ControllerApp.SignalAsync(sessionId, payload);

        Assert.Equal((sessionId, payload), await RemoteApp.NextAsync(pair.HostApp.Signals));
    }

    [Fact]
    public async Task The_host_going_away_ends_the_session_for_the_controller()
    {
        await using var pair = await TeammatesAsync();
        await pair.ControllerApp.RequestAsync(pair.HostRemoteId, "ask", pair.ControllerDeviceId);
        var sessionId = (await RemoteApp.NextAsync(pair.HostApp.Incoming)).SessionId;
        await pair.HostApp.RespondAsync(sessionId, accept: true);

        await pair.HostApp.Hub.StopAsync(TestContext.Current.CancellationToken);
        var ended = await RemoteApp.NextAsync(pair.ControllerApp.Ended);

        Assert.Equal(new SessionEndedDto(sessionId, "left"), ended);
    }

    [Fact]
    public async Task A_teammate_sees_an_offline_computer_as_offline()
    {
        await using var pair = await TeammatesAsync(hostOnline: false);

        var result = await pair.ControllerApp.RequestAsync(pair.HostRemoteId);

        Assert.Equal("offline", result.Status);
        Assert.Null(result.SessionId);
    }

    [Fact]
    public async Task A_stranger_can_not_ask_and_can_not_tell_a_real_id_from_a_made_up_one()
    {
        var (_, sam) = await AccountAsync(_factory);
        var (_, lee) = await AccountAsync(_factory, "Lee");
        var host = await RegisterAsync(sam);
        await using var hostApp = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, sam));
        await hostApp.GoOnlineAsync(host.GetProperty("id").GetInt64());
        await using var leesApp = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, lee));

        var asking = await leesApp.RequestAsync(host.GetProperty("remoteId").GetString()!, "ask");
        var password = await leesApp.RequestAsync(host.GetProperty("remoteId").GetString()!, "password");
        var madeUp = await leesApp.RequestAsync("999999999", "password");
        var notAnId = await leesApp.RequestAsync("hello", "password");

        Assert.All(new[] { asking, password, madeUp, notAnId }, r => Assert.Equal(new ConnectResultDto("unavailable", null, null, null), r));
        await RemoteApp.NothingAsync(hostApp.Incoming);
    }

    [Fact]
    public async Task With_unattended_access_on_a_stranger_rings_with_the_password_mode_and_sees_no_name()
    {
        var (_, sam) = await AccountAsync(_factory);
        var (_, lee) = await AccountAsync(_factory, "Lee");
        var host = await RegisterAsync(sam, name: "Sam's desk");
        await UpdateAsync(sam, host.GetProperty("id").GetInt64(), new { unattendedEnabled = true });
        await using var hostApp = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, sam));
        await hostApp.GoOnlineAsync(host.GetProperty("id").GetInt64());
        await using var leesApp = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, lee));

        var result = await leesApp.RequestAsync(host.GetProperty("remoteId").GetString()!, "password", intent: "files");
        var incoming = await RemoteApp.NextAsync(hostApp.Incoming);

        Assert.Equal("ringing", result.Status);
        Assert.Equal("other", result.Relation);
        Assert.Equal("", result.Host!.Name);
        Assert.Equal("password", incoming.Mode);
        Assert.Equal("other", incoming.Relation);
        Assert.Equal("files", incoming.Intent);
        Assert.Empty(incoming.Teams);
        Assert.Null(incoming.Controller.DeviceName);
    }

    [Fact]
    public async Task A_controller_can_not_claim_another_accounts_computer_as_its_own()
    {
        await using var pair = await TeammatesAsync();

        var result = await pair.ControllerApp.RequestAsync(pair.HostRemoteId, "ask", fromDeviceId: pair.Host.GetProperty("id").GetInt64());
        var incoming = await RemoteApp.NextAsync(pair.HostApp.Incoming);

        Assert.Equal("ringing", result.Status);
        Assert.Null(incoming.Controller.DeviceName);
        Assert.Null(incoming.Controller.IdentityKey);
    }

    [Fact]
    public async Task Calling_a_computer_from_itself_is_pointless()
    {
        var (_, sam) = await AccountAsync(_factory);
        var host = await RegisterAsync(sam);
        await using var hostApp = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, sam));
        await hostApp.GoOnlineAsync(host.GetProperty("id").GetInt64());

        var result = await hostApp.RequestAsync(host.GetProperty("remoteId").GetString()!, "ask", host.GetProperty("id").GetInt64());

        Assert.Equal("self", result.Status);
    }

    [Fact]
    public async Task Too_many_requests_are_turned_away()
    {
        await using var pair = await TeammatesAsync();
        ConnectResultDto? last = null;

        for (var i = 0; i <= RemoteLimits.RequestsPerAccount; i++)
        {
            last = await pair.ControllerApp.RequestAsync(pair.HostRemoteId);
            if (last.SessionId is { } id)
            {
                await pair.HostApp.RespondAsync(id, accept: false);
            }
        }

        Assert.Equal("rate-limited", last!.Status);
    }

    [Fact]
    public async Task Teammates_hear_when_a_shown_computer_comes_and_goes()
    {
        await using var pair = await TeammatesAsync(hostOnline: false);

        await pair.HostApp.GoOnlineAsync(pair.Host.GetProperty("id").GetInt64());
        var online = await RemoteApp.NextAsync(pair.ControllerApp.Presence);
        await pair.HostApp.Hub.StopAsync(TestContext.Current.CancellationToken);
        var offline = await RemoteApp.NextAsync(pair.ControllerApp.Presence);

        Assert.Equal(new PresenceChangedDto(pair.Host.GetProperty("id").GetInt64(), pair.HostRemoteId, true), online);
        Assert.Equal(new PresenceChangedDto(pair.Host.GetProperty("id").GetInt64(), pair.HostRemoteId, false), offline);
    }

    [Fact]
    public async Task Either_side_can_delete_a_record()
    {
        await using var pair = await TeammatesAsync();
        await pair.ControllerApp.RequestAsync(pair.HostRemoteId, "ask", pair.ControllerDeviceId);
        var sessionId = (await RemoteApp.NextAsync(pair.HostApp.Incoming)).SessionId;
        await pair.HostApp.RespondAsync(sessionId, accept: true);
        await pair.HostApp.ConnectedAsync(sessionId, "direct");
        var sessions = await ApiClient.ReadJsonAsync(await pair.Kim.GetAsync("/api/v1/remote-sessions"), HttpStatusCode.OK);
        var id = Assert.Single(sessions.GetProperty("items").EnumerateArray()).GetProperty("id").GetInt64();

        Assert.Equal(HttpStatusCode.NoContent, (await pair.Kim.SendAsync(HttpMethod.Delete, $"/api/v1/remote-sessions/{id}")).StatusCode);

        var afterwards = await ApiClient.ReadJsonAsync(await pair.Sam.GetAsync("/api/v1/remote-sessions"), HttpStatusCode.OK);
        Assert.Empty(afterwards.GetProperty("items").EnumerateArray());
    }
}
