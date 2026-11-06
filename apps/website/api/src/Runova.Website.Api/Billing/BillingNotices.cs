using System.Globalization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Api.Email;
using Runova.Website.Api.Notifications;
using Runova.Website.Api.Telegram;
using Runova.Website.Core.Email;
using Runova.Website.Data;
using Runova.Website.Data.Dependencies;

namespace Runova.Website.Api.Billing;

/// <summary>
/// Tells an account about its plan: a message in the app and on the website (pushed live), an
/// email when asked, and Telegram when the account linked a chat. Saved with the caller's other
/// changes; <see cref="FlushAsync"/> pushes and sends after the commit.
/// </summary>
internal sealed partial class BillingNotices(
    AppDbContext db,
    IHubContext<NotificationsHub, INotificationsClient> hub,
    TelegramOutbox telegram,
    EmailOutbox email,
    ILogger<BillingNotices> logger,
    TimeProvider time)
{
    public const string Kind = "plan";

    private readonly List<UserNotification> _created = [];

    public async Task AddAsync(long userId, string title, string body, Func<string, EmailContent>? emailFor = null, CancellationToken cancellationToken = default)
    {
        var notification = new UserNotification { UserId = userId, Kind = Kind, Title = title, Body = body, CreatedAt = time.GetUtcNow() };
        db.UserNotifications.Add(notification);
        _created.Add(notification);

        if (await db.TelegramLinks.AsNoTracking().Where(l => l.UserId == userId).Select(l => (long?)l.ChatId).SingleOrDefaultAsync(cancellationToken) is { } chatId)
        {
            telegram.Add(chatId, $"{title}\n{body}");
        }

        if (emailFor is not null
            && await db.Users.AsNoTracking().Where(u => u.Id == userId && u.EmailConfirmed).Select(u => new { u.Email, u.DisplayName }).SingleOrDefaultAsync(cancellationToken) is { Email: { } to } user)
        {
            email.Add(to, emailFor(user.DisplayName));
        }
    }

    /// <summary>Pushes the saved messages to open apps and pages, and starts the outboxes. Call after the commit.</summary>
    public async Task FlushAsync()
    {
        telegram.SendSoon();
        email.SendSoon();
        foreach (var notification in _created)
        {
            try
            {
                await hub.Clients.User(notification.UserId.ToString(CultureInfo.InvariantCulture)).NotificationCreated(NotificationEndpoints.ToDto(notification));
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                LogPushFailed(logger, notification.UserId, e);
            }
        }

        _created.Clear();
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "A plan notification for account {UserId} could not be pushed")]
    private static partial void LogPushFailed(ILogger logger, long userId, Exception exception);
}
