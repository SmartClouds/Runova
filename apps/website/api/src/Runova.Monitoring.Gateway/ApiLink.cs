using Google.Protobuf;
using Runova.Monitoring.Contracts;
using Runova.Monitoring.Contracts.Grpc;
using Wolverine;

namespace Runova.Monitoring.Gateway;

/// <summary>The gateway's way to the API. In production it is Wolverine on the internal RabbitMQ.</summary>
public interface IApiLink
{
    /// <summary>Sends without waiting for the API.</summary>
    Task PublishAsync<T>(T message, CancellationToken ct = default)
        where T : class;

    /// <summary>Asks the API and waits for its answer; throws when none comes in time.</summary>
    Task<TReply> InvokeAsync<TReply>(object request, TimeSpan timeout, CancellationToken ct = default)
        where TReply : class;
}

/// <summary>
/// Wolverine on the internal RabbitMQ. A publish is fire and forget (heartbeats repeat); what must
/// not be lost is asked with <see cref="InvokeAsync"/>, whose answer comes only once the API has it.
/// A Wolverine publish can not stand in for that: with the broker down it keeps the message in
/// memory and returns as if it were sent.
/// </summary>
internal sealed class WolverineApiLink(IServiceScopeFactory scopes) : IApiLink
{
    public async Task PublishAsync<T>(T message, CancellationToken ct = default)
        where T : class
    {
        using var scope = scopes.CreateScope();
        await scope.ServiceProvider.GetRequiredService<IMessageBus>().PublishAsync(message);
    }

    public async Task<TReply> InvokeAsync<TReply>(object request, TimeSpan timeout, CancellationToken ct = default)
        where TReply : class
    {
        using var scope = scopes.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<IMessageBus>().InvokeAsync<TReply>(request, ct, timeout);
    }
}

/// <summary>What the API sends every gateway. Each gateway acts only for the nodes it holds.</summary>
public static class GatewayInboundHandler
{
    public static async Task Handle(NodeOutbound message, NodeSessions sessions, CancellationToken ct)
    {
        ServerMessage parsed;
        try
        {
            parsed = ServerMessage.Parser.ParseFrom(message.ServerMessage);
        }
        catch (InvalidProtocolBufferException)
        {
            return;
        }

        await sessions.DeliverAsync(message.NodeId, parsed, ct);
    }

    public static void Handle(NodeRevoked message, NodeSessions sessions, GatewayTrust trust)
    {
        trust.Revoke(message.Serials);
        sessions.Revoke(message.NodeId, message.Serials);
    }

    public static void Handle(CloseNodeConnection message, NodeSessions sessions) => sessions.Close(message.NodeId, message.Reason);
}

/// <summary>Loads the trust list when the gateway starts, and again every few minutes.</summary>
internal sealed partial class TrustLoader(
    IApiLink api, GatewayTrust trust, GatewayIdentity identity, Microsoft.Extensions.Options.IOptions<GatewayOptions> options,
    IHostApplicationLifetime lifetime, TimeProvider time, ILogger<TrustLoader> logger) : BackgroundService
{
    /// <summary>How long one ask waits for the API's answer before it counts as failed.</summary>
    internal static readonly TimeSpan AskTimeout = TimeSpan.FromSeconds(15);

    /// <summary>The pause before asking again, doubled after each failure while there is no list yet.</summary>
    internal static readonly TimeSpan FirstRetry = TimeSpan.FromSeconds(1);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Wolverine starts as a hosted service too; asking before it is up leaves it with a broken
        // route it keeps, so the first ask waits for the whole host.
        await Task.Delay(Timeout.Infinite, lifetime.ApplicationStarted).ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
        var delay = FirstRetry;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                trust.Load(await api.InvokeAsync<NodeTrust>(new GetNodeTrust(identity.Id), AskTimeout, stoppingToken));
                delay = options.Value.TrustRefresh;
            }
            catch (Exception e) when (e is not OperationCanceledException || !stoppingToken.IsCancellationRequested)
            {
                LoadFailed(logger, e);
                delay = trust.Ready ? TimeSpan.FromSeconds(30) : TimeSpan.FromSeconds(Math.Min(30, delay.TotalSeconds * 2));
            }

            await Task.Delay(delay, time, stoppingToken).ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
        }
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Could not load the node trust list from the API.")]
    private static partial void LoadFailed(ILogger logger, Exception exception);
}

/// <summary>This gateway's id, the same for its whole life.</summary>
public sealed record GatewayIdentity(string Id);
