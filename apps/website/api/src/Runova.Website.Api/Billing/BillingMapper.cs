using Riok.Mapperly.Abstractions;
using Runova.Website.Core.Billing;
using Runova.Website.Data.Billing;
using Runova.Website.Data.Identity;

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

/// <summary>A payment joined with its account type.</summary>
internal sealed record PaymentRow
{
    public required Payment Payment { get; init; }

    public required AccountType AccountType { get; init; }
}

/// <summary>A payment joined with its account type and the account that made it.</summary>
internal sealed record AdminPaymentRow
{
    public required Payment Payment { get; init; }

    public required AccountType AccountType { get; init; }

    public required AppUser User { get; init; }
}

[Mapper]
internal static partial class BillingMapper
{
    public static partial AccountTypeDto ToDto(AccountType type);

    public static partial SubscriptionDto ToDto(Subscription subscription);

    public static partial IQueryable<PaymentDto> ProjectToDto(this IQueryable<PaymentRow> rows);

    public static partial IQueryable<AdminPaymentDto> ProjectToDto(this IQueryable<AdminPaymentRow> rows);

    [MapNestedProperties(nameof(PaymentRow.Payment))]
    [MapProperty([nameof(PaymentRow.Payment), nameof(Payment.AccountTypeId)], nameof(PaymentDto.AccountTypeId))]
    [MapProperty([nameof(PaymentRow.AccountType), nameof(AccountType.Name)], nameof(PaymentDto.AccountTypeName))]
    [MapPropertyFromSource(nameof(PaymentDto.InvoiceUrl), Use = nameof(PendingInvoiceUrl))]
    private static partial PaymentDto ToDto(PaymentRow row);

    [MapNestedProperties(nameof(AdminPaymentRow.Payment))]
    [MapProperty([nameof(AdminPaymentRow.Payment), nameof(Payment.UserId)], nameof(AdminPaymentDto.UserId))]
    [MapProperty([nameof(AdminPaymentRow.User), nameof(AppUser.Email)], nameof(AdminPaymentDto.Email))]
    [MapProperty([nameof(AdminPaymentRow.Payment), nameof(Payment.AccountTypeId)], nameof(AdminPaymentDto.AccountTypeId))]
    [MapProperty([nameof(AdminPaymentRow.AccountType), nameof(AccountType.Name)], nameof(AdminPaymentDto.AccountTypeName))]
    private static partial AdminPaymentDto ToDto(AdminPaymentRow row);

    // The invoice link is only of use while the payment waits. Inlined into the SQL.
    private static string? PendingInvoiceUrl(PaymentRow row) =>
        row.Payment.Status == PaymentStatuses.Pending ? row.Payment.InvoiceUrl : null;

    private static string VersionToString(uint version) => version.ToString(System.Globalization.CultureInfo.InvariantCulture);
}
