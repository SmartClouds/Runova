using System.Globalization;
using Runova.Website.Data.Billing;
using Stripe;
using AccountType = Runova.Website.Data.Billing.AccountType;

namespace Runova.Website.Api.Billing;

/// <summary>Where Stripe's API is. Only tests and the e2e stack change it.</summary>
internal sealed class BillingOptions
{
    public Uri StripeApiBase { get; set; } = new("https://api.stripe.com");

    public Uri NowPaymentsApiBase { get; set; } = new("https://api.nowpayments.io/");

    public Uri NowPaymentsSandboxApiBase { get; set; } = new("https://api-sandbox.nowpayments.io/");
}

/// <summary>
/// Card payments through Stripe (E53), made with the keys an Admin saved. Products and prices are
/// made from the account types the first time a type is bought at a price; a new price makes a new
/// Stripe price, since Stripe prices can not change, and archives the old one.
/// </summary>
internal sealed class StripeGateway(IHttpClientFactory httpClients, Microsoft.Extensions.Options.IOptions<BillingOptions> options)
{
    public const string HttpClientName = "stripe";
    public const string Month = "month";
    public const string Year = "year";

    /// <summary>The <c>metadata</c> key that carries the account's id on Stripe's side.</summary>
    public const string UserIdKey = "runova_user_id";

    public const string AccountTypeIdKey = "runova_account_type_id";

    private StripeClient Client(PaymentConfig config) =>
        new(new StripeClientOptions
        {
            ApiKey = config.StripeSecretKey ?? throw new InvalidOperationException("Stripe has no secret key."),
            HttpClient = new SystemNetHttpClient(httpClients.CreateClient(HttpClientName)),
            ApiBase = options.Value.StripeApiBase.ToString().TrimEnd('/'),
        });

    public async Task<(bool Ok, string Detail)> CheckAsync(PaymentConfig config, CancellationToken cancellationToken)
    {
        try
        {
            var balance = await new BalanceService(Client(config)).GetAsync(cancellationToken: cancellationToken);
            return (true, balance.Livemode ? "Stripe took the key (live mode)." : "Stripe took the key (test mode).");
        }
        catch (StripeException e)
        {
            return (false, e.StripeError?.Message ?? "Stripe refused the key.");
        }
    }

    public async Task<string> CreateCustomerAsync(PaymentConfig config, long userId, string? email, string? name, CancellationToken cancellationToken)
    {
        var customer = await new CustomerService(Client(config)).CreateAsync(new CustomerCreateOptions
        {
            Email = email,
            Name = name,
            Metadata = new Dictionary<string, string> { [UserIdKey] = Id(userId) },
        }, cancellationToken: cancellationToken);
        return customer.Id;
    }

    /// <summary>
    /// The Stripe price for a type and interval, made (with the product) when there is none yet or
    /// the type's price changed since. The caller saves the type afterwards.
    /// </summary>
    public async Task<string> EnsurePriceAsync(PaymentConfig config, AccountType type, string interval, CancellationToken cancellationToken)
    {
        var client = Client(config);
        var amount = (interval == Year ? type.YearlyPriceCents : type.MonthlyPriceCents)
            ?? throw new InvalidOperationException($"The account type has no {interval}ly price.");
        var (priceId, priceCents) = interval == Year ? (type.StripeYearlyPriceId, type.StripeYearlyPriceCents) : (type.StripeMonthlyPriceId, type.StripeMonthlyPriceCents);
        if (priceId is not null && priceCents == amount)
        {
            return priceId;
        }

        if (type.StripeProductId is null)
        {
            var product = await new ProductService(client).CreateAsync(new ProductCreateOptions
            {
                Name = $"Runova {type.Name}",
                Metadata = new Dictionary<string, string> { [AccountTypeIdKey] = Id(type.Id) },
            }, cancellationToken: cancellationToken);
            type.StripeProductId = product.Id;
        }

        var prices = new PriceService(client);
        var price = await prices.CreateAsync(new PriceCreateOptions
        {
            Product = type.StripeProductId,
            UnitAmount = amount,
            Currency = type.Currency,
            Recurring = new PriceRecurringOptions { Interval = interval },
            Metadata = new Dictionary<string, string> { [AccountTypeIdKey] = Id(type.Id) },
        }, cancellationToken: cancellationToken);

        if (priceId is not null)
        {
            await prices.UpdateAsync(priceId, new PriceUpdateOptions { Active = false }, cancellationToken: cancellationToken);
        }

        if (interval == Year)
        {
            type.StripeYearlyPriceId = price.Id;
            type.StripeYearlyPriceCents = amount;
        }
        else
        {
            type.StripeMonthlyPriceId = price.Id;
            type.StripeMonthlyPriceCents = amount;
        }

        return price.Id;
    }

    public async Task<string> CreateCheckoutAsync(
        PaymentConfig config, string customerId, string priceId, long userId, long accountTypeId, string successUrl, string cancelUrl, CancellationToken cancellationToken)
    {
        var metadata = new Dictionary<string, string> { [UserIdKey] = Id(userId), [AccountTypeIdKey] = Id(accountTypeId) };
        var session = await new Stripe.Checkout.SessionService(Client(config)).CreateAsync(new Stripe.Checkout.SessionCreateOptions
        {
            Mode = "subscription",
            Customer = customerId,
            ClientReferenceId = Id(userId),
            LineItems = [new Stripe.Checkout.SessionLineItemOptions { Price = priceId, Quantity = 1 }],
            SuccessUrl = successUrl,
            CancelUrl = cancelUrl,
            Metadata = metadata,
            SubscriptionData = new Stripe.Checkout.SessionSubscriptionDataOptions { Metadata = metadata },
        }, cancellationToken: cancellationToken);
        return session.Url;
    }

    public async Task<string> CreatePortalAsync(PaymentConfig config, string customerId, string returnUrl, CancellationToken cancellationToken)
    {
        var session = await new Stripe.BillingPortal.SessionService(Client(config)).CreateAsync(
            new Stripe.BillingPortal.SessionCreateOptions { Customer = customerId, ReturnUrl = returnUrl }, cancellationToken: cancellationToken);
        return session.Url;
    }

    /// <summary>The event in a webhook's body, or null when its signature is wrong, too old, or the body unreadable.</summary>
    public static Event? ParseEvent(string json, string? signature, string webhookSecret)
    {
        if (string.IsNullOrWhiteSpace(signature))
        {
            return null;
        }

        try
        {
            return EventUtility.ConstructEvent(json, signature, webhookSecret, throwOnApiVersionMismatch: false);
        }
        catch (Exception e) when (e is StripeException or Newtonsoft.Json.JsonException or ArgumentException or FormatException)
        {
            return null;
        }
    }

    private static string Id(long id) => id.ToString(CultureInfo.InvariantCulture);
}
