using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using Runova.Website.Api.Remote;
using Runova.Website.IntegrationTests.Infrastructure;
using static Runova.Website.IntegrationTests.Infrastructure.TestDependencies;
using static Runova.Website.IntegrationTests.Infrastructure.TestRemote;

namespace Runova.Website.IntegrationTests.Remote;

/// <summary>
/// Files sent to a phone (E114): a phone goes online only to take files, and only while its app is
/// open; only its owner's own devices can send to it, and only a `send` rings it. Like every send,
/// nothing of it is stored: the phone's presence and what it takes live in memory and go with its
/// connection.
/// </summary>
public sealed class RemotePhoneReceiveTests(PostgresFixture postgres) : IAsyncLifetime
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

    /// <summary>Sam's phone is open and takes files; Sam's desk is online to send to it.</summary>
    private async Task<(ApiClient Sam, JsonElement Phone, JsonElement Desk, RemoteApp PhoneHub, RemoteApp DeskApp)> PhoneOnlineAsync()
    {
        var (_, sam) = await AccountAsync(_factory);
        var phone = await RegisterAsync(sam, name: "Runova app", platform: "android");
        var desk = await RegisterAsync(sam, name: "Sam's desk");
        var deskApp = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, sam));
        await deskApp.GoOnlineWithFeaturesAsync(desk.GetProperty("id").GetInt64(), _takesFiles);
        var phoneHub = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, sam));
        await phoneHub.GoOnlineWithFeaturesAsync(phone.GetProperty("id").GetInt64(), _takesFiles);
        return (sam, phone, desk, phoneHub, deskApp);
    }

    [Fact]
    public async Task A_phone_that_takes_files_shows_online_to_its_owner()
    {
        var (sam, phone, _, phoneHub, deskApp) = await PhoneOnlineAsync();
        await using var _p = phoneHub;
        await using var _d = deskApp;

        var presence = await NextPresenceOfAsync(deskApp, phone.GetProperty("id").GetInt64());
        var phones = await PhonesAsync(sam);

        Assert.True(presence.Online);
        Assert.Equal(_takesFiles, presence.Features);
        var entry = Assert.Single(phones);
        Assert.Equal("Runova app", entry.GetProperty("name").GetString());
        Assert.Equal("phone", entry.GetProperty("kind").GetString());
        Assert.True(entry.GetProperty("online").GetBoolean());
        Assert.Equal(RemoteFeatures.ReceiveFiles, entry.GetProperty("features")[0].GetString());
    }

    [Fact]
    public async Task A_phone_goes_online_only_to_take_files()
    {
        var (_, sam) = await AccountAsync(_factory);
        var phone = await RegisterAsync(sam, name: "Runova app", platform: "android");
        await using var phoneHub = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, sam));

        await Assert.ThrowsAsync<HubException>(() => phoneHub.GoOnlineWithFeaturesAsync(phone.GetProperty("id").GetInt64(), []));
        await Assert.ThrowsAsync<HubException>(() => phoneHub.GoOnlineAsync(phone.GetProperty("id").GetInt64()));
    }

    [Fact]
    public async Task A_send_from_the_owners_computer_rings_the_phone()
    {
        var (_, phone, desk, phoneHub, deskApp) = await PhoneOnlineAsync();
        await using var _p = phoneHub;
        await using var _d = deskApp;

        var result = await deskApp.RequestAsync(phone.GetProperty("remoteId").GetString()!, "ask", desk.GetProperty("id").GetInt64(), RemoteIntents.Send);
        var incoming = await RemoteApp.NextAsync(phoneHub.Incoming);

        Assert.Equal(RemoteConnectStatuses.Ringing, result.Status);
        Assert.Equal("own", result.Relation);
        Assert.Equal("phone", result.Host!.Kind);
        Assert.Equal(phone.GetProperty("identityKey").GetString(), result.Host.IdentityKey);
        Assert.Equal(RemoteIntents.Send, incoming.Intent);
        Assert.Equal("Sam's desk", incoming.Controller.DeviceName);
    }

    [Fact]
    public async Task Only_a_send_rings_a_phone()
    {
        var (_, phone, desk, phoneHub, deskApp) = await PhoneOnlineAsync();
        await using var _p = phoneHub;
        await using var _d = deskApp;
        var remoteId = phone.GetProperty("remoteId").GetString()!;
        var deskId = desk.GetProperty("id").GetInt64();

        var control = await deskApp.RequestAsync(remoteId, "ask", deskId, RemoteIntents.Control);
        var manage = await deskApp.RequestAsync(remoteId, "ask", deskId, RemoteIntents.Manage);

        Assert.Equal(RemoteConnectStatuses.Unavailable, control.Status);
        Assert.Equal(RemoteConnectStatuses.Unavailable, manage.Status);
        await RemoteApp.NothingAsync(phoneHub.Incoming);
    }

    [Fact]
    public async Task A_teammate_can_not_send_to_someone_elses_phone()
    {
        var (_, sam) = await AccountAsync(_factory);
        var (kimUser, kim) = await AccountAsync(_factory, "Kim");
        var team = await CreateTeamAsync(sam, "Ops");
        await JoinAsync(sam, team, kimUser, kim);
        var phone = await RegisterAsync(sam, name: "Runova app", platform: "android");
        var laptop = await RegisterAsync(kim, name: "Kim's laptop", platform: "macos");
        await using var phoneHub = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, sam));
        await phoneHub.GoOnlineWithFeaturesAsync(phone.GetProperty("id").GetInt64(), _takesFiles);
        await using var laptopApp = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, kim));

        var result = await laptopApp.RequestAsync(phone.GetProperty("remoteId").GetString()!, "ask", laptop.GetProperty("id").GetInt64(), RemoteIntents.Send);

        Assert.Equal(RemoteConnectStatuses.Unavailable, result.Status);
        await RemoteApp.NothingAsync(phoneHub.Incoming);
        Assert.Empty(await PhonesAsync(kim));
    }

    [Fact]
    public async Task A_closed_phone_is_offline_and_its_features_forgotten()
    {
        var (sam, phone, desk, phoneHub, deskApp) = await PhoneOnlineAsync();
        await using var _d = deskApp;
        await NextPresenceOfAsync(deskApp, phone.GetProperty("id").GetInt64());

        await phoneHub.DisposeAsync();
        var gone = await NextPresenceOfAsync(deskApp, phone.GetProperty("id").GetInt64());
        var result = await deskApp.RequestAsync(phone.GetProperty("remoteId").GetString()!, "ask", desk.GetProperty("id").GetInt64(), RemoteIntents.Send);

        Assert.False(gone.Online);
        Assert.Empty(gone.Features);
        Assert.Equal(RemoteConnectStatuses.Offline, result.Status);
        var entry = Assert.Single(await PhonesAsync(sam));
        Assert.False(entry.GetProperty("online").GetBoolean());
        Assert.Empty(entry.GetProperty("features").EnumerateArray());
    }

    private static async Task<PresenceChangedDto> NextPresenceOfAsync(RemoteApp app, long deviceId)
    {
        while (true)
        {
            var presence = await RemoteApp.NextAsync(app.Presence);
            if (presence.DeviceId == deviceId)
            {
                return presence;
            }
        }
    }

    private static async Task<List<JsonElement>> PhonesAsync(ApiClient client)
    {
        var directory = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/reachable-devices"), HttpStatusCode.OK);
        return [.. directory.GetProperty("phones").EnumerateArray()];
    }
}
