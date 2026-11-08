using System.Globalization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Data;
using Runova.Website.Data.Accounts;
using Runova.Website.Data.Dependencies;

namespace Runova.Website.Api.Notifications;

/// <summary>
/// Sends a saved message on its way (E82). The desktop app and web pages hear every message they
/// can see; a phone hears the ones whose category is on, live over the hub and through its push
/// service. A category turned off changes nothing for the desktop or the website.
/// </summary>
internal sealed partial class NotificationDelivery(
    AppDbContext db,
    NotificationPreferenceStore preferences,
    IHubContext<NotificationsHub, INotificationsClient> hub,
    PushQueue queue,
    TimeProvider time,
    ILogger<NotificationDelivery> logger)
{
    /// <summary>Call after the save that made them, so a phone that reads straight away finds them.</summary>
    public async Task DeliverAsync(IReadOnlyCollection<UserNotification> created, CancellationToken cancellationToken = default)
    {
        if (created.Count == 0)
        {
            return;
        }

        var userIds = created.Select(n => n.UserId).Distinct().ToList();
        var off = await preferences.OffAsync(userIds, cancellationToken);
        var now = time.GetUtcNow();
        var devices = (await db.PushDevices.AsNoTracking()
            .Where(d => userIds.Contains(d.UserId))
            .Join(db.AccountSessions.Where(s => s.Kind == AccountSessionKinds.Mobile && s.RevokedAt == null && (s.RefreshExpiresAt == null || s.RefreshExpiresAt > now)), d => d.SessionId, s => s.Id, (d, _) => d)
            .Where(d => db.Users.Any(u => u.Id == d.UserId && u.DisabledAt == null))
            .ToListAsync(cancellationToken))
            .ToLookup(d => d.UserId);

        foreach (var notification in created)
        {
            var dto = NotificationMapper.ToDto(notification);
            if (!NotificationCategories.IsForwarded(notification.Kind))
            {
                await SendAsync(notification.UserId, group: NotificationsHub.DeskGroup(notification.UserId), client => client.NotificationCreated(dto));
            }

            var category = NotificationCategories.OfKind(notification.Kind);
            if (off.TryGetValue(notification.UserId, out var mine) && mine.Contains(category))
            {
                continue;
            }

            await SendAsync(notification.UserId, group: NotificationsHub.PhoneGroup(notification.UserId), client => client.NotificationCreated(dto));
            var line = PushContent.LineFromTitle(notification.Title);
            foreach (var device in devices[notification.UserId])
            {
                queue.Enqueue(new PushDelivery(device.Id, device.Platform, device.PushToken, line, category, notification.Id, notification.ItemId));
            }
        }
    }

    // A push that fails loses nothing: the message is saved, and an app reads them all when it connects.
    private async Task SendAsync(long userId, string group, Func<INotificationsClient, Task> send)
    {
        try
        {
            await send(hub.Clients.Group(group));
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            LogPushFailed(logger, userId.ToString(CultureInfo.InvariantCulture), e);
        }
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "A live notification for account {UserId} could not be pushed")]
    private static partial void LogPushFailed(ILogger logger, string userId, Exception exception);
}
