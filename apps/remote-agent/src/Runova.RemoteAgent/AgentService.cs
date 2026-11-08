using System.Net.Http.Json;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Runova.RemoteAgent.Core;

namespace Runova.RemoteAgent;

/// <summary>A request as the website's remote hub sends it.</summary>
public sealed record IncomingRequest(string SessionId, string Mode, string Relation, string Intent, IncomingController Controller, IReadOnlyList<string> Teams);

public sealed record IncomingController(long UserId, string DisplayName, string Email, string? DeviceName, string? Platform, string? RemoteId, string? IdentityKey);

public sealed record RelayTicket(string Path, string Ticket);

internal sealed record AgentToken(string AccessToken, int ExpiresIn);

/// <summary>Where the screen and input of this computer come from, per OS.</summary>
public interface IAgentPlatform
{
    IScreenSource Screen { get; }

    ITileEncoder Encoder { get; }

    IInputSink Input { get; }
}

/// <summary>
/// The agent on the website (E64): it trades its secret for an hour-long hub token, goes online for
/// its computer, and answers requests by its own rules, since there is no one there to ask. An
/// accepted session goes through the relay (the agent has no WebRTC), runs the handshake with the
/// key the server announced for the controller, and is hosted with the owner's default permissions.
/// </summary>
public sealed partial class AgentService(AgentConfig config, IAgentPlatform platform, HttpClient http, ILogger<AgentService> logger, TimeProvider time) : BackgroundService
{
    private static readonly TimeSpan _frameInterval = TimeSpan.FromMilliseconds(125);
    private readonly PasswordLockout _lockout = new(time.GetUtcNow);
    private readonly SemaphoreSlim _tokenGate = new(1, 1);
    private (string Token, DateTimeOffset Until)? _token;
    private HubConnection? _hub;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _hub = new HubConnectionBuilder()
            .WithUrl(new Uri(new Uri(config.SiteUrl), "/hubs/remote"), options =>
            {
                options.AccessTokenProvider = async () => await TokenAsync(stoppingToken);
                options.Transports = HttpTransportType.WebSockets | HttpTransportType.LongPolling;
            })
            .WithAutomaticReconnect([TimeSpan.Zero, TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(30)])
            .Build();
        _hub.On<IncomingRequest>("IncomingRequest", request => _ = Task.Run(() => ServeAsync(request, stoppingToken), stoppingToken));
        _hub.Reconnected += _ => GoOnlineAsync(stoppingToken);

        while (!stoppingToken.IsCancellationRequested && _hub.State == HubConnectionState.Disconnected)
        {
            try
            {
                await _hub.StartAsync(stoppingToken);
                await GoOnlineAsync(stoppingToken);
            }
            catch (Exception e) when (e is HttpRequestException or InvalidOperationException or IOException)
            {
                LogWaiting(logger, e.Message);
                await Task.Delay(TimeSpan.FromSeconds(30), time, stoppingToken);
            }
        }

        await Task.Delay(Timeout.Infinite, stoppingToken).ContinueWith(_ => { }, TaskScheduler.Default);
        await _hub.DisposeAsync();
    }

    private Task GoOnlineAsync(CancellationToken ct) => _hub!.InvokeAsync("GoOnline", config.DeviceId, ct);

    private async Task<string?> TokenAsync(CancellationToken ct)
    {
        await _tokenGate.WaitAsync(ct);
        try
        {
            if (_token is { } current && current.Until > time.GetUtcNow())
            {
                return current.Token;
            }

            using var response = await http.PostAsJsonAsync(new Uri(new Uri(config.SiteUrl), "/api/v1/remote-agent-tokens"), new { remoteId = config.RemoteId, secret = config.AgentSecret }, ct);
            response.EnsureSuccessStatusCode();
            var token = await response.Content.ReadFromJsonAsync<AgentToken>(ct) ?? throw new InvalidDataException("No agent token.");
            _token = (token.AccessToken, time.GetUtcNow() + TimeSpan.FromSeconds(token.ExpiresIn - 60));
            return token.AccessToken;
        }
        finally
        {
            _tokenGate.Release();
        }
    }

    internal async Task ServeAsync(IncomingRequest request, CancellationToken ct)
    {
        var hub = _hub!;
        var passwordSecret = config.PasswordSecret is { } s ? Bytes.FromB64u(s) : null;
        var facts = new IncomingFacts(request.Mode, request.Relation, request.Controller.UserId, request.Teams, passwordSecret is not null, _lockout.Locked());
        var accept = request.Controller.IdentityKey is not null && AgentPolicy.Accepts(facts, config.Settings);
        await hub.InvokeAsync("Respond", request.SessionId, accept, ct);
        if (!accept)
        {
            return;
        }

        try
        {
            // The controller is told to go to the relay at once; it would only wait for WebRTC otherwise.
            await hub.InvokeAsync("Signal", request.SessionId, "{\"k\":\"relay\"}", ct);
            var ticket = await hub.InvokeAsync<RelayTicket>("CreateRelayTicket", request.SessionId, ct);
            var transport = await RelayTransport.OpenAsync(RelayTransport.UrlFor(config.SiteUrl, ticket.Path, ticket.Ticket), TimeSpan.FromSeconds(30), ct);
            var handshake = new HostHandshake(
                request.SessionId,
                request.Mode,
                config.Identity,
                Bytes.FromB64u(request.Controller.IdentityKey!),
                request.Mode == "password" ? passwordSecret : null,
                "",
                "",
                RandomNumberGenerator.GetBytes);
            await using var link = await AgentLink.AcceptAsync(transport, handshake, sealFrames: true, TimeSpan.FromSeconds(20), ct);
            if (request.Mode == "password")
            {
                _lockout.Succeeded();
            }

            await hub.InvokeAsync("Connected", request.SessionId, "relay", ct);
            LogConnected(logger, request.Controller.DisplayName, request.Mode);
            var session = new HostSession(link, config.DeviceName, platform.Screen, platform.Encoder, platform.Input, new SessionOptions(config.DefaultPermissions, request.Intent, _frameInterval));
            await session.RunAsync(ct);
        }
        catch (HandshakeException e)
        {
            if (e.Reason == HandshakeFailure.WrongPassword)
            {
                _lockout.Failed();
            }

            LogRefused(logger, e.Reason);
        }
        catch (Exception e) when (e is IOException or HttpRequestException or System.Net.WebSockets.WebSocketException or OperationCanceledException or HubException)
        {
            LogFailed(logger, e.Message);
        }
        finally
        {
            try
            {
                await hub.InvokeAsync("End", request.SessionId, CancellationToken.None);
            }
            catch (Exception e) when (e is IOException or InvalidOperationException or HubException)
            {
            }
        }
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "The website is not reachable yet: {Reason}")]
    private static partial void LogWaiting(ILogger logger, string reason);

    [LoggerMessage(Level = LogLevel.Information, Message = "{Controller} connected with {Mode}")]
    private static partial void LogConnected(ILogger logger, string controller, string mode);

    [LoggerMessage(Level = LogLevel.Information, Message = "A connection was refused in the handshake: {Reason}")]
    private static partial void LogRefused(ILogger logger, HandshakeFailure reason);

    [LoggerMessage(Level = LogLevel.Warning, Message = "A session ended early: {Reason}")]
    private static partial void LogFailed(ILogger logger, string reason);
}
