using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Api.Dependencies;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Billing;
using Runova.Website.Core.Problems;
using Runova.Website.Data;
using Runova.Website.Data.Billing;
using Stripe;
using AccountType = Runova.Website.Data.Billing.AccountType;
using Payment = Runova.Website.Data.Billing.Payment;

namespace Runova.Website.Api.Billing;

public sealed record CheckoutSessionRequest(long? AccountTypeId, string? Interval);

public sealed record CryptoInvoiceRequest(long? AccountTypeId, int? Months);

/// <summary>Where to send the person next: Stripe's checkout or portal, or the NOWPayments invoice.</summary>
public sealed record RedirectDto(string Url);

/// <summary>
/// Buying an account type (E53): by card through Stripe Checkout, which renews, or with crypto
/// through a NOWPayments invoice for a number of months. And the two webhooks that say what was
/// paid, each checked by its signature and acted on once.
/// </summary>
internal static partial class CheckoutEndpoints
{
    public const string StripeSignatureHeader = "Stripe-Signature";
    public const string NowPaymentsSignatureHeader = "x-nowpayments-sig";
    private const int MaxWebhookBytes = 1_000_000;

    public static RouteGroupBuilder MapCheckout(this RouteGroupBuilder api)
    {
        var me = api.MapGroup("/accounts/me").RequireAuthorization(Policies.Account);
        me.MapPost("/checkout-sessions", CreateCheckoutAsync);
        me.MapPost("/billing-portal-sessions", CreatePortalAsync);
        me.MapPost("/crypto-invoices", CreateCryptoInvoiceAsync);
        api.MapPost(PaymentSettingsEndpoints.StripeEventsPath, StripeEventAsync).AllowAnonymous().Accepts<JsonObject>("application/json");
        api.MapPost(PaymentSettingsEndpoints.NowPaymentsEventsPath, NowPaymentsEventAsync).AllowAnonymous().Accepts<JsonObject>("application/json");
        return api;
    }

    private static async Task<Results<Created<RedirectDto>, ValidationProblem, ProblemHttpResult>> CreateCheckoutAsync(
        CheckoutSessionRequest request, HttpContext http, AppDbContext db, PaymentSettingsStore store, StripeGateway stripe,
        SubscriptionBook book, IConfiguration configuration, ILoggerFactory loggers)
    {
        var config = await store.GetAsync(http.RequestAborted);
        if (!config.StripeReady)
        {
            return ApiProblems.Of(ProblemTypes.Unavailable, "Card payments are not set up on this site.");
        }

        var interval = request.Interval ?? StripeGateway.Month;
        var errors = new Dictionary<string, string[]>();
        if (interval is not (StripeGateway.Month or StripeGateway.Year))
        {
            errors["interval"] = ["Give month or year."];
        }

        var type = request.AccountTypeId is { } id ? await db.AccountTypes.SingleOrDefaultAsync(t => t.Id == id && t.IsActive) : null;
        if (type is null || type.IsFree)
        {
            errors["accountTypeId"] = ["Give an account type that is on offer and not free."];
        }
        else if ((interval == StripeGateway.Year ? type.YearlyPriceCents : type.MonthlyPriceCents) is not > 0)
        {
            errors["interval"] = [$"{type.Name} has no {interval}ly price."];
        }

        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        var userId = CurrentAccount.Id(http);
        if (await book.CurrentAsync(userId, http.RequestAborted) is { } current && await PaidAsync(db, current))
        {
            return current.Provider == BillingProviders.Stripe
                ? ApiProblems.Of(ProblemTypes.Conflict, "You already pay by card. Change or cancel your plan from Manage subscription.")
                : ApiProblems.Of(ProblemTypes.Conflict, $"Your current plan runs until {Day(current.CurrentPeriodEnd)}. Extend it with crypto, or pay by card once it ends.");
        }

        var site = SiteUrl.From(configuration);
        try
        {
            var customerId = await db.BillingCustomers.Where(c => c.UserId == userId).Select(c => c.StripeCustomerId).SingleOrDefaultAsync();
            if (customerId is null)
            {
                var user = await db.Users.AsNoTracking().SingleAsync(u => u.Id == userId);
                customerId = await stripe.CreateCustomerAsync(config, userId, user.Email, user.DisplayName, http.RequestAborted);
                db.BillingCustomers.Add(new BillingCustomer { UserId = userId, StripeCustomerId = customerId, CreatedAt = DateTimeOffset.UtcNow });
            }

            var priceId = await stripe.EnsurePriceAsync(config, type!, interval, http.RequestAborted);
            await db.SaveChangesAsync();
            var url = await stripe.CreateCheckoutAsync(
                config, customerId, priceId, userId, type!.Id, $"{site}/account/plan?checkout=success", $"{site}/account/plan?checkout=canceled", http.RequestAborted);
            return TypedResults.Created((string?)null, new RedirectDto(url));
        }
        catch (StripeException e)
        {
            LogStripeFailed(loggers.CreateLogger(typeof(CheckoutEndpoints)), e);
            return ApiProblems.Of(ProblemTypes.Unavailable, "Stripe could not start the checkout. Try again in a minute.");
        }
    }

    private static async Task<Results<Created<RedirectDto>, ProblemHttpResult>> CreatePortalAsync(
        HttpContext http, AppDbContext db, PaymentSettingsStore store, StripeGateway stripe, IConfiguration configuration, ILoggerFactory loggers)
    {
        var config = await store.GetAsync(http.RequestAborted);
        if (config.StripeSecretKey is null)
        {
            return ApiProblems.Of(ProblemTypes.Unavailable, "Card payments are not set up on this site.");
        }

        var userId = CurrentAccount.Id(http);
        if (await db.BillingCustomers.Where(c => c.UserId == userId).Select(c => c.StripeCustomerId).SingleOrDefaultAsync() is not { } customerId)
        {
            return ApiProblems.Of(ProblemTypes.NotFound, "This account has never paid by card.");
        }

        try
        {
            var url = await stripe.CreatePortalAsync(config, customerId, $"{SiteUrl.From(configuration)}/account/plan", http.RequestAborted);
            return TypedResults.Created((string?)null, new RedirectDto(url));
        }
        catch (StripeException e)
        {
            LogStripeFailed(loggers.CreateLogger(typeof(CheckoutEndpoints)), e);
            return ApiProblems.Of(ProblemTypes.Unavailable, "Stripe could not open the subscription page. Try again in a minute.");
        }
    }

    private static async Task<Results<Created<RedirectDto>, ValidationProblem, ProblemHttpResult>> CreateCryptoInvoiceAsync(
        CryptoInvoiceRequest request, HttpContext http, AppDbContext db, PaymentSettingsStore store, NowPaymentsClient nowPayments,
        SubscriptionBook book, IConfiguration configuration, TimeProvider time, ILoggerFactory loggers)
    {
        var config = await store.GetAsync(http.RequestAborted);
        if (!config.NowPaymentsReady)
        {
            return ApiProblems.Of(ProblemTypes.Unavailable, "Crypto payments are not set up on this site.");
        }

        var errors = new Dictionary<string, string[]>();
        if (request.Months is not { } months || !config.CryptoMonths.Contains(months))
        {
            errors["months"] = [$"Give one of {string.Join(", ", config.CryptoMonths)} months."];
            months = 0;
        }

        var type = request.AccountTypeId is { } id ? await db.AccountTypes.SingleOrDefaultAsync(t => t.Id == id && t.IsActive) : null;
        var price = type is null ? null : Prepaid.PriceCents(type.MonthlyPriceCents, type.YearlyPriceCents, months);
        if (type is null || type.IsFree)
        {
            errors["accountTypeId"] = ["Give an account type that is on offer and not free."];
        }
        else if (months > 0 && price is not > 0)
        {
            errors["months"] = [$"{type.Name} has no price for {months} months."];
        }

        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        var userId = CurrentAccount.Id(http);
        if (await book.CurrentAsync(userId, http.RequestAborted) is { Provider: BillingProviders.Stripe })
        {
            return ApiProblems.Of(ProblemTypes.Conflict, "You pay by card. Cancel that subscription first, from Manage subscription, to pay with crypto.");
        }

        var payment = new Payment
        {
            UserId = userId,
            Provider = BillingProviders.NowPayments,
            OrderId = "rnv_" + Guid.CreateVersion7().ToString("N"),
            AccountTypeId = type!.Id,
            Months = months,
            AmountCents = price!.Value,
            Currency = type.Currency,
            Status = PaymentStatuses.Pending,
            CreatedAt = time.GetUtcNow(),
        };

        var site = SiteUrl.From(configuration);
        try
        {
            var invoice = await nowPayments.CreateInvoiceAsync(
                config, payment.AmountCents, payment.Currency, payment.OrderId, $"Runova {type.Name}, {months} {(months == 1 ? "month" : "months")}",
                site + ApiV1.Prefix + PaymentSettingsEndpoints.NowPaymentsEventsPath, $"{site}/account/plan?crypto=paid", $"{site}/account/plan?crypto=canceled",
                http.RequestAborted);
            payment.ProviderPaymentId = invoice.Id;
            payment.InvoiceUrl = invoice.InvoiceUrl;
        }
        catch (Exception e) when (e is NowPaymentsException or HttpRequestException or TaskCanceledException or JsonException)
        {
            LogNowPaymentsFailed(loggers.CreateLogger(typeof(CheckoutEndpoints)), e);
            return ApiProblems.Of(ProblemTypes.Unavailable, "NOWPayments could not make the invoice. Try again in a minute.");
        }

        db.Payments.Add(payment);
        await db.SaveChangesAsync();
        return TypedResults.Created((string?)null, new RedirectDto(payment.InvoiceUrl));
    }

    /// <summary>
    /// A Stripe event. A wrong signature is 401; one already acted on, or about nothing of ours,
    /// is 200 and changes nothing, since Stripe sends an event again until it gets a 2xx.
    /// </summary>
    private static async Task<Results<Ok, ProblemHttpResult>> StripeEventAsync(
        HttpContext http, AppDbContext db, PaymentSettingsStore store, SubscriptionBook book, IPlanEnforcement enforcement,
        BillingNotices notices, TimeProvider time)
    {
        var config = await store.GetAsync(http.RequestAborted);
        if (config.StripeWebhookSecret is null)
        {
            return ApiProblems.Of(ProblemTypes.NotFound, "Card payments are not set up on this site.");
        }

        var json = await ReadBodyAsync(http.Request);
        if (json is null || StripeGateway.ParseEvent(json, http.Request.Headers[StripeSignatureHeader], config.StripeWebhookSecret) is not { } stripeEvent)
        {
            return ApiProblems.Of(ProblemTypes.Unauthorized, "The event's signature did not match.");
        }

        if (await db.ProcessedPaymentEvents.AnyAsync(e => e.Provider == BillingProviders.Stripe && e.EventId == stripeEvent.Id))
        {
            return TypedResults.Ok();
        }

        long? changedUser = null;
        switch (stripeEvent.Data.Object)
        {
            case Stripe.Subscription subscription:
                var before = await TypeOfAsync(db, subscription);
                changedUser = await book.ApplyStripeAsync(subscription, http.RequestAborted);
                if (changedUser is { } subscriber && stripeEvent.Type == EventTypes.CustomerSubscriptionDeleted)
                {
                    await notices.AddAsync(subscriber, "Your plan ended", $"Your {before ?? "paid"} plan was canceled, so this account is on Free now.", cancellationToken: http.RequestAborted);
                }

                break;
            case Stripe.Checkout.Session { Mode: "subscription" } session
                when long.TryParse(session.ClientReferenceId, CultureInfo.InvariantCulture, out var buyer) && session.CustomerId is { } customerId:
                if (!await db.BillingCustomers.AnyAsync(c => c.UserId == buyer) && await db.Users.AnyAsync(u => u.Id == buyer))
                {
                    db.BillingCustomers.Add(new BillingCustomer { UserId = buyer, StripeCustomerId = customerId, CreatedAt = time.GetUtcNow() });
                }

                break;
            case Invoice invoice when stripeEvent.Type is EventTypes.InvoicePaid or EventTypes.InvoicePaymentFailed:
                await RecordInvoiceAsync(db, book, notices, invoice, stripeEvent.Type == EventTypes.InvoicePaid, time, http.RequestAborted);
                break;
        }

        db.ProcessedPaymentEvents.Add(new ProcessedPaymentEvent { Provider = BillingProviders.Stripe, EventId = stripeEvent.Id, At = time.GetUtcNow() });
        await db.SaveChangesAsync();
        await notices.FlushAsync();
        if (changedUser is { } userId)
        {
            await enforcement.AccountChangedAsync(userId, http.RequestAborted);
        }

        return TypedResults.Ok();
    }

    /// <summary>
    /// A NOWPayments IPN. Only <c>finished</c> credits the account, and only with the amount and
    /// currency of our own invoice; other statuses are kept for the payments list.
    /// </summary>
    private static async Task<Results<Ok, ProblemHttpResult>> NowPaymentsEventAsync(
        HttpContext http, AppDbContext db, PaymentSettingsStore store, SubscriptionBook book, IPlanEnforcement enforcement,
        BillingNotices notices, TimeProvider time, ILoggerFactory loggers)
    {
        var config = await store.GetAsync(http.RequestAborted);
        if (config.NowPaymentsIpnSecret is null)
        {
            return ApiProblems.Of(ProblemTypes.NotFound, "Crypto payments are not set up on this site.");
        }

        var json = await ReadBodyAsync(http.Request);
        if (json is null || !NowPaymentsSignature.Verify(json, http.Request.Headers[NowPaymentsSignatureHeader], config.NowPaymentsIpnSecret))
        {
            return ApiProblems.Of(ProblemTypes.Unauthorized, "The IPN's signature did not match.");
        }

        var ipn = JsonNode.Parse(json)!.AsObject();
        var orderId = ipn["order_id"]?.ToString();
        var status = ipn["payment_status"]?.ToString() ?? "";
        var eventId = $"{ipn["payment_id"]?.ToString() ?? orderId}:{status}";
        if (orderId is null || await db.ProcessedPaymentEvents.AnyAsync(e => e.Provider == BillingProviders.NowPayments && e.EventId == eventId))
        {
            return TypedResults.Ok();
        }

        long? credited = null;
        if (await db.Payments.SingleOrDefaultAsync(p => p.Provider == BillingProviders.NowPayments && p.OrderId == orderId) is { } payment)
        {
            payment.ProviderStatus = Clip(status, 32);
            if (status == "finished" && payment.Status != PaymentStatuses.Paid)
            {
                if (!Matches(ipn, payment))
                {
                    LogAmountMismatch(loggers.CreateLogger(typeof(CheckoutEndpoints)), payment.OrderId);
                }
                else
                {
                    var type = await db.AccountTypes.SingleAsync(t => t.Id == payment.AccountTypeId);
                    payment.Status = PaymentStatuses.Paid;
                    payment.PaidAt = time.GetUtcNow();
                    var subscription = await book.CreditPrepaidAsync(payment.UserId, type, payment.Months ?? 1, BillingProviders.NowPayments, http.RequestAborted);
                    credited = payment.UserId;
                    await notices.AddAsync(payment.UserId, $"You are on {type.Name}", $"Thanks for paying. {type.Name} is yours until {Day(subscription.CurrentPeriodEnd)}.", cancellationToken: http.RequestAborted);
                }
            }
            else if (status is "failed" or "refunded" && payment.Status == PaymentStatuses.Pending)
            {
                payment.Status = PaymentStatuses.Failed;
            }
            else if (status == "expired" && payment.Status == PaymentStatuses.Pending)
            {
                payment.Status = PaymentStatuses.Expired;
            }
        }

        db.ProcessedPaymentEvents.Add(new ProcessedPaymentEvent { Provider = BillingProviders.NowPayments, EventId = Clip(eventId, 100), At = time.GetUtcNow() });
        await db.SaveChangesAsync();
        await notices.FlushAsync();
        if (credited is { } userId)
        {
            await enforcement.AccountChangedAsync(userId, http.RequestAborted);
        }

        return TypedResults.Ok();
    }

    /// <summary>The IPN's price is our invoice's, to the cent, in the same currency.</summary>
    private static bool Matches(JsonObject ipn, Payment payment)
    {
        if (ipn["price_amount"] is not JsonValue amount
            || (!amount.TryGetValue<decimal>(out var value) && !decimal.TryParse(amount.ToString(), NumberStyles.Number, CultureInfo.InvariantCulture, out value)))
        {
            return false;
        }

        return decimal.Round(value * 100m) == payment.AmountCents
            && string.Equals(ipn["price_currency"]?.ToString(), payment.Currency, StringComparison.OrdinalIgnoreCase);
    }

    private static async Task RecordInvoiceAsync(
        AppDbContext db, SubscriptionBook book, BillingNotices notices, Invoice invoice, bool paid, TimeProvider time, CancellationToken cancellationToken)
    {
        if (await db.BillingCustomers.Where(c => c.StripeCustomerId == invoice.CustomerId).Select(c => (long?)c.UserId).SingleOrDefaultAsync(cancellationToken) is not { } userId
            || await db.Payments.AnyAsync(p => p.Provider == BillingProviders.Stripe && p.ProviderPaymentId == invoice.Id, cancellationToken))
        {
            return;
        }

        var current = await db.Subscriptions.AsNoTracking()
            .Where(s => s.UserId == userId && s.Provider == BillingProviders.Stripe).OrderByDescending(s => s.Id).FirstOrDefaultAsync(cancellationToken);
        if (current is null)
        {
            return;
        }

        db.Payments.Add(new Payment
        {
            UserId = userId,
            Provider = BillingProviders.Stripe,
            OrderId = "stripe_" + invoice.Id,
            ProviderPaymentId = invoice.Id,
            AccountTypeId = current.AccountTypeId,
            AmountCents = paid ? invoice.AmountPaid : invoice.AmountDue,
            Currency = invoice.Currency ?? "usd",
            Status = paid ? PaymentStatuses.Paid : PaymentStatuses.Failed,
            ProviderStatus = invoice.Status,
            CreatedAt = time.GetUtcNow(),
            PaidAt = paid ? time.GetUtcNow() : null,
        });

        if (!paid)
        {
            await notices.AddAsync(userId, "Your card payment failed", "Stripe will try again. Update your card from Manage subscription on your Plan page to keep your plan.", cancellationToken: cancellationToken);
        }
    }

    private static async Task<string?> TypeOfAsync(AppDbContext db, Stripe.Subscription subscription) =>
        await (from s in db.Subscriptions
               where s.Provider == BillingProviders.Stripe && s.ProviderRef == subscription.Id
               join t in db.AccountTypes on s.AccountTypeId equals t.Id
               select t.Name).SingleOrDefaultAsync();

    /// <summary>Whether the account pays (or was given) a type that costs something.</summary>
    private static async Task<bool> PaidAsync(AppDbContext db, Data.Billing.Subscription subscription) =>
        await db.AccountTypes.AnyAsync(t => t.Id == subscription.AccountTypeId && !t.IsFree);

    private static async Task<string?> ReadBodyAsync(HttpRequest request)
    {
        if (request.ContentLength > MaxWebhookBytes)
        {
            return null;
        }

        using var reader = new StreamReader(request.Body, Encoding.UTF8);
        var buffer = new char[MaxWebhookBytes + 1];
        var read = await reader.ReadBlockAsync(buffer);
        return read > MaxWebhookBytes ? null : new string(buffer, 0, read);
    }

    private static string Day(DateTimeOffset? at) => at?.ToString("d MMMM yyyy", CultureInfo.InvariantCulture) ?? "further notice";

    private static string Clip(string text, int length) => text.Length <= length ? text : text[..length];

    [LoggerMessage(Level = LogLevel.Error, Message = "A Stripe call failed")]
    private static partial void LogStripeFailed(ILogger logger, Exception exception);

    [LoggerMessage(Level = LogLevel.Error, Message = "A NOWPayments invoice could not be made")]
    private static partial void LogNowPaymentsFailed(ILogger logger, Exception exception);

    [LoggerMessage(Level = LogLevel.Warning, Message = "NOWPayments said order {OrderId} finished with an amount or currency that is not the invoice's; nothing was credited")]
    private static partial void LogAmountMismatch(ILogger logger, string orderId);
}
