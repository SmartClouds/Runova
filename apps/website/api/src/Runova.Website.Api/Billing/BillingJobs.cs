using System.Globalization;
using Hangfire;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Api.Http;
using Runova.Website.Core.Billing;
using Runova.Website.Core.Email;
using Runova.Website.Data;

namespace Runova.Website.Api.Billing;

/// <summary>
/// Ends subscriptions whose period is over (E53) and brings the account's monitors within Free. A
/// card subscription gets three days' grace, since Stripe's own event usually comes first.
/// </summary>
[DisableConcurrentExecution(timeoutInSeconds: 300)]
internal sealed partial class SubscriptionExpiryJob(
    AppDbContext db, SubscriptionBook book, BillingNotices notices, IPlanEnforcement enforcement, IConfiguration configuration, TimeProvider time,
    ILogger<SubscriptionExpiryJob> logger)
{
    public static readonly TimeSpan CardGrace = TimeSpan.FromDays(3);

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var cardCutoff = now - CardGrace;
        var due = await db.Subscriptions
            .Where(s => (s.Status == SubscriptionStatuses.Active || s.Status == SubscriptionStatuses.PastDue) && s.CurrentPeriodEnd != null)
            .Where(s => s.Provider == BillingProviders.Stripe ? s.CurrentPeriodEnd <= cardCutoff : s.CurrentPeriodEnd <= now)
            .ToListAsync(cancellationToken);
        if (due.Count == 0)
        {
            return;
        }

        var names = await db.AccountTypes.AsNoTracking().ToDictionaryAsync(t => t.Id, t => t.Name, cancellationToken);
        var link = SiteUrl.From(configuration) + "/account/plan";
        foreach (var subscription in due)
        {
            book.End(subscription, SubscriptionStatuses.Expired);
            await notices.AddAsync(
                subscription.UserId,
                "Your plan ended",
                $"Your {names.GetValueOrDefault(subscription.AccountTypeId, "paid")} plan ended, so this account is on Free now. Renew it from your Plan page.",
                name => EmailTemplates.PlanEnded(name, names.GetValueOrDefault(subscription.AccountTypeId, "paid"), link),
                cancellationToken);
        }

        await db.SaveChangesAsync(cancellationToken);
        await notices.FlushAsync();
        foreach (var userId in due.Select(s => s.UserId).Distinct())
        {
            await enforcement.AccountChangedAsync(userId, cancellationToken);
        }

        LogExpired(logger, due.Count);
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Ended {Count} subscriptions whose period was over")]
    private static partial void LogExpired(ILogger logger, int count);
}

/// <summary>
/// Reminds accounts on a prepaid crypto plan that it ends soon (E53): a week before, and the day
/// before, once each. A card plan renews by itself and an Admin's grant is the Admin's to renew.
/// </summary>
[DisableConcurrentExecution(timeoutInSeconds: 300)]
internal sealed class RenewalReminderJob(AppDbContext db, BillingNotices notices, IConfiguration configuration, TimeProvider time)
{
    public async Task RunAsync(CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var week = now.AddDays(7);
        var day = now.AddDays(1);
        var ending = await db.Subscriptions
            .Where(s => s.Provider == BillingProviders.NowPayments && s.Status == SubscriptionStatuses.Active)
            .Where(s => s.CurrentPeriodEnd > now && s.CurrentPeriodEnd <= week)
            .Where(s => s.RemindedWeekAt == null || (s.CurrentPeriodEnd <= day && s.RemindedDayAt == null))
            .ToListAsync(cancellationToken);
        var names = await db.AccountTypes.AsNoTracking().ToDictionaryAsync(t => t.Id, t => t.Name, cancellationToken);
        var link = SiteUrl.From(configuration) + "/account/plan";
        foreach (var subscription in ending)
        {
            var name = names.GetValueOrDefault(subscription.AccountTypeId, "paid");
            var end = subscription.CurrentPeriodEnd!.Value;
            var when = end.ToString("d MMMM yyyy", CultureInfo.InvariantCulture);
            if (end <= day)
            {
                subscription.RemindedDayAt = now;
                subscription.RemindedWeekAt ??= now;
                await notices.AddAsync(subscription.UserId, $"Your {name} plan ends tomorrow", $"It ends on {when}. Extend it from your Plan page to keep your online monitors running.",
                    person => EmailTemplates.PlanEnding(person, name, when, link), cancellationToken);
            }
            else
            {
                subscription.RemindedWeekAt = now;
                await notices.AddAsync(subscription.UserId, $"Your {name} plan ends in a week", $"It ends on {when}. Extend it from your Plan page whenever you like.",
                    person => EmailTemplates.PlanEnding(person, name, when, link), cancellationToken);
            }
        }

        await db.SaveChangesAsync(cancellationToken);
        await notices.FlushAsync();
    }
}
