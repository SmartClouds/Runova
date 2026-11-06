using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Web;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.Website.Api.Billing;
using Runova.Website.Core.Billing;
using Runova.Website.Data;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>
/// Stands in for api.stripe.com behind Stripe.net: it makes customers, products, prices and
/// sessions with fresh ids, and keeps every call. It also signs webhook events as Stripe does.
/// </summary>
internal sealed class FakeStripe
{
    public const string SecretKey = "sk_test_never_shown";
    public const string WebhookSecret = "whsec_never_shown";
    public const string PublishableKey = "pk_test_shown";

    public sealed record Call(string Method, string Path, IReadOnlyDictionary<string, string> Form);

    private readonly ConcurrentQueue<Call> _calls = new();
    private int _next;

    public IReadOnlyList<Call> Calls => [.. _calls];

    public IReadOnlyList<Call> To(string method, string path) => [.. _calls.Where(c => c.Method == method && c.Path == path)];

    /// <summary>When set, every call answers this card error.</summary>
    public bool Failing { get; set; }

    public void Register(IServiceCollection services) =>
        services.AddHttpClient(StripeGateway.HttpClientName).ConfigurePrimaryHttpMessageHandler(() => new Handler(this));

    /// <summary>A webhook body and its <c>Stripe-Signature</c>, signed now with <see cref="WebhookSecret"/>.</summary>
    public static (string Json, string Signature) Event(string type, object data, string? id = null, string secret = WebhookSecret)
    {
        var json = JsonSerializer.Serialize(new
        {
            id = id ?? "evt_" + Guid.NewGuid().ToString("N"),
            @object = "event",
            api_version = "2025-09-30.clover",
            created = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
            livemode = false,
            type,
            data = new { @object = data },
        });
        var timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture);
        var hash = Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes($"{timestamp}.{json}")));
        return (json, $"t={timestamp},v1={hash}");
    }

    /// <summary>A Stripe subscription as its events carry it.</summary>
    public static object Subscription(string id, long userId, long accountTypeId, string priceId, string status = "active", DateTimeOffset? periodEnd = null, bool cancelAtPeriodEnd = false, string customer = "cus_1") => new
    {
        id,
        @object = "subscription",
        customer,
        status,
        cancel_at_period_end = cancelAtPeriodEnd,
        metadata = new Dictionary<string, string>
        {
            [StripeGateway.UserIdKey] = userId.ToString(CultureInfo.InvariantCulture),
            [StripeGateway.AccountTypeIdKey] = accountTypeId.ToString(CultureInfo.InvariantCulture),
        },
        items = new
        {
            @object = "list",
            data = new[]
            {
                new { id = "si_" + id, @object = "subscription_item", current_period_end = (periodEnd ?? DateTimeOffset.UtcNow.AddMonths(1)).ToUnixTimeSeconds(), price = new { id = priceId, @object = "price" } },
            },
        },
    };

    private sealed class Handler(FakeStripe stripe) : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Assert.Equal("Bearer " + SecretKey, request.Headers.Authorization?.ToString());
            var body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken);
            var form = HttpUtility.ParseQueryString(body);
            var path = request.RequestUri!.AbsolutePath;
            stripe._calls.Enqueue(new Call(request.Method.Method, path, form.AllKeys.Where(k => k is not null).ToDictionary(k => k!, k => form[k]!)));
            if (stripe.Failing)
            {
                return Json(HttpStatusCode.PaymentRequired, new { error = new { type = "card_error", message = "Your card was declined." } });
            }

            var n = Interlocked.Increment(ref stripe._next);
            return path switch
            {
                "/v1/balance" => Json(HttpStatusCode.OK, new { @object = "balance", livemode = false }),
                "/v1/customers" => Json(HttpStatusCode.OK, new { id = $"cus_{n}", @object = "customer" }),
                "/v1/products" => Json(HttpStatusCode.OK, new { id = $"prod_{n}", @object = "product" }),
                "/v1/prices" => Json(HttpStatusCode.OK, new { id = $"price_{n}", @object = "price" }),
                _ when path.StartsWith("/v1/prices/", StringComparison.Ordinal) => Json(HttpStatusCode.OK, new { id = path[11..], @object = "price", active = false }),
                "/v1/checkout/sessions" => Json(HttpStatusCode.OK, new { id = $"cs_{n}", @object = "checkout.session", url = $"https://checkout.stripe.test/cs_{n}" }),
                "/v1/billing_portal/sessions" => Json(HttpStatusCode.OK, new { id = $"bps_{n}", @object = "billing_portal.session", url = $"https://billing.stripe.test/bps_{n}" }),
                _ => Json(HttpStatusCode.NotFound, new { error = new { type = "invalid_request_error", message = "Unknown path " + path } }),
            };
        }

        private static HttpResponseMessage Json(HttpStatusCode status, object body) =>
            new(status) { Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json") };
    }
}

/// <summary>Stands in for the NOWPayments API: invoices with fresh ids, and IPNs signed as NOWPayments signs them.</summary>
internal sealed class FakeNowPayments
{
    public const string ApiKey = "np-api-key-never-shown";
    public const string IpnSecret = "np-ipn-secret-never-shown";

    private readonly ConcurrentQueue<JsonObject> _invoices = new();
    private int _next = 4_000_000;

    public IReadOnlyList<JsonObject> Invoices => [.. _invoices];

    public void Register(IServiceCollection services) =>
        services.AddHttpClient<NowPaymentsClient>().ConfigurePrimaryHttpMessageHandler(() => new Handler(this));

    /// <summary>An IPN body and its signature, as NOWPayments posts it for an order.</summary>
    public static (string Json, string Signature) Ipn(string orderId, string status, decimal priceAmount, string currency = "usd", long paymentId = 5_000_001, string secret = IpnSecret)
    {
        var json = JsonSerializer.Serialize(new
        {
            payment_id = paymentId,
            payment_status = status,
            pay_address = "TXYZ",
            price_amount = priceAmount,
            price_currency = currency,
            pay_amount = 12.5,
            actually_paid = 12.5,
            pay_currency = "usdttrc20",
            order_id = orderId,
            order_description = "Runova",
            fee = new { currency = "usdttrc20", depositFee = 0.1, withdrawalFee = 0, serviceFee = 0 },
        });
        return (json, NowPaymentsSignature.Compute(json, secret));
    }

    private sealed class Handler(FakeNowPayments nowPayments) : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Assert.Equal(ApiKey, request.Headers.GetValues("x-api-key").Single());
            var path = request.RequestUri!.AbsolutePath;
            if (path == "/v1/merchant/coins")
            {
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("""{"selectedCurrencies":["usdttrc20"]}""", Encoding.UTF8, "application/json") };
            }

            Assert.Equal("/v1/invoice", path);
            var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!.AsObject();
            nowPayments._invoices.Enqueue(body);
            var id = Interlocked.Increment(ref nowPayments._next);
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    JsonSerializer.Serialize(new { id = id.ToString(CultureInfo.InvariantCulture), order_id = body["order_id"]!.ToString(), invoice_url = $"https://nowpayments.test/payment/?iid={id}" }),
                    Encoding.UTF8,
                    "application/json"),
            };
        }
    }
}

/// <summary>Payment settings and plans for tests, written straight to the database.</summary>
internal static class TestBilling
{
    public const long GoId = 2;
    public const long ProId = 3;
    public const long UltraId = 4;

    /// <summary>Turns on card and crypto payments with the fakes' keys.</summary>
    public static async Task ConfigureAsync(IServiceProvider services, bool stripe = true, bool nowPayments = true)
    {
        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var secrets = scope.ServiceProvider.GetRequiredService<PaymentSecrets>();
        var row = await db.PaymentSettings.SingleAsync(TestContext.Current.CancellationToken);
        row.StripeEnabled = stripe;
        row.StripePublishableKey = FakeStripe.PublishableKey;
        row.StripeSecretKeySealed = secrets.Seal(FakeStripe.SecretKey);
        row.StripeWebhookSecretSealed = secrets.Seal(FakeStripe.WebhookSecret);
        row.NowPaymentsEnabled = nowPayments;
        row.NowPaymentsApiKeySealed = secrets.Seal(FakeNowPayments.ApiKey);
        row.NowPaymentsIpnSecretSealed = secrets.Seal(FakeNowPayments.IpnSecret);
        await db.SaveChangesAsync(TestContext.Current.CancellationToken);
    }

    public static async Task<JsonElement> PlanAsync(ApiClient account) =>
        await ApiClient.ReadJsonAsync(await account.GetAsync("/api/v1/accounts/me/subscriptions/current"), HttpStatusCode.OK);

    public static async Task<string> PlanKeyAsync(ApiClient account) =>
        (await PlanAsync(account)).GetProperty("accountType").GetProperty("key").GetString()!;

    /// <summary>Posts a webhook body with its signature header, with no cookie, as the provider does.</summary>
    public static async Task<HttpResponseMessage> PostWebhookAsync(WebsiteApiFactory factory, string path, string json, string header, string signature)
    {
        var client = factory.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { BaseAddress = new Uri("https://localhost") });
        using var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
        request.Headers.TryAddWithoutValidation(header, signature);
        return await client.SendAsync(request, TestContext.Current.CancellationToken);
    }
}
