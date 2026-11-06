using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.Website.Api.Billing;
using Runova.Website.Core.Billing;
using Runova.Website.Data;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Billing;

/// <summary>Buying a type by card through Stripe Checkout, and Stripe's events (E53).</summary>
public sealed class CardPaymentsTests(PostgresFixture postgres) : IAsyncLifetime
{
    private const string Checkout = "/api/v1/accounts/me/checkout-sessions";
    private const string Events = "/api/v1/stripe-events";

    private readonly FakeStripe _stripe = new();
    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync()
    {
        _factory = new(await postgres.CreateDatabaseAsync(), services: _stripe.Register);
        await TestBilling.ConfigureAsync(_factory.Services);
    }

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    private Task<HttpResponseMessage> PostEventAsync(string type, object data, string? id = null, string secret = FakeStripe.WebhookSecret)
    {
        var (json, signature) = FakeStripe.Event(type, data, id, secret);
        return TestBilling.PostWebhookAsync(_factory, Events, json, CheckoutEndpoints.StripeSignatureHeader, signature);
    }

    private async Task<string> PriceIdAsync(long typeId)
    {
        using var scope = _factory.Services.CreateScope();
        return (await scope.ServiceProvider.GetRequiredService<AppDbContext>().AccountTypes.SingleAsync(t => t.Id == typeId, TestContext.Current.CancellationToken)).StripeMonthlyPriceId!;
    }

    [Fact]
    public async Task Checkout_makes_the_customer_product_and_price_once_and_sends_to_stripe()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var account = await TestAccounts.SignedInClientAsync(_factory, user);

        var first = await ApiClient.ReadJsonAsync(await account.SendAsync(HttpMethod.Post, Checkout, new { accountTypeId = TestBilling.ProId, interval = "month" }), HttpStatusCode.Created);
        var second = await ApiClient.ReadJsonAsync(await account.SendAsync(HttpMethod.Post, Checkout, new { accountTypeId = TestBilling.ProId }), HttpStatusCode.Created);

        Assert.StartsWith("https://checkout.stripe.test/", first.GetProperty("url").GetString(), StringComparison.Ordinal);
        Assert.NotEqual(first.GetProperty("url").GetString(), second.GetProperty("url").GetString());
        Assert.Single(_stripe.To("POST", "/v1/customers"));
        Assert.Single(_stripe.To("POST", "/v1/products"));
        Assert.Single(_stripe.To("POST", "/v1/prices"));
        var session = _stripe.To("POST", "/v1/checkout/sessions")[0].Form;
        Assert.Equal("subscription", session["mode"]);
        Assert.Equal(user.Id.ToString(System.Globalization.CultureInfo.InvariantCulture), session["client_reference_id"]);
        Assert.Equal("https://runovahq.com/account/plan?checkout=success", session["success_url"]);
        Assert.Equal("1500", _stripe.To("POST", "/v1/prices")[0].Form["unit_amount"]);
    }

    [Fact]
    public async Task A_new_price_makes_a_new_stripe_price_and_archives_the_old()
    {
        var account = await TestAccounts.SignedInClientAsync(_factory, await TestAccounts.CreateAsync(_factory.Services));
        await ApiClient.ReadJsonAsync(await account.SendAsync(HttpMethod.Post, Checkout, new { accountTypeId = TestBilling.GoId }), HttpStatusCode.Created);
        var old = await PriceIdAsync(TestBilling.GoId);
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            (await db.AccountTypes.SingleAsync(t => t.Id == TestBilling.GoId, TestContext.Current.CancellationToken)).MonthlyPriceCents = 700;
            await db.SaveChangesAsync(TestContext.Current.CancellationToken);
        }

        await ApiClient.ReadJsonAsync(await account.SendAsync(HttpMethod.Post, Checkout, new { accountTypeId = TestBilling.GoId }), HttpStatusCode.Created);

        Assert.Equal(2, _stripe.To("POST", "/v1/prices").Count);
        Assert.Equal("false", _stripe.To("POST", "/v1/prices/" + old).Single().Form["active"]);
        Assert.NotEqual(old, await PriceIdAsync(TestBilling.GoId));
    }

    [Fact]
    public async Task A_free_or_unknown_type_or_interval_is_refused()
    {
        var account = await TestAccounts.SignedInClientAsync(_factory, await TestAccounts.CreateAsync(_factory.Services));

        var free = await account.SendAsync(HttpMethod.Post, Checkout, new { accountTypeId = 1 });
        var unknown = await account.SendAsync(HttpMethod.Post, Checkout, new { accountTypeId = 999 });
        var weekly = await account.SendAsync(HttpMethod.Post, Checkout, new { accountTypeId = TestBilling.GoId, interval = "week" });

        Assert.Equal(HttpStatusCode.BadRequest, free.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, unknown.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, weekly.StatusCode);
        Assert.Empty(_stripe.Calls);
    }

    [Fact]
    public async Task The_subscription_event_puts_the_account_on_its_type_and_a_replay_changes_nothing()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var account = await TestAccounts.SignedInClientAsync(_factory, user);
        await ApiClient.ReadJsonAsync(await account.SendAsync(HttpMethod.Post, Checkout, new { accountTypeId = TestBilling.ProId }), HttpStatusCode.Created);
        var subscription = FakeStripe.Subscription("sub_1", user.Id, TestBilling.ProId, await PriceIdAsync(TestBilling.ProId));

        Assert.Equal(HttpStatusCode.OK, (await PostEventAsync("customer.subscription.created", subscription, "evt_same")).StatusCode);
        Assert.Equal("pro", await TestBilling.PlanKeyAsync(account));
        Assert.Equal(HttpStatusCode.OK, (await PostEventAsync("customer.subscription.created", subscription, "evt_same")).StatusCode);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        Assert.Single(await db.Subscriptions.Where(s => s.UserId == user.Id).ToListAsync(TestContext.Current.CancellationToken));
        Assert.True((await TestBilling.PlanAsync(account)).GetProperty("canManageCard").GetBoolean());
    }

    [Fact]
    public async Task A_canceled_subscription_puts_the_account_back_on_free_and_says_so()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var account = await TestAccounts.SignedInClientAsync(_factory, user);
        await ApiClient.ReadJsonAsync(await account.SendAsync(HttpMethod.Post, Checkout, new { accountTypeId = TestBilling.ProId }), HttpStatusCode.Created);
        var price = await PriceIdAsync(TestBilling.ProId);
        await PostEventAsync("customer.subscription.created", FakeStripe.Subscription("sub_2", user.Id, TestBilling.ProId, price));

        await PostEventAsync("customer.subscription.deleted", FakeStripe.Subscription("sub_2", user.Id, TestBilling.ProId, price, status: "canceled"));

        Assert.Equal("free", await TestBilling.PlanKeyAsync(account));
        using var scope = _factory.Services.CreateScope();
        var notice = await scope.ServiceProvider.GetRequiredService<AppDbContext>().UserNotifications
            .SingleAsync(n => n.UserId == user.Id && n.Kind == BillingNotices.Kind, TestContext.Current.CancellationToken);
        Assert.Equal("Your plan ended", notice.Title);
        Assert.Contains("Pro", notice.Body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Paying_by_card_already_refuses_a_second_checkout_and_crypto()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var account = await TestAccounts.SignedInClientAsync(_factory, user);
        await ApiClient.ReadJsonAsync(await account.SendAsync(HttpMethod.Post, Checkout, new { accountTypeId = TestBilling.GoId }), HttpStatusCode.Created);
        await PostEventAsync("customer.subscription.created", FakeStripe.Subscription("sub_3", user.Id, TestBilling.GoId, await PriceIdAsync(TestBilling.GoId)));

        var again = await account.SendAsync(HttpMethod.Post, Checkout, new { accountTypeId = TestBilling.ProId });
        var crypto = await account.SendAsync(HttpMethod.Post, "/api/v1/accounts/me/crypto-invoices", new { accountTypeId = TestBilling.ProId, months = 1 });
        var portal = await ApiClient.ReadJsonAsync(await account.SendAsync(HttpMethod.Post, "/api/v1/accounts/me/billing-portal-sessions"), HttpStatusCode.Created);

        await ProblemAssert.IsProblemAsync(again, HttpStatusCode.Conflict, ProblemAssert.Type("conflict"), Checkout);
        Assert.Equal(HttpStatusCode.Conflict, crypto.StatusCode);
        Assert.StartsWith("https://billing.stripe.test/", portal.GetProperty("url").GetString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task An_event_with_a_wrong_signature_changes_nothing()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var account = await TestAccounts.SignedInClientAsync(_factory, user);

        var response = await PostEventAsync("customer.subscription.created", FakeStripe.Subscription("sub_4", user.Id, TestBilling.UltraId, "price_x"), secret: "whsec_wrong");
        var unsigned = await TestBilling.PostWebhookAsync(_factory, Events, "{}", "X-Nothing", "");

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Unauthorized, ProblemAssert.Type("unauthorized"), Events);
        Assert.Equal(HttpStatusCode.Unauthorized, unsigned.StatusCode);
        Assert.Equal("free", await TestBilling.PlanKeyAsync(account));
    }

    [Fact]
    public async Task A_paid_invoice_and_a_failed_one_show_in_the_payments()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var account = await TestAccounts.SignedInClientAsync(_factory, user);
        await ApiClient.ReadJsonAsync(await account.SendAsync(HttpMethod.Post, Checkout, new { accountTypeId = TestBilling.GoId }), HttpStatusCode.Created);
        var customer = _stripe.To("POST", "/v1/customers").Count;
        Assert.Equal(1, customer);
        await PostEventAsync("customer.subscription.created", FakeStripe.Subscription("sub_5", user.Id, TestBilling.GoId, await PriceIdAsync(TestBilling.GoId), customer: "cus_1"));

        await PostEventAsync("invoice.paid", new { id = "in_1", @object = "invoice", customer = "cus_1", amount_paid = 500, amount_due = 500, currency = "usd", status = "paid" });
        await PostEventAsync("invoice.payment_failed", new { id = "in_2", @object = "invoice", customer = "cus_1", amount_paid = 0, amount_due = 500, currency = "usd", status = "open" });

        var payments = await ApiClient.ReadJsonAsync(await account.GetAsync("/api/v1/accounts/me/payments"), HttpStatusCode.OK);
        var statuses = payments.GetProperty("items").EnumerateArray().Select(p => p.GetProperty("status").GetString()).ToList();
        Assert.Equal([PaymentStatuses.Failed, PaymentStatuses.Paid], statuses);
    }
}
