using System.Net;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR.Client;
using Runova.Website.Api.Remote;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>Computers registered for Runova Anywhere (E60), and an app's connection to the remote hub.</summary>
internal static class TestRemote
{
    /// <summary>A valid Ed25519 public key's shape: 32 bytes, base64url.</summary>
    public static string NewIdentityKey() =>
        Convert.ToBase64String(Guid.NewGuid().ToByteArray().Concat(Guid.NewGuid().ToByteArray()).ToArray()).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public static async Task<JsonElement> RegisterAsync(ApiClient client, Guid? deviceId = null, string name = "Sam's laptop", string platform = "windows", string? identityKey = null)
    {
        var response = await client.SendAsync(HttpMethod.Post, "/api/v1/remote-devices", new
        {
            deviceId = deviceId ?? Guid.NewGuid(),
            name,
            platform,
            identityKey = identityKey ?? NewIdentityKey(),
        });
        Assert.True(response.StatusCode is HttpStatusCode.Created or HttpStatusCode.OK, $"Registering answered {(int)response.StatusCode}.");
        return await ApiClient.ReadJsonAsync(response, response.StatusCode);
    }

    public static async Task<JsonElement> UpdateAsync(ApiClient client, long id, object patch) =>
        await ApiClient.ReadJsonAsync(await client.SendAsync(HttpMethod.Patch, $"/api/v1/remote-devices/{id}", patch), HttpStatusCode.OK);

    public static async Task<RemoteApp> ConnectAsync(WebsiteApiFactory factory, string token)
    {
        var app = new RemoteApp(new HubConnectionBuilder()
            .WithUrl(new Uri(factory.Server.BaseAddress, RemoteHub.Path), options =>
            {
                options.HttpMessageHandlerFactory = _ => factory.Server.CreateHandler();
                options.Transports = HttpTransportType.LongPolling;
                options.AccessTokenProvider = () => Task.FromResult<string?>(token);
            })
            .Build());
        await app.Hub.StartAsync(TestContext.Current.CancellationToken);
        return app;
    }
}

/// <summary>One app on the remote hub, with what it heard queued up for the test to read.</summary>
internal sealed class RemoteApp : IAsyncDisposable
{
    private static readonly TimeSpan _wait = TimeSpan.FromSeconds(20);

    public RemoteApp(HubConnection hub)
    {
        Hub = hub;
        hub.Closed += _ =>
        {
            _closed.TrySetResult();
            return Task.CompletedTask;
        };
        hub.On<IncomingRequestDto>(nameof(IRemoteClient.IncomingRequest), r => Incoming.Writer.TryWrite(r));
        hub.On<RequestResolvedDto>(nameof(IRemoteClient.RequestResolved), r => Resolved.Writer.TryWrite(r));
        hub.On<string, string>(nameof(IRemoteClient.Signal), (session, payload) => Signals.Writer.TryWrite((session, payload)));
        hub.On<SessionEndedDto>(nameof(IRemoteClient.SessionEnded), e => Ended.Writer.TryWrite(e));
        hub.On<PresenceChangedDto>(nameof(IRemoteClient.PresenceChanged), p => Presence.Writer.TryWrite(p));
    }

    private readonly TaskCompletionSource _closed = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public HubConnection Hub { get; }

    /// <summary>Waits for the server to close this connection.</summary>
    public Task ClosedAsync() => _closed.Task.WaitAsync(_wait, TestContext.Current.CancellationToken);

    public Channel<IncomingRequestDto> Incoming { get; } = Channel.CreateUnbounded<IncomingRequestDto>();

    public Channel<RequestResolvedDto> Resolved { get; } = Channel.CreateUnbounded<RequestResolvedDto>();

    public Channel<(string Session, string Payload)> Signals { get; } = Channel.CreateUnbounded<(string, string)>();

    public Channel<SessionEndedDto> Ended { get; } = Channel.CreateUnbounded<SessionEndedDto>();

    public Channel<PresenceChangedDto> Presence { get; } = Channel.CreateUnbounded<PresenceChangedDto>();

    public static async Task<T> NextAsync<T>(Channel<T> channel) =>
        await channel.Reader.ReadAsync(TestContext.Current.CancellationToken).AsTask().WaitAsync(_wait, TestContext.Current.CancellationToken);

    /// <summary>Nothing arrives in the next half second.</summary>
    public static async Task NothingAsync<T>(Channel<T> channel)
    {
        await Task.Delay(500, TestContext.Current.CancellationToken);
        Assert.False(channel.Reader.TryRead(out _));
    }

    public Task GoOnlineAsync(long deviceId) => Hub.InvokeAsync(nameof(RemoteHub.GoOnline), deviceId, TestContext.Current.CancellationToken);

    public Task<ConnectResultDto> RequestAsync(string remoteId, string mode = "ask", long? fromDeviceId = null, string intent = "control") =>
        Hub.InvokeAsync<ConnectResultDto>(nameof(RemoteHub.RequestConnect), new ConnectRequestDto(remoteId, mode, fromDeviceId, intent), TestContext.Current.CancellationToken);

    public Task RespondAsync(string sessionId, bool accept) => Hub.InvokeAsync(nameof(RemoteHub.Respond), sessionId, accept, TestContext.Current.CancellationToken);

    public Task SignalAsync(string sessionId, string payload) => Hub.InvokeAsync(nameof(RemoteHub.Signal), sessionId, payload, TestContext.Current.CancellationToken);

    public Task ConnectedAsync(string sessionId, string transport) => Hub.InvokeAsync(nameof(RemoteHub.Connected), sessionId, transport, TestContext.Current.CancellationToken);

    public Task EndAsync(string sessionId) => Hub.InvokeAsync(nameof(RemoteHub.End), sessionId, TestContext.Current.CancellationToken);

    public Task<RelayTicketDto> RelayTicketAsync(string sessionId) =>
        Hub.InvokeAsync<RelayTicketDto>(nameof(RemoteHub.CreateRelayTicket), sessionId, TestContext.Current.CancellationToken);

    public ValueTask DisposeAsync() => Hub.DisposeAsync();
}
