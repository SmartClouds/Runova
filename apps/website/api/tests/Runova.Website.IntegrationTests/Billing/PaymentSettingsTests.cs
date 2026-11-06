using System.Net;
using Npgsql;
using Runova.Website.Core.Identity;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Billing;

/// <summary>The Admin's payment switches and keys (E53).</summary>
public sealed class PaymentSettingsTests(PostgresFixture postgres) : IAsyncLifetime
{
    private const string Path = "/api/v1/payment-settings";

    private readonly FakeStripe _stripe = new();
    private readonly FakeNowPayments _nowPayments = new();
    private string _connectionString = null!;
    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync()
    {
        _connectionString = await postgres.CreateDatabaseAsync();
        _factory = new(_connectionString, services: s =>
        {
            _stripe.Register(s);
            _nowPayments.Register(s);
        });
    }

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    private async Task<ApiClient> AdminAsync() => await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services, Roles.Admin));

    private static async Task<HttpResponseMessage> PatchAsync(ApiClient admin, object body) =>
        await admin.SendAsync(HttpMethod.Patch, Path, body, ifMatch: (await admin.GetAsync(Path)).Headers.ETag!.Tag);

    [Fact]
    public async Task The_defaults_are_off_with_the_webhook_addresses_to_copy()
    {
        var body = await ApiClient.ReadJsonAsync(await (await AdminAsync()).GetAsync(Path), HttpStatusCode.OK);

        Assert.False(body.GetProperty("stripeEnabled").GetBoolean());
        Assert.False(body.GetProperty("nowPaymentsEnabled").GetBoolean());
        Assert.Equal("https://runovahq.com/api/v1/stripe-events", body.GetProperty("stripeWebhookUrl").GetString());
        Assert.Equal("https://runovahq.com/api/v1/nowpayments-events", body.GetProperty("nowPaymentsIpnUrl").GetString());
        Assert.Equal([1, 3, 12], body.GetProperty("cryptoMonths").EnumerateArray().Select(m => m.GetInt32()));
    }

    [Fact]
    public async Task Saved_keys_are_sealed_and_never_come_back()
    {
        var admin = await AdminAsync();

        var response = await PatchAsync(admin, new
        {
            stripeEnabled = true,
            stripePublishableKey = FakeStripe.PublishableKey,
            stripeSecretKey = FakeStripe.SecretKey,
            stripeWebhookSecret = FakeStripe.WebhookSecret,
            nowPaymentsEnabled = true,
            nowPaymentsApiKey = FakeNowPayments.ApiKey,
            nowPaymentsIpnSecret = FakeNowPayments.IpnSecret,
            cryptoMonths = new[] { 12, 1 },
        });
        var text = await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        var body = await ApiClient.ReadJsonAsync(response, HttpStatusCode.OK);

        Assert.True(body.GetProperty("hasStripeSecretKey").GetBoolean());
        Assert.True(body.GetProperty("hasNowPaymentsIpnSecret").GetBoolean());
        Assert.Equal([1, 12], body.GetProperty("cryptoMonths").EnumerateArray().Select(m => m.GetInt32()));
        foreach (var secret in new[] { FakeStripe.SecretKey, FakeStripe.WebhookSecret, FakeNowPayments.ApiKey, FakeNowPayments.IpnSecret })
        {
            Assert.DoesNotContain(secret, text, StringComparison.Ordinal);
        }

        await using var connection = new NpgsqlConnection(_connectionString);
        await connection.OpenAsync(TestContext.Current.CancellationToken);
        await using var command = new NpgsqlCommand("""SELECT row_to_json(s)::text FROM "PaymentSettings" s; """, connection);
        var row = (string)(await command.ExecuteScalarAsync(TestContext.Current.CancellationToken))!;
        await using var audit = new NpgsqlCommand("""SELECT string_agg("Changes"::text, ' ') FROM "AuditEntries" WHERE "Action" = 'payment-settings.update'""", connection);
        var entries = (string)(await audit.ExecuteScalarAsync(TestContext.Current.CancellationToken))!;
        foreach (var secret in new[] { FakeStripe.SecretKey, FakeStripe.WebhookSecret, FakeNowPayments.ApiKey, FakeNowPayments.IpnSecret })
        {
            Assert.DoesNotContain(secret, row, StringComparison.Ordinal);
            Assert.DoesNotContain(secret, entries, StringComparison.Ordinal);
        }

        Assert.Contains("stripeSecretKey", entries, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_provider_can_not_be_on_without_its_keys()
    {
        var admin = await AdminAsync();

        var response = await PatchAsync(admin, new { stripeEnabled = true, nowPaymentsEnabled = true, stripeSecretKey = FakeStripe.SecretKey });

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Path);
        Assert.True(problem.GetProperty("errors").TryGetProperty("stripeEnabled", out _));
        Assert.True(problem.GetProperty("errors").TryGetProperty("nowPaymentsEnabled", out _));
    }

    [Fact]
    public async Task A_write_needs_the_current_version()
    {
        var admin = await AdminAsync();

        var missing = await admin.SendAsync(HttpMethod.Patch, Path, new { nowPaymentsSandbox = true });

        await ProblemAssert.IsProblemAsync(missing, (HttpStatusCode)428, ProblemAssert.Type("precondition-required"), Path);
    }

    [Fact]
    public async Task An_admin_checks_the_keys_with_each_provider()
    {
        await TestBilling.ConfigureAsync(_factory.Services);
        var admin = await AdminAsync();

        var stripe = await ApiClient.ReadJsonAsync(await admin.SendAsync(HttpMethod.Post, "/api/v1/payment-connection-checks", new { provider = "stripe" }), HttpStatusCode.OK);
        var crypto = await ApiClient.ReadJsonAsync(await admin.SendAsync(HttpMethod.Post, "/api/v1/payment-connection-checks", new { provider = "nowpayments" }), HttpStatusCode.OK);
        _stripe.Failing = true;
        var refused = await ApiClient.ReadJsonAsync(await admin.SendAsync(HttpMethod.Post, "/api/v1/payment-connection-checks", new { provider = "stripe" }), HttpStatusCode.OK);

        Assert.True(stripe.GetProperty("ok").GetBoolean());
        Assert.True(crypto.GetProperty("ok").GetBoolean());
        Assert.False(refused.GetProperty("ok").GetBoolean());
    }

    [Fact]
    public async Task Only_an_admin_may_read_them()
    {
        var account = await TestAccounts.SignedInClientAsync(_factory, await TestAccounts.CreateAsync(_factory.Services));

        Assert.Equal(HttpStatusCode.Forbidden, (await account.GetAsync(Path)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await account.SendAsync(HttpMethod.Post, "/api/v1/payment-connection-checks", new { provider = "stripe" })).StatusCode);
    }
}
