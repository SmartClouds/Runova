using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Api.Notifications;
using Runova.Website.Api.Telegram;
using Runova.Website.Core.Dependencies;
using Runova.Website.Data;
using Runova.Website.Data.Accounts;
using Runova.Website.Data.Dependencies;

namespace Runova.Website.Api.Dependencies;

/// <summary>
/// Tells people about what a check found (E51). Everyone who can see the inventory's scope is
/// told: the account for a personal project, each member of the team for a team's. Each person
/// hears only about the kinds they asked for, nothing about a project they muted, and nothing
/// twice: a finding's key is kept once it was told. A message goes to the app and the website
/// (saved, then pushed live over SignalR), and to Telegram when the account linked a chat.
/// </summary>
internal sealed partial class AlertNotifier(
    AppDbContext db,
    IHubContext<NotificationsHub, INotificationsClient> hub,
    TelegramOutbox telegram,
    NotificationDelivery delivery,
    FindingsReader findings,
    TimeProvider time,
    ILogger<AlertNotifier> logger)
{
    public const string Kind = "dependency-updates";

    /// <summary>The accounts that can see a scope and are not disabled.</summary>
    public async Task<IReadOnlyList<long>> MembersAsync(long scopeId, CancellationToken cancellationToken = default)
    {
        var scope = await db.SyncScopes.AsNoTracking().SingleOrDefaultAsync(s => s.Id == scopeId, cancellationToken);
        IQueryable<long> members = scope switch
        {
            { Kind: SyncScopeKinds.Personal, UserId: { } userId } => db.Users.Where(u => u.Id == userId).Select(u => u.Id),
            { Kind: SyncScopeKinds.Team, TeamId: { } teamId } => db.TeamMembers.Where(m => m.TeamId == teamId).Select(m => m.UserId),
            _ => db.Users.Where(_ => false).Select(u => u.Id),
        };
        return await db.Users.Where(u => members.Contains(u.Id) && u.DisabledAt == null).Select(u => u.Id).ToListAsync(cancellationToken);
    }

    public async Task ChecksFoundAsync(PackageInventory inventory, IReadOnlyList<DependencyFinding> current, CancellationToken cancellationToken)
    {
        var members = await MembersAsync(inventory.ScopeId, cancellationToken);
        if (members.Count == 0)
        {
            return;
        }

        var settings = await db.DependencyAlertSettings.AsNoTracking().Where(s => members.Contains(s.UserId)).ToDictionaryAsync(s => s.UserId, cancellationToken);
        var muted = (await db.MutedProjects.AsNoTracking().Where(m => m.InventoryId == inventory.Id && members.Contains(m.UserId)).Select(m => m.UserId).ToListAsync(cancellationToken)).ToHashSet();
        var keys = current.Select(f => f.Key).ToList();
        var told = (await db.DependencyAlertDeliveries.AsNoTracking().Where(d => members.Contains(d.UserId) && keys.Contains(d.Key)).Select(d => new { d.UserId, d.Key }).ToListAsync(cancellationToken))
            .Select(d => (d.UserId, d.Key)).ToHashSet();
        var links = await db.TelegramLinks.AsNoTracking().Where(l => members.Contains(l.UserId)).ToDictionaryAsync(l => l.UserId, l => l.ChatId, cancellationToken);
        var now = time.GetUtcNow();
        var created = new List<UserNotification>();

        foreach (var userId in members)
        {
            var row = settings.GetValueOrDefault(userId);
            var preferences = AlertSettingsStore.ToPreferences(row);
            if (!preferences.Enabled || muted.Contains(userId))
            {
                continue;
            }

            var news = current
                .Where(f => !told.Contains((userId, f.Key)))
                .Select(f => (Row: f, Finding: DependencyMapper.ToFinding(f)))
                .Where(f => AlertPolicy.Wants(preferences, f.Finding))
                .ToList();
            if (news.Count == 0)
            {
                continue;
            }

            foreach (var (finding, _) in news)
            {
                db.DependencyAlertDeliveries.Add(new DependencyAlertDelivery { UserId = userId, Key = finding.Key, At = now });
            }

            var tell = news.Select(f => f.Finding).ToList();
            if (row?.InApp ?? true)
            {
                var notification = new UserNotification
                {
                    UserId = userId,
                    Kind = Kind,
                    Title = Clip(AlertMessages.Title(inventory.ProjectName, tell), 300),
                    Body = AlertMessages.Body(tell),
                    Severity = AlertPolicy.WorstSeverity(tell),
                    ScopeId = inventory.ScopeId,
                    ItemId = inventory.ItemId,
                    InventoryId = inventory.Id,
                    CreatedAt = now,
                };
                db.UserNotifications.Add(notification);
                created.Add(notification);
            }

            if ((row?.Telegram ?? true) && links.TryGetValue(userId, out var chatId))
            {
                telegram.Add(chatId, AlertMessages.Telegram(inventory.ProjectName, tell));
            }
        }

        await db.SaveChangesAsync(cancellationToken);
        telegram.SendSoon();

        await delivery.DeliverAsync(created, cancellationToken);

        await SummaryChangedAsync(members, cancellationToken);
    }

    /// <summary>Tells each account's open apps and pages to read the findings again.</summary>
    public async Task SummaryChangedAsync(IEnumerable<long> userIds, CancellationToken cancellationToken = default)
    {
        foreach (var userId in userIds.Distinct())
        {
            var summary = await findings.ForAsync(userId);
            var dto = new DependencySummaryDto(summary.Total, summary.Items.Count(i => i.Total > 0));
            await PushAsync(userId, client => client.DependencySummaryChanged(dto));
            cancellationToken.ThrowIfCancellationRequested();
        }
    }

    // A push that fails loses nothing: the message is saved, and an app reads them all when it connects.
    private async Task PushAsync(long userId, Func<INotificationsClient, Task> send)
    {
        try
        {
            await send(hub.Clients.User(userId.ToString(System.Globalization.CultureInfo.InvariantCulture)));
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            LogPushFailed(logger, userId, e);
        }
    }

    private static string Clip(string text, int length) => text.Length <= length ? text : text[..length];

    [LoggerMessage(Level = LogLevel.Warning, Message = "A live notification for account {UserId} could not be pushed")]
    private static partial void LogPushFailed(ILogger logger, long userId, Exception exception);
}
