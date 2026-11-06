using System.Globalization;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Core.Billing;
using Runova.Website.Data;
using Runova.Website.Data.Billing;

namespace Runova.Website.Api.Billing;

/// <summary>
/// Writes subscriptions (E53), keeping to one rule: an account has at most one subscription that
/// gives it a type. A card subscription is Stripe's to change; a prepaid one (crypto or given by an
/// Admin) is extended, or replaced with the time left carried over at the price ratio.
/// Callers save.
/// </summary>
internal sealed class SubscriptionBook(AppDbContext db, TimeProvider time)
{
    /// <summary>The subscription that gives the account its type now, tracked, or null.</summary>
    public async Task<Subscription?> CurrentAsync(long userId, CancellationToken cancellationToken = default)
    {
        var now = time.GetUtcNow();
        return await db.Subscriptions
            .Where(s => s.UserId == userId && (s.Status == SubscriptionStatuses.Active || s.Status == SubscriptionStatuses.PastDue))
            .Where(s => s.CurrentPeriodEnd == null || s.CurrentPeriodEnd > now)
            .SingleOrDefaultAsync(cancellationToken);
    }

    /// <summary>Ends a subscription now, as canceled (taken away, replaced) or expired (its time ran out).</summary>
    public void End(Subscription subscription, string status)
    {
        subscription.Status = status;
        subscription.EndedAt = time.GetUtcNow();
    }

    /// <summary>Ends any subscription still marked as giving a type, even one whose period passed and the expiry job has not seen yet.</summary>
    private async Task EndEntitlingAsync(long userId, long? exceptId, CancellationToken cancellationToken)
    {
        var open = await db.Subscriptions
            .Where(s => s.UserId == userId && s.Id != exceptId && (s.Status == SubscriptionStatuses.Active || s.Status == SubscriptionStatuses.PastDue))
            .ToListAsync(cancellationToken);
        foreach (var subscription in open)
        {
            End(subscription, subscription.CurrentPeriodEnd is { } end && end <= time.GetUtcNow() ? SubscriptionStatuses.Expired : SubscriptionStatuses.Canceled);
        }

        if (open.Count > 0)
        {
            // The partial unique index is checked per statement, so the old row must be ended first.
            await db.SaveChangesAsync(cancellationToken);
        }
    }

    /// <summary>
    /// Credits months bought with crypto: the same type is extended, another type replaces the
    /// current prepaid one with its time left carried over. Returns the subscription that now applies.
    /// </summary>
    public async Task<Subscription> CreditPrepaidAsync(long userId, AccountType type, int months, string provider, CancellationToken cancellationToken = default)
    {
        var now = time.GetUtcNow();
        var current = await CurrentAsync(userId, cancellationToken);
        if (current is not null && current.Provider != BillingProviders.Stripe && current.AccountTypeId == type.Id)
        {
            current.CurrentPeriodEnd = Prepaid.Extend(now, current.CurrentPeriodEnd, months);
            current.Provider = provider;
            current.RemindedWeekAt = null;
            current.RemindedDayAt = null;
            return current;
        }

        var end = now.AddMonths(months);
        if (current is not null && current.Provider != BillingProviders.Stripe)
        {
            var oldPrice = await db.AccountTypes.Where(t => t.Id == current.AccountTypeId).Select(t => t.MonthlyPriceCents).SingleOrDefaultAsync(cancellationToken) ?? 0;
            end = Prepaid.Switch(now, current.CurrentPeriodEnd, oldPrice, type.MonthlyPriceCents ?? Prepaid.PriceCents(null, type.YearlyPriceCents, 12) / 12 ?? 0, months);
        }

        await EndEntitlingAsync(userId, null, cancellationToken);
        var subscription = new Subscription
        {
            UserId = userId,
            AccountTypeId = type.Id,
            Provider = provider,
            Status = SubscriptionStatuses.Active,
            StartedAt = now,
            CurrentPeriodEnd = end,
        };
        db.Subscriptions.Add(subscription);
        return subscription;
    }

    /// <summary>An Admin's grant: replaces any prepaid subscription. A card one has to be canceled in Stripe first.</summary>
    public async Task<Subscription> GrantAsync(long userId, AccountType type, DateTimeOffset? endsAt, long adminId, CancellationToken cancellationToken = default)
    {
        await EndEntitlingAsync(userId, null, cancellationToken);
        var subscription = new Subscription
        {
            UserId = userId,
            AccountTypeId = type.Id,
            Provider = BillingProviders.Manual,
            Status = SubscriptionStatuses.Active,
            StartedAt = time.GetUtcNow(),
            CurrentPeriodEnd = endsAt,
            GrantedBy = adminId,
        };
        db.Subscriptions.Add(subscription);
        return subscription;
    }

    /// <summary>
    /// Brings our copy of a Stripe subscription up to date from an event. The account comes from the
    /// metadata the checkout set, or from the customer; the type from the price. Returns the account
    /// whose type may have changed, or null when the event was not about one of ours.
    /// </summary>
    public async Task<long?> ApplyStripeAsync(Stripe.Subscription stripe, CancellationToken cancellationToken = default)
    {
        var userId = stripe.Metadata?.GetValueOrDefault(StripeGateway.UserIdKey) is { } raw && long.TryParse(raw, CultureInfo.InvariantCulture, out var fromMetadata)
            ? fromMetadata
            : await db.BillingCustomers.Where(c => c.StripeCustomerId == stripe.CustomerId).Select(c => (long?)c.UserId).SingleOrDefaultAsync(cancellationToken);
        if (userId is null || !await db.Users.AnyAsync(u => u.Id == userId, cancellationToken))
        {
            return null;
        }

        var item = stripe.Items?.Data?.FirstOrDefault();
        var priceId = item?.Price?.Id;
        var type = priceId is null
            ? null
            : await db.AccountTypes.SingleOrDefaultAsync(t => t.StripeMonthlyPriceId == priceId || t.StripeYearlyPriceId == priceId, cancellationToken);
        if (type is null && stripe.Metadata?.GetValueOrDefault(StripeGateway.AccountTypeIdKey) is { } typeRaw && long.TryParse(typeRaw, CultureInfo.InvariantCulture, out var typeId))
        {
            type = await db.AccountTypes.SingleOrDefaultAsync(t => t.Id == typeId, cancellationToken);
        }

        var status = stripe.Status switch
        {
            "active" or "trialing" => SubscriptionStatuses.Active,
            "past_due" or "unpaid" => SubscriptionStatuses.PastDue,
            "incomplete" => null,
            _ => SubscriptionStatuses.Canceled,
        };
        var periodEnd = item is not null && item.CurrentPeriodEnd > DateTime.UnixEpoch ? new DateTimeOffset(DateTime.SpecifyKind(item.CurrentPeriodEnd, DateTimeKind.Utc)) : (DateTimeOffset?)null;

        var row = await db.Subscriptions.SingleOrDefaultAsync(s => s.Provider == BillingProviders.Stripe && s.ProviderRef == stripe.Id, cancellationToken);
        if (row is null)
        {
            if (status is null || !SubscriptionStatuses.Entitles(status) || type is null)
            {
                return null;
            }

            await EndEntitlingAsync(userId.Value, null, cancellationToken);
            row = new Subscription
            {
                UserId = userId.Value,
                Provider = BillingProviders.Stripe,
                ProviderRef = stripe.Id,
                StartedAt = time.GetUtcNow(),
            };
            db.Subscriptions.Add(row);
        }
        else if (status is not null && SubscriptionStatuses.Entitles(status) && !SubscriptionStatuses.Entitles(row.Status))
        {
            await EndEntitlingAsync(userId.Value, row.Id, cancellationToken);
        }

        if (type is not null)
        {
            row.AccountTypeId = type.Id;
        }

        if (status is not null)
        {
            row.Status = status;
            row.EndedAt = SubscriptionStatuses.Entitles(status) ? null : row.EndedAt ?? time.GetUtcNow();
        }

        row.CurrentPeriodEnd = periodEnd ?? row.CurrentPeriodEnd;
        row.CancelAtPeriodEnd = stripe.CancelAtPeriodEnd;
        return userId;
    }
}
