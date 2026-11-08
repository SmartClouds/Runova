using System.Threading.Channels;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Data;

namespace Runova.Website.Api.Notifications;

/// <summary>What a phone reports itself as, and which push service reaches it.</summary>
internal static class PushPlatforms
{
    public const string Android = "android";
    public const string Ios = "ios";

    public static bool IsKnown(string? platform) => platform is Android or Ios;
}

/// <summary>One line to one phone. It holds a push token, so it is never logged.</summary>
internal sealed record PushDelivery(
    long DeviceId,
    string Platform,
    string Token,
    string Line,
    string Category,
    long NotificationId,
    string? ItemId);

internal enum PushSendResult
{
    Sent,

    /// <summary>The push service says the token is gone: the device is removed.</summary>
    Unregistered,

    /// <summary>The push service refused or could not be reached. Nothing is retried; the inbox still has it.</summary>
    Failed,

    /// <summary>This sender has no credentials configured.</summary>
    Disabled,
}

/// <summary>A push service for one platform. The real ones are configured or quietly disabled; tests use a fake.</summary>
internal interface IPushSender
{
    string Platform { get; }

    Task<PushSendResult> SendAsync(PushDelivery delivery, CancellationToken cancellationToken);
}

/// <summary>
/// Deliveries on their way to the push services. Deliberately in memory: the message itself is saved
/// in the inbox, and a push that is lost in a restart is one the person can read there anyway.
/// When it is somehow full the oldest deliveries go first.
/// </summary>
internal sealed class PushQueue
{
    private readonly Channel<PushDelivery> _channel = Channel.CreateBounded<PushDelivery>(
        new BoundedChannelOptions(10_000) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true });

    public ChannelReader<PushDelivery> Reader => _channel.Reader;

    public void Enqueue(PushDelivery delivery) => _channel.Writer.TryWrite(delivery);
}

/// <summary>Sends what <see cref="PushQueue"/> holds, one at a time, and forgets a token the service no longer knows.</summary>
internal sealed partial class PushDispatcher(
    PushQueue queue,
    IEnumerable<IPushSender> senders,
    IServiceScopeFactory scopes,
    ILogger<PushDispatcher> logger) : BackgroundService
{
    private readonly Dictionary<string, IPushSender> _senders = senders.ToDictionary(s => s.Platform, StringComparer.Ordinal);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var delivery in queue.Reader.ReadAllAsync(stoppingToken))
        {
            await SendAsync(delivery, stoppingToken);
        }
    }

    private async Task SendAsync(PushDelivery delivery, CancellationToken stoppingToken)
    {
        if (!_senders.TryGetValue(delivery.Platform, out var sender))
        {
            return;
        }

        try
        {
            if (await sender.SendAsync(delivery, stoppingToken) == PushSendResult.Unregistered)
            {
                using var scope = scopes.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                await db.PushDevices.Where(d => d.Id == delivery.DeviceId).ExecuteDeleteAsync(stoppingToken);
            }
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            LogSendFailed(logger, delivery.Category, delivery.NotificationId, e);
        }
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "A push for a {Category} notification ({NotificationId}) could not be sent")]
    private static partial void LogSendFailed(ILogger logger, string category, long notificationId, Exception exception);
}
