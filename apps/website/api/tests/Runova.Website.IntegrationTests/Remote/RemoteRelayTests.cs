using System.Net.WebSockets;
using System.Text;
using Microsoft.AspNetCore.SignalR;
using Runova.Website.Api.Remote;
using Runova.Website.IntegrationTests.Infrastructure;
using static Runova.Website.IntegrationTests.Infrastructure.TestDependencies;
using static Runova.Website.IntegrationTests.Infrastructure.TestRemote;

namespace Runova.Website.IntegrationTests.Remote;

/// <summary>The relay copies sealed frames between the two sides of an accepted session, and nothing else (E62).</summary>
public sealed class RemoteRelayTests(PostgresFixture postgres) : IAsyncLifetime
{
    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync() => _factory = new WebsiteApiFactory(await postgres.CreateDatabaseAsync());

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>Sam's computer, shown to Ops, has accepted Kim's request.</summary>
    private sealed record Accepted(RemoteApp Host, RemoteApp Controller, string SessionId) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            await Host.DisposeAsync();
            await Controller.DisposeAsync();
        }
    }

    private async Task<Accepted> AcceptedAsync()
    {
        var (_, sam) = await AccountAsync(_factory);
        var (kimUser, kim) = await AccountAsync(_factory, "Kim");
        var team = await CreateTeamAsync(sam, "Ops");
        await JoinAsync(sam, team, kimUser, kim);
        var host = await RegisterAsync(sam);
        await UpdateAsync(sam, host.GetProperty("id").GetInt64(), new { teamIds = new[] { team } });
        var from = await RegisterAsync(kim, name: "Kim's laptop");
        var hostApp = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, sam));
        var controllerApp = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, kim));
        await hostApp.GoOnlineAsync(host.GetProperty("id").GetInt64());
        await controllerApp.RequestAsync(host.GetProperty("remoteId").GetString()!, "ask", from.GetProperty("id").GetInt64());
        var sessionId = (await RemoteApp.NextAsync(hostApp.Incoming)).SessionId;
        await hostApp.RespondAsync(sessionId, accept: true);
        await RemoteApp.NextAsync(controllerApp.Resolved);
        return new Accepted(hostApp, controllerApp, sessionId);
    }

    private async Task<WebSocket> OpenAsync(RelayTicketDto ticket)
    {
        var client = _factory.Server.CreateWebSocketClient();
        return await client.ConnectAsync(new Uri(_factory.Server.BaseAddress, $"{ticket.Path}?ticket={Uri.EscapeDataString(ticket.Ticket)}"), Ct);
    }

    private static async Task<(WebSocketMessageType Type, byte[] Data)> ReceiveAsync(WebSocket socket)
    {
        var buffer = new byte[256 * 1024];
        var length = 0;
        WebSocketReceiveResult result;
        do
        {
            result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer, length, buffer.Length - length), Ct)
                .WaitAsync(TimeSpan.FromSeconds(20), Ct);
            length += result.Count;
        }
        while (!result.EndOfMessage && result.MessageType != WebSocketMessageType.Close);
        return (result.MessageType, buffer[..length]);
    }

    [Fact]
    public async Task Both_sides_meet_and_frames_pass_both_ways()
    {
        await using var accepted = await AcceptedAsync();
        var (host, controller, sessionId) = accepted;
        var hostTicket = await host.RelayTicketAsync(sessionId);
        var controllerTicket = await controller.RelayTicketAsync(sessionId);

        using var hostSocket = await OpenAsync(hostTicket);
        using var controllerSocket = await OpenAsync(controllerTicket);
        var hostReady = await ReceiveAsync(hostSocket);
        var controllerReady = await ReceiveAsync(controllerSocket);
        await controllerSocket.SendAsync(new byte[] { 1, 2, 3 }, WebSocketMessageType.Binary, true, Ct);
        var atHost = await ReceiveAsync(hostSocket);
        await hostSocket.SendAsync(new byte[] { 9, 8 }, WebSocketMessageType.Binary, true, Ct);
        var atController = await ReceiveAsync(controllerSocket);

        Assert.Equal($"/relay/remote/{sessionId}", hostTicket.Path);
        Assert.Equal("ready", Encoding.ASCII.GetString(hostReady.Data));
        Assert.Equal("ready", Encoding.ASCII.GetString(controllerReady.Data));
        Assert.Equal(WebSocketMessageType.Binary, atHost.Type);
        Assert.Equal(new byte[] { 1, 2, 3 }, atHost.Data);
        Assert.Equal(new byte[] { 9, 8 }, atController.Data);
    }

    [Fact]
    public async Task A_frame_close_to_the_limit_passes_whole()
    {
        await using var accepted = await AcceptedAsync();
        var (host, controller, sessionId) = accepted;
        using var hostSocket = await OpenAsync(await host.RelayTicketAsync(sessionId));
        using var controllerSocket = await OpenAsync(await controller.RelayTicketAsync(sessionId));
        await ReceiveAsync(hostSocket);
        await ReceiveAsync(controllerSocket);
        var frame = Enumerable.Range(0, 61_464).Select(i => (byte)i).ToArray();

        await controllerSocket.SendAsync(frame, WebSocketMessageType.Binary, true, Ct);

        Assert.Equal(frame, (await ReceiveAsync(hostSocket)).Data);
    }

    [Fact]
    public async Task One_side_leaving_closes_the_other()
    {
        await using var accepted = await AcceptedAsync();
        var (host, controller, sessionId) = accepted;
        using var hostSocket = await OpenAsync(await host.RelayTicketAsync(sessionId));
        using var controllerSocket = await OpenAsync(await controller.RelayTicketAsync(sessionId));
        await ReceiveAsync(hostSocket);
        await ReceiveAsync(controllerSocket);

        await controllerSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", Ct);

        Assert.Equal(WebSocketMessageType.Close, (await ReceiveAsync(hostSocket)).Type);
    }

    [Fact]
    public async Task An_oversized_message_ends_the_session()
    {
        await using var accepted = await AcceptedAsync();
        var (host, controller, sessionId) = accepted;
        using var hostSocket = await OpenAsync(await host.RelayTicketAsync(sessionId));
        using var controllerSocket = await OpenAsync(await controller.RelayTicketAsync(sessionId));
        await ReceiveAsync(hostSocket);
        await ReceiveAsync(controllerSocket);

        await controllerSocket.SendAsync(new byte[RemoteRelay.MaxMessageBytes + 1], WebSocketMessageType.Binary, true, Ct);

        Assert.Equal(WebSocketMessageType.Close, (await ReceiveAsync(hostSocket)).Type);
    }

    [Fact]
    public async Task A_session_over_its_byte_limit_ends_for_both_sides_and_says_why()
    {
        _factory.Dispose();
        _factory = new WebsiteApiFactory(
            await postgres.CreateDatabaseAsync(),
            settings: new Dictionary<string, string> { ["Remote:Relay:MaxSessionBytes"] = "10" });
        await using var accepted = await AcceptedAsync();
        var (host, controller, sessionId) = accepted;
        using var hostSocket = await OpenAsync(await host.RelayTicketAsync(sessionId));
        using var controllerSocket = await OpenAsync(await controller.RelayTicketAsync(sessionId));
        await ReceiveAsync(hostSocket);
        await ReceiveAsync(controllerSocket);

        await controllerSocket.SendAsync(new byte[8], WebSocketMessageType.Binary, true, Ct);
        var first = await ReceiveAsync(hostSocket);
        await hostSocket.SendAsync(new byte[8], WebSocketMessageType.Binary, true, Ct);
        var atController = await ReceiveAsync(controllerSocket);
        var atHost = await ReceiveAsync(hostSocket);

        Assert.Equal(8, first.Data.Length);
        Assert.Equal(WebSocketMessageType.Close, atController.Type);
        Assert.Equal(WebSocketMessageType.Close, atHost.Type);
        Assert.Equal(RemoteRelay.OverLimitReason, controllerSocket.CloseStatusDescription);
        Assert.Equal(RemoteRelay.OverLimitReason, hostSocket.CloseStatusDescription);
    }

    [Fact]
    public async Task A_ticket_works_once_and_only_on_its_own_session()
    {
        await using var accepted = await AcceptedAsync();
        var (host, controller, sessionId) = accepted;
        var ticket = await host.RelayTicketAsync(sessionId);
        using var first = await OpenAsync(ticket);
        var other = await controller.RelayTicketAsync(sessionId);

        await Assert.ThrowsAnyAsync<Exception>(() => OpenAsync(ticket));
        await Assert.ThrowsAnyAsync<Exception>(() => OpenAsync(other with { Path = "/relay/remote/another-session" }));
        await Assert.ThrowsAnyAsync<Exception>(() => OpenAsync(new RelayTicketDto(ticket.Path, "made-up")));
    }

    [Fact]
    public async Task No_ticket_before_the_host_accepts_or_for_someone_outside_the_session()
    {
        var (_, sam) = await AccountAsync(_factory);
        var (kimUser, kim) = await AccountAsync(_factory, "Kim");
        var (_, lee) = await AccountAsync(_factory, "Lee");
        var team = await CreateTeamAsync(sam, "Ops");
        await JoinAsync(sam, team, kimUser, kim);
        var hostDevice = await RegisterAsync(sam);
        await UpdateAsync(sam, hostDevice.GetProperty("id").GetInt64(), new { teamIds = new[] { team } });
        await using var host = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, sam));
        await using var controller = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, kim));
        await using var stranger = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, lee));
        await host.GoOnlineAsync(hostDevice.GetProperty("id").GetInt64());
        var ringing = await controller.RequestAsync(hostDevice.GetProperty("remoteId").GetString()!);

        await Assert.ThrowsAsync<HubException>(() => controller.RelayTicketAsync(ringing.SessionId!));
        await host.RespondAsync(ringing.SessionId!, accept: true);
        await Assert.ThrowsAsync<HubException>(() => stranger.RelayTicketAsync(ringing.SessionId!));
    }
}
