using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.Api.Billing;
using Runova.Website.Core.Billing;
using Runova.Website.Data;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Billing;

/// <summary>Buying months of a type with crypto through NOWPayments (E53).</summary>
public sealed class CryptoPaymentsTests(PostgresFixture postgres) : IAsyncLifetime
{
    private const string Invoices = "/api/v1/accounts/me/crypto-invoices";
    private const string Events = "/api/v1/nowpayments-events";

    private readonly FakeNowPayments _nowPayments = new();
    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 11, 6, 9, 0, 0, TimeSpan.Zero));
    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync()
    {
        _factory = new(await postgres.CreateDatabaseAsync(), time: _time, services: _nowPayments.Register);
        await TestBilling.ConfigureAsync(_factory.Services, stripe: false);
    }

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    private Task<HttpResponseMessage> PostIpnAsync(string orderId, string status, decimal amount, string currency = "usd", long paymentId = 5_000_001, string secret = FakeNowPayments.IpnSecret)
    {
        var (json, signature) = FakeNowPayments.Ipn(orderId, status, amount, currency, paymentId, secret);
        return TestBilling.PostWebhookAsync(_factory, Events, json, CheckoutEndpoints.NowPaymentsSignatureHeader, signature);
    }

    private async Task<(ApiClient Account, long UserId)> AccountAsync()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        return (await TestAccounts.SignedInClientAsync(_factory, user), user.Id);
    }

    /// <summary>Moves the clock on and signs in again, since a session lasts 8 hours.</summary>
    private async Task<ApiClient> LaterAsync(long userId, TimeSpan by)
    {
        _time.Advance(by);
        return await TestAccounts.SignedInClientAsync(_factory, await TestAccounts.ReloadAsync(_factory.Services, userId));
    }

    private static async Task<string> BuyAsync(ApiClient account, long typeId, int months)
    {
        var created = await ApiClient.ReadJsonAsync(await account.SendAsync(HttpMethod.Post, Invoices, new { accountTypeId = typeId, months }), HttpStatusCode.Created);
        Assert.StartsWith("https://nowpayments.test/", created.GetProperty("url").GetString(), StringComparison.Ordinal);
        return created.GetProperty("url").GetString()!;
    }

    private async Task<string> LastOrderAsync(long userId)
    {
        using var scope = _factory.Services.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<AppDbContext>().Payments.Where(p => p.UserId == userId).OrderBy(p => p.Id).Select(p => p.OrderId).LastAsync(TestContext.Current.CancellationToken);
    }

    private async Task<DateTimeOffset?> EndAsync(long userId)
    {
        using var scope = _factory.Services.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<SubscriptionBook>().CurrentAsync(userId, TestContext.Current.CancellationToken) is { } s ? s.CurrentPeriodEnd : null;
    }

    [Fact]
    public async Task An_invoice_asks_nowpayments_for_the_price_of_the_months()
    {
        var (account, userId) = await AccountAsync();

        await BuyAsync(account, TestBilling.GoId, 3);

        var invoice = Assert.Single(_nowPayments.Invoices);
        Assert.Equal(15m, invoice["price_amount"]!.GetValue<decimal>());
        Assert.Equal("usd", invoice["price_currency"]!.GetValue<string>());
        Assert.Equal("https://runovahq.com/api/v1/nowpayments-events", invoice["ipn_callback_url"]!.GetValue<string>());
        Assert.Equal(await LastOrderAsync(userId), invoice["order_id"]!.GetValue<string>());
        var payments = await ApiClient.ReadJsonAsync(await account.GetAsync("/api/v1/accounts/me/payments"), HttpStatusCode.OK);
        Assert.Equal("pending", payments.GetProperty("items")[0].GetProperty("status").GetString());
        Assert.Equal(1500, payments.GetProperty("items")[0].GetProperty("amountCents").GetInt64());
    }

    [Fact]
    public async Task Twelve_months_cost_the_yearly_price()
    {
        var (account, _) = await AccountAsync();

        await BuyAsync(account, TestBilling.ProId, 12);

        Assert.Equal(150m, Assert.Single(_nowPayments.Invoices)["price_amount"]!.GetValue<decimal>());
    }

    [Fact]
    public async Task A_period_that_is_not_offered_is_refused()
    {
        var (account, _) = await AccountAsync();

        var response = await account.SendAsync(HttpMethod.Post, Invoices, new { accountTypeId = TestBilling.GoId, months = 2 });

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Invoices);
        Assert.True(problem.GetProperty("errors").TryGetProperty("months", out _));
        Assert.Empty(_nowPayments.Invoices);
    }

    [Fact]
    public async Task A_finished_payment_credits_the_months_once()
    {
        var (account, userId) = await AccountAsync();
        await BuyAsync(account, TestBilling.ProId, 1);
        var order = await LastOrderAsync(userId);

        Assert.Equal(HttpStatusCode.OK, (await PostIpnAsync(order, "waiting", 15m)).StatusCode);
        Assert.Equal("free", await TestBilling.PlanKeyAsync(account));
        Assert.Equal(HttpStatusCode.OK, (await PostIpnAsync(order, "finished", 15m)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await PostIpnAsync(order, "finished", 15m)).StatusCode);

        Assert.Equal("pro", await TestBilling.PlanKeyAsync(account));
        Assert.Equal(_time.GetUtcNow().AddMonths(1), await EndAsync(userId));
        var plan = await TestBilling.PlanAsync(account);
        Assert.Equal("nowpayments", plan.GetProperty("subscription").GetProperty("provider").GetString());
    }

    [Fact]
    public async Task Buying_the_same_type_again_adds_to_its_end()
    {
        var (first, userId) = await AccountAsync();
        var account = first;
        await BuyAsync(account, TestBilling.GoId, 1);
        await PostIpnAsync(await LastOrderAsync(userId), "finished", 5m, paymentId: 1);
        account = await LaterAsync(userId, TimeSpan.FromDays(10));

        await BuyAsync(account, TestBilling.GoId, 3);
        await PostIpnAsync(await LastOrderAsync(userId), "finished", 15m, paymentId: 2);

        Assert.Equal(new DateTimeOffset(2026, 11, 6, 9, 0, 0, TimeSpan.Zero).AddMonths(1).AddMonths(3), await EndAsync(userId));
    }

    [Fact]
    public async Task Moving_up_carries_the_days_left_over_at_the_price_ratio()
    {
        var (first, userId) = await AccountAsync();
        var account = first;
        await BuyAsync(account, TestBilling.GoId, 1);
        await PostIpnAsync(await LastOrderAsync(userId), "finished", 5m, paymentId: 1);
        var goEnd = (await EndAsync(userId))!.Value;
        account = await LaterAsync(userId, TimeSpan.FromDays(20));
        var left = goEnd - _time.GetUtcNow();

        await BuyAsync(account, TestBilling.ProId, 1);
        await PostIpnAsync(await LastOrderAsync(userId), "finished", 15m, paymentId: 2);

        Assert.Equal("pro", await TestBilling.PlanKeyAsync(account));
        var expected = _time.GetUtcNow().AddMonths(1) + TimeSpan.FromTicks((long)(left.Ticks * (500.0 / 1500.0)));
        Assert.Equal(expected, await EndAsync(userId));
    }

    [Fact]
    public async Task A_finished_payment_for_less_than_the_invoice_credits_nothing()
    {
        var (account, userId) = await AccountAsync();
        await BuyAsync(account, TestBilling.ProId, 1);
        var order = await LastOrderAsync(userId);

        await PostIpnAsync(order, "finished", 1.5m);
        await PostIpnAsync(order, "finished", 15m, currency: "eur", paymentId: 9);

        Assert.Equal("free", await TestBilling.PlanKeyAsync(account));
    }

    [Fact]
    public async Task An_ipn_with_a_wrong_signature_changes_nothing()
    {
        var (account, userId) = await AccountAsync();
        await BuyAsync(account, TestBilling.ProId, 1);

        var response = await PostIpnAsync(await LastOrderAsync(userId), "finished", 15m, secret: "not-the-secret");

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Unauthorized, ProblemAssert.Type("unauthorized"), Events);
        Assert.Equal("free", await TestBilling.PlanKeyAsync(account));
    }

    [Fact]
    public async Task An_expired_invoice_is_marked_so()
    {
        var (account, userId) = await AccountAsync();
        await BuyAsync(account, TestBilling.GoId, 1);

        await PostIpnAsync(await LastOrderAsync(userId), "expired", 5m);

        var payments = await ApiClient.ReadJsonAsync(await account.GetAsync("/api/v1/accounts/me/payments"), HttpStatusCode.OK);
        Assert.Equal(PaymentStatuses.Expired, payments.GetProperty("items")[0].GetProperty("status").GetString());
    }
}
