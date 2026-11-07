using Runova.Website.Api.Billing;
using Runova.Website.Data.Billing;

namespace Runova.Website.Tests.Mapping;

public class PaymentSettingsMapperTests
{
    private static readonly DateTimeOffset _updatedAt = new(2026, 10, 1, 8, 0, 0, TimeSpan.Zero);

    private static PaymentSettings Row() => new()
    {
        StripeEnabled = true,
        StripePublishableKey = "  pk_test_1  ",
        StripeSecretKeySealed = "sealed-1",
        StripeWebhookSecretSealed = null,
        NowPaymentsEnabled = true,
        NowPaymentsApiKeySealed = "sealed-2",
        NowPaymentsIpnSecretSealed = null,
        NowPaymentsSandbox = true,
        CryptoMonths = [1, 12],
        UpdatedAt = _updatedAt,
        Version = 8,
    };

    [Fact]
    public void The_settings_show_whether_each_secret_is_saved_and_take_the_addresses_from_the_caller()
    {
        var dto = PaymentSettingsMapper.ToDto(Row(), "https://runovahq.com/stripe", "https://runovahq.com/nowpayments");

        Assert.Equal(
            new PaymentSettingsDto(
                true, "  pk_test_1  ", true, false, "https://runovahq.com/stripe", true, true, false, true, "https://runovahq.com/nowpayments", dto.CryptoMonths, _updatedAt, "8"),
            dto);
        Assert.Equal([1, 12], dto.CryptoMonths);
    }

    [Fact]
    public void The_config_takes_the_opened_secrets_and_trims_the_publishable_key()
    {
        var config = PaymentSettingsMapper.ToConfig(Row(), "sk_test_1", null, "np-key", null);

        Assert.Equal("pk_test_1", config.StripePublishableKey);
        Assert.Equal(("sk_test_1", (string?)null, "np-key", (string?)null), (config.StripeSecretKey, config.StripeWebhookSecret, config.NowPaymentsApiKey, config.NowPaymentsIpnSecret));
        Assert.True(config.StripeEnabled && config.NowPaymentsEnabled && config.NowPaymentsSandbox);
        Assert.Equal([1, 12], config.CryptoMonths);
        Assert.Null(PaymentSettingsMapper.ToConfig(new PaymentSettings { StripePublishableKey = " " }, null, null, null, null).StripePublishableKey);
    }

    [Fact]
    public void The_dto_carries_no_secret()
    {
        // Only flags saying a secret is saved. The config holds the opened secrets but never leaves the server.
        Assert.Equal(["HasStripeSecretKey", "HasStripeWebhookSecret", "HasNowPaymentsIpnSecret"], SecretProperties.In(typeof(PaymentSettingsDto)));
    }
}
