using Riok.Mapperly.Abstractions;
using Runova.Website.Data.Billing;

namespace Runova.Website.Api.Billing;

/// <summary>An account type as plan cards and the admin show it. Stripe's ids stay on the server.</summary>
public sealed record AccountTypeDto(
    long Id,
    string Key,
    string Name,
    string Description,
    IReadOnlyList<string> Features,
    int SortOrder,
    bool IsFree,
    bool IsActive,
    bool Highlight,
    int? MaxCloudMonitors,
    int MinIntervalSec,
    int HistoryDays,
    int? MonthlyPriceCents,
    int? YearlyPriceCents,
    string Currency,
    string Version);

/// <summary>An account's subscription: its type for a period.</summary>
public sealed record SubscriptionDto(
    long Id,
    long AccountTypeId,
    string Provider,
    string Status,
    DateTimeOffset StartedAt,
    DateTimeOffset? CurrentPeriodEnd,
    bool CancelAtPeriodEnd,
    DateTimeOffset? EndedAt);

[Mapper(RequiredMappingStrategy = RequiredMappingStrategy.Target)]
internal static partial class BillingMapper
{
    public static partial AccountTypeDto ToDto(AccountType type);

    public static partial SubscriptionDto ToDto(Subscription subscription);

    private static string VersionToString(uint version) => version.ToString(System.Globalization.CultureInfo.InvariantCulture);
}
