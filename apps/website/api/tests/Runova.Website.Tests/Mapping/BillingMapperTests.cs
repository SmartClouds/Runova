using Runova.Website.Api.Billing;
using Runova.Website.Core.Billing;
using Runova.Website.Data.Billing;
using Runova.Website.Data.Identity;

namespace Runova.Website.Tests.Mapping;

public class BillingMapperTests
{
    private static readonly DateTimeOffset _at = new(2026, 10, 1, 8, 0, 0, TimeSpan.Zero);

    private static readonly AccountType _pro = new()
    {
        Id = 2,
        Key = "pro",
        Name = "Pro",
        Description = "For teams.",
        Features = ["Ten monitors"],
        SortOrder = 1,
        IsFree = false,
        IsActive = true,
        Highlight = true,
        MaxCloudMonitors = 10,
        MinIntervalSec = 60,
        HistoryDays = 90,
        EncryptedItems = true,
        MonthlyPriceCents = 900,
        YearlyPriceCents = 9000,
        Currency = "usd",
        StripeProductId = "prod_1",
        Version = 5,
    };

    private static Payment Payment(string status) => new()
    {
        Id = 7,
        UserId = 3,
        Provider = BillingProviders.NowPayments,
        OrderId = "order-7",
        ProviderPaymentId = "np-7",
        AccountTypeId = 2,
        Months = 3,
        AmountCents = 2700,
        Currency = "usd",
        Status = status,
        ProviderStatus = "waiting",
        InvoiceUrl = "https://nowpayments.io/invoice/7",
        CreatedAt = _at,
        PaidAt = null,
    };

    [Fact]
    public void An_account_type_and_a_subscription_map_without_stripe_ids()
    {
        var subscription = new Subscription
        {
            Id = 4,
            UserId = 3,
            AccountTypeId = 2,
            Provider = BillingProviders.Stripe,
            ProviderRef = "sub_1",
            Status = SubscriptionStatuses.Active,
            StartedAt = _at,
            CurrentPeriodEnd = _at.AddMonths(1),
            CancelAtPeriodEnd = true,
        };

        var type = BillingMapper.ToDto(_pro);

        Assert.Equal(
            new AccountTypeDto(2, "pro", "Pro", "For teams.", type.Features, 1, false, true, true, 10, 60, 90, true, 900, 9000, "usd", "5"),
            type);
        Assert.Equal(["Ten monitors"], type.Features);
        Assert.Equal(
            new SubscriptionDto(4, 2, "stripe", "active", _at, _at.AddMonths(1), true, null),
            BillingMapper.ToDto(subscription));
    }

    [Fact]
    public void A_payment_shows_its_invoice_link_only_while_it_waits()
    {
        var rows = new[]
        {
            new PaymentRow { Payment = Payment(PaymentStatuses.Pending), AccountType = _pro },
            new PaymentRow { Payment = Payment(PaymentStatuses.Expired), AccountType = _pro },
        };

        var dtos = rows.AsQueryable().ProjectToDto().ToList();

        Assert.Equal(
            new PaymentDto(7, "nowpayments", 2, "Pro", 3, 2700, "usd", "pending", "waiting", "https://nowpayments.io/invoice/7", _at, null),
            dtos[0]);
        Assert.Null(dtos[1].InvoiceUrl);
    }

    [Fact]
    public void An_admin_payment_adds_whose_it_is_and_the_order()
    {
        var row = new AdminPaymentRow
        {
            Payment = Payment(PaymentStatuses.Paid),
            AccountType = _pro,
            User = new AppUser { Id = 3, Email = "sam@example.com", PasswordHash = "hash" },
        };

        Assert.Equal(
            new AdminPaymentDto(7, 3, "sam@example.com", "nowpayments", "order-7", 2, "Pro", 3, 2700, "usd", "paid", "waiting", _at, null),
            Assert.Single(new[] { row }.AsQueryable().ProjectToDto()));
    }

    [Fact]
    public void The_dtos_carry_no_secret()
    {
        Assert.Empty(SecretProperties.In(typeof(AccountTypeDto)));
        Assert.Empty(SecretProperties.In(typeof(SubscriptionDto)));
        Assert.Empty(SecretProperties.In(typeof(PaymentDto)));
        Assert.Empty(SecretProperties.In(typeof(AdminPaymentDto)));
    }
}
