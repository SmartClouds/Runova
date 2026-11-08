using System.Globalization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Api.Dependencies;
using Runova.Website.Api.Notifications;
using Runova.Website.Api.Telegram;
using Runova.Website.Core.Monitoring;
using Runova.Website.Data;
using Runova.Website.Data.Dependencies;
using Runova.Website.Data.Monitoring;

namespace Runova.Website.Api.CloudMonitoring;

/// <summary>An incident opened or resolved, for the notifier.</summary>
internal sealed record MonitorChange(CloudMonitor Monitor, CloudMonitorIncident Incident, bool Down, string? SeenFrom, string? ConfirmedFrom);

/// <summary>
/// Tells people about their online monitors (E55), as <see cref="AlertNotifier"/> does for
/// dependencies: everyone who can see the scope, less anyone who muted the monitor. A message is
/// saved and pushed when the monitor has in-app alerts on, and queued for Telegram when it has
/// Telegram on and the account linked a chat. Every result is also pushed live, to every member.
/// </summary>
internal sealed partial class CloudMonitorNotifier(
    AppDbContext db,
    AlertNotifier members,
    IHubContext<NotificationsHub, INotificationsClient> hub,
    TelegramOutbox telegram,
    NotificationDelivery delivery,
    CloudMonitorViews views,
    TimeProvider time,
    ILogger<CloudMonitorNotifier> logger)
{
    public const string DownKind = "monitor-down";
    public const string RecoveredKind = "monitor-recovered";
    public const string PlanKind = "monitor-plan";

    /// <summary>
    /// Adds the messages for these changes to the context, to be saved with the results that
    /// caused them, and returns what to push once they are.
    /// </summary>
    public async Task<IReadOnlyList<UserNotification>> AddAsync(IReadOnlyList<MonitorChange> changes, CancellationToken ct = default)
    {
        if (changes.Count == 0)
        {
            return [];
        }

        var created = new List<UserNotification>();
        var now = time.GetUtcNow();
        foreach (var scope in changes.GroupBy(c => c.Monitor.ScopeId))
        {
            var people = await members.MembersAsync(scope.Key, ct);
            if (people.Count == 0)
            {
                continue;
            }

            var monitorIds = scope.Select(c => c.Monitor.Id).Distinct().ToList();
            var muted = (await db.CloudMonitorMutes.AsNoTracking()
                .Where(m => monitorIds.Contains(m.MonitorId) && people.Contains(m.UserId))
                .Select(m => new { m.MonitorId, m.UserId }).ToListAsync(ct))
                .Select(m => (m.MonitorId, m.UserId)).ToHashSet();
            var chats = await db.TelegramLinks.AsNoTracking().Where(l => people.Contains(l.UserId)).ToDictionaryAsync(l => l.UserId, l => l.ChatId, ct);

            foreach (var change in scope)
            {
                var monitor = change.Monitor;
                var label = CloudMonitorMapper.ToLabel(monitor);
                var message = change.Down
                    ? CloudMonitorMessages.Down(label, change.Incident.State, change.Incident.Problem, change.SeenFrom, change.ConfirmedFrom)
                    : CloudMonitorMessages.Recovered(label, (change.Incident.ResolvedAt ?? now) - change.Incident.OpenedAt);
                foreach (var userId in people.Where(u => !muted.Contains((monitor.Id, u))))
                {
                    if (monitor.NotifyInApp)
                    {
                        var notification = new UserNotification
                        {
                            UserId = userId,
                            Kind = change.Down ? DownKind : RecoveredKind,
                            Title = Clip(message.Title, 300),
                            Body = message.Body,
                            Severity = change.Down ? "critical" : "info",
                            ScopeId = monitor.ScopeId,
                            ItemId = monitor.ItemId,
                            CreatedAt = now,
                        };
                        db.UserNotifications.Add(notification);
                        created.Add(notification);
                    }

                    if (monitor.NotifyTelegram && chats.TryGetValue(userId, out var chatId))
                    {
                        telegram.Add(chatId, message.Telegram);
                    }
                }
            }
        }

        return created;
    }

    /// <summary>After the save: the new messages, and the monitors' fresh status, to every open app and page.</summary>
    public async Task PushAsync(IReadOnlyList<UserNotification> created, IReadOnlyCollection<long> monitorIds, CancellationToken ct = default)
    {
        telegram.SendSoon();
        await delivery.DeliverAsync(created, ct);

        if (monitorIds.Count == 0)
        {
            return;
        }

        foreach (var scope in (await views.LiveAsync(monitorIds, ct)).GroupBy(m => m.ScopeId))
        {
            foreach (var userId in await members.MembersAsync(scope.Key, ct))
            {
                foreach (var live in scope)
                {
                    await SendAsync(userId, client => client.CloudMonitorUpdated(live));
                }
            }
        }
    }

    /// <summary>Tells the scope's members to read its monitors again.</summary>
    public async Task ScopeChangedAsync(long scopeId, CancellationToken ct = default)
    {
        var change = new CloudMonitorsChangedDto(scopeId);
        foreach (var userId in await members.MembersAsync(scopeId, ct))
        {
            await SendAsync(userId, client => client.CloudMonitorsChanged(change));
        }
    }

    /// <summary>The plan enforcement notice, saved for every member (and on Telegram for those who linked a chat).</summary>
    public async Task<IReadOnlyList<UserNotification>> AddPlanNoticeAsync(long scopeId, MonitorMessage message, CancellationToken ct = default)
    {
        var people = await members.MembersAsync(scopeId, ct);
        var chats = await db.TelegramLinks.AsNoTracking().Where(l => people.Contains(l.UserId)).ToDictionaryAsync(l => l.UserId, l => l.ChatId, ct);
        var now = time.GetUtcNow();
        var created = new List<UserNotification>();
        foreach (var userId in people)
        {
            var notification = new UserNotification
            {
                UserId = userId,
                Kind = PlanKind,
                Title = Clip(message.Title, 300),
                Body = message.Body,
                Severity = "warning",
                ScopeId = scopeId,
                CreatedAt = now,
            };
            db.UserNotifications.Add(notification);
            created.Add(notification);
            if (chats.TryGetValue(userId, out var chatId))
            {
                telegram.Add(chatId, message.Telegram);
            }
        }

        return created;
    }

    // A push that fails loses nothing: the message is saved, and the pages read everything when they connect.
    private async Task SendAsync(long userId, Func<INotificationsClient, Task> send)
    {
        try
        {
            await send(hub.Clients.User(userId.ToString(CultureInfo.InvariantCulture)));
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            LogPushFailed(logger, userId, e);
        }
    }

    private static string Clip(string text, int length) => text.Length <= length ? text : text[..length];

    [LoggerMessage(Level = LogLevel.Warning, Message = "A live monitor update for account {UserId} could not be pushed")]
    private static partial void LogPushFailed(ILogger logger, long userId, Exception exception);
}
