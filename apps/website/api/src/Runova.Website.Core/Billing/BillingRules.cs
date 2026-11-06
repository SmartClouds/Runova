namespace Runova.Website.Core.Billing;

/// <summary>Who a subscription was paid through.</summary>
public static class BillingProviders
{
    public const string Stripe = "stripe";
    public const string NowPayments = "nowpayments";

    /// <summary>Given by an Admin, with or without an end date.</summary>
    public const string Manual = "manual";

    public static readonly IReadOnlySet<string> All = new HashSet<string>(StringComparer.Ordinal) { Stripe, NowPayments, Manual };
}

/// <summary>Where a subscription stands. Only <see cref="Active"/> and <see cref="PastDue"/> give the account its type.</summary>
public static class SubscriptionStatuses
{
    public const string Active = "active";

    /// <summary>A card payment failed; the type stays until the period ends while Stripe tries again.</summary>
    public const string PastDue = "past_due";

    /// <summary>Ended before its time: canceled in Stripe, or taken away by an Admin.</summary>
    public const string Canceled = "canceled";

    /// <summary>The period ran out.</summary>
    public const string Expired = "expired";

    public static bool Entitles(string status) => status is Active or PastDue;
}

/// <summary>Where a payment stands.</summary>
public static class PaymentStatuses
{
    public const string Pending = "pending";
    public const string Paid = "paid";
    public const string Failed = "failed";
    public const string Expired = "expired";
}

/// <summary>
/// What an account type allows (E53): how many online monitors, the shortest interval in seconds,
/// and how many days of raw results are kept. No monitor limit means unlimited.
/// </summary>
public sealed record Entitlement(long AccountTypeId, string Key, string Name, int? MaxCloudMonitors, int MinIntervalSec, int HistoryDays, bool IsFree)
{
    public bool AllowsMonitors(int count) => MaxCloudMonitors is null || count <= MaxCloudMonitors.Value;

    public bool AllowsInterval(int seconds) => seconds >= MinIntervalSec;

    /// <summary>
    /// The most generous of several, for a team with more than one owner: more monitors first
    /// (unlimited above all), then the shorter interval, then the longer history.
    /// </summary>
    public static Entitlement Best(IEnumerable<Entitlement> entitlements) =>
        entitlements
            .OrderByDescending(e => e.MaxCloudMonitors ?? int.MaxValue)
            .ThenBy(e => e.MinIntervalSec)
            .ThenByDescending(e => e.HistoryDays)
            .FirstOrDefault() ?? throw new InvalidOperationException("There is no account type to choose from.");
}

/// <summary>Prepaid periods, bought with crypto (or given by an Admin): no renewals, an end date.</summary>
public static class Prepaid
{
    public static readonly IReadOnlyList<int> DefaultMonths = [1, 3, 12];

    /// <summary>The same type again: the months go on the end date, or on now when it already passed.</summary>
    public static DateTimeOffset Extend(DateTimeOffset now, DateTimeOffset? currentEnd, int months)
    {
        var from = currentEnd is { } end && end > now ? end : now;
        return from.AddMonths(months);
    }

    /// <summary>
    /// Another type: it starts now for the months bought, and the time left on the old one is
    /// added at the ratio of the two monthly prices. A free or unpriced old type carries nothing.
    /// </summary>
    public static DateTimeOffset Switch(DateTimeOffset now, DateTimeOffset? currentEnd, long oldMonthlyCents, long newMonthlyCents, int months)
    {
        var end = now.AddMonths(months);
        if (currentEnd is not { } oldEnd || oldEnd <= now || oldMonthlyCents <= 0 || newMonthlyCents <= 0)
        {
            return end;
        }

        var left = oldEnd - now;
        return end + TimeSpan.FromTicks((long)(left.Ticks * ((double)oldMonthlyCents / newMonthlyCents)));
    }

    /// <summary>The price of a number of months: the yearly price for 12 when there is one, else the monthly one times months.</summary>
    public static long? PriceCents(int? monthlyCents, int? yearlyCents, int months)
    {
        if (months == 12 && yearlyCents is { } yearly)
        {
            return yearly;
        }

        return monthlyCents is { } monthly ? (long)monthly * months : null;
    }
}
