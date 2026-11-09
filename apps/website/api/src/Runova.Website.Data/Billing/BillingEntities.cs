namespace Runova.Website.Data.Billing;

/// <summary>
/// A type of account an Admin defines (E53): what it allows and what it costs. The Free type
/// (<see cref="IsFree"/>) is the one every account without a paid type is on; there is exactly one
/// and it can not be archived. Prices are in the smallest unit of <see cref="Currency"/>.
/// </summary>
public class AccountType
{
    public const long FreeId = 1;

    public long Id { get; set; }

    /// <summary>A short lower-case name for code and links, such as <c>pro</c>. Never changes.</summary>
    public string Key { get; set; } = "";

    public string Name { get; set; } = "";

    public string Description { get; set; } = "";

    /// <summary>The lines the plan cards list, in order.</summary>
    public string[] Features { get; set; } = [];

    public int SortOrder { get; set; }

    public bool IsFree { get; set; }

    /// <summary>Archived types are not offered; accounts already on one keep it until it ends.</summary>
    public bool IsActive { get; set; } = true;

    /// <summary>Shown as the one to pick.</summary>
    public bool Highlight { get; set; }

    /// <summary>Active online monitors allowed; null for unlimited.</summary>
    public int? MaxCloudMonitors { get; set; }

    /// <summary>The shortest interval an online monitor may have, in seconds.</summary>
    public int MinIntervalSec { get; set; }

    /// <summary>How long raw results are kept. Hourly figures and incidents are kept for good.</summary>
    public int HistoryDays { get; set; }

    /// <summary>Whether accounts on this type can seal forwarded notifications and whole sync records (E92).</summary>
    public bool EncryptedItems { get; set; }

    public int? MonthlyPriceCents { get; set; }

    public int? YearlyPriceCents { get; set; }

    /// <summary>ISO 4217, lower case, as Stripe writes it.</summary>
    public string Currency { get; set; } = "usd";

    public string? StripeProductId { get; set; }

    public string? StripeMonthlyPriceId { get; set; }

    /// <summary>The amount the Stripe monthly price was made with; a new amount needs a new price.</summary>
    public int? StripeMonthlyPriceCents { get; set; }

    public string? StripeYearlyPriceId { get; set; }

    public int? StripeYearlyPriceCents { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public DateTimeOffset? UpdatedAt { get; set; }

    /// <summary>PostgreSQL's <c>xmin</c>.</summary>
    public uint Version { get; set; }
}

/// <summary>
/// An account's paid (or given) type for a period. An account has at most one that is active or
/// past due at a time; ended ones stay as its history.
/// </summary>
public class Subscription
{
    public long Id { get; set; }

    public long UserId { get; set; }

    public long AccountTypeId { get; set; }

    /// <summary>One of <c>BillingProviders</c>.</summary>
    public string Provider { get; set; } = "";

    /// <summary>Stripe's subscription id; null for crypto and manual ones.</summary>
    public string? ProviderRef { get; set; }

    /// <summary>One of <c>SubscriptionStatuses</c>.</summary>
    public string Status { get; set; } = "";

    public DateTimeOffset StartedAt { get; set; }

    /// <summary>When the type ends unless it renews; null for a manual one with no end.</summary>
    public DateTimeOffset? CurrentPeriodEnd { get; set; }

    /// <summary>Stripe only: canceled, it ends at the period's end instead of renewing.</summary>
    public bool CancelAtPeriodEnd { get; set; }

    public DateTimeOffset? EndedAt { get; set; }

    /// <summary>When the "ends in 7 days" reminder went out, so it goes once.</summary>
    public DateTimeOffset? RemindedWeekAt { get; set; }

    /// <summary>When the "ends tomorrow" reminder went out.</summary>
    public DateTimeOffset? RemindedDayAt { get; set; }

    /// <summary>The Admin who gave it, for a manual one.</summary>
    public long? GrantedBy { get; set; }

    /// <summary>PostgreSQL's <c>xmin</c>.</summary>
    public uint Version { get; set; }
}

/// <summary>The Stripe customer an account pays as, made at its first card checkout.</summary>
public class BillingCustomer
{
    public long UserId { get; set; }

    public string StripeCustomerId { get; set; } = "";

    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>
/// One payment: a crypto invoice from the moment it is made, or a paid or failed Stripe invoice.
/// <see cref="OrderId"/> is ours, sent to the provider and checked when it answers.
/// </summary>
public class Payment
{
    public long Id { get; set; }

    public long UserId { get; set; }

    public string Provider { get; set; } = "";

    public string OrderId { get; set; } = "";

    /// <summary>The provider's own id: the NOWPayments invoice, or the Stripe invoice.</summary>
    public string? ProviderPaymentId { get; set; }

    public long AccountTypeId { get; set; }

    /// <summary>The months a crypto payment buys; null for a card payment, which renews.</summary>
    public int? Months { get; set; }

    public long AmountCents { get; set; }

    public string Currency { get; set; } = "usd";

    /// <summary>One of <c>PaymentStatuses</c>.</summary>
    public string Status { get; set; } = "";

    /// <summary>What the provider last said, such as <c>partially_paid</c>.</summary>
    public string? ProviderStatus { get; set; }

    public string? InvoiceUrl { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public DateTimeOffset? PaidAt { get; set; }
}

/// <summary>A webhook event already acted on, so a replay changes nothing.</summary>
public class ProcessedPaymentEvent
{
    public string Provider { get; set; } = "";

    public string EventId { get; set; } = "";

    public DateTimeOffset At { get; set; }
}

/// <summary>
/// The Admin's payment switches and keys (E53). One row, id 1, made by the migration. Secrets are
/// sealed with Data Protection and never leave the API.
/// </summary>
public sealed class PaymentSettings
{
    public const int SingletonId = 1;

    public int Id { get; set; } = SingletonId;

    public bool StripeEnabled { get; set; }

    public string? StripePublishableKey { get; set; }

    public string? StripeSecretKeySealed { get; set; }

    public string? StripeWebhookSecretSealed { get; set; }

    public bool NowPaymentsEnabled { get; set; }

    public string? NowPaymentsApiKeySealed { get; set; }

    public string? NowPaymentsIpnSecretSealed { get; set; }

    /// <summary>Use the NOWPayments sandbox instead of the real API.</summary>
    public bool NowPaymentsSandbox { get; set; }

    /// <summary>The periods crypto can buy, in months.</summary>
    public int[] CryptoMonths { get; set; } = [1, 3, 12];

    public DateTimeOffset? UpdatedAt { get; set; }

    public uint Version { get; set; }
}
