using System.Globalization;
using Riok.Mapperly.Abstractions;
using Runova.Website.Data.Billing;

namespace Runova.Website.Api.Billing;

[Mapper]
internal static partial class PaymentSettingsMapper
{
    /// <summary>The caller passes the webhook addresses, which come from the site's configured origin. A secret only shows as saved or not.</summary>
    [MapProperty(nameof(PaymentSettings.StripeSecretKeySealed), nameof(PaymentSettingsDto.HasStripeSecretKey), Use = nameof(IsSaved))]
    [MapProperty(nameof(PaymentSettings.StripeWebhookSecretSealed), nameof(PaymentSettingsDto.HasStripeWebhookSecret), Use = nameof(IsSaved))]
    [MapProperty(nameof(PaymentSettings.NowPaymentsApiKeySealed), nameof(PaymentSettingsDto.HasNowPaymentsApiKey), Use = nameof(IsSaved))]
    [MapProperty(nameof(PaymentSettings.NowPaymentsIpnSecretSealed), nameof(PaymentSettingsDto.HasNowPaymentsIpnSecret), Use = nameof(IsSaved))]
    public static partial PaymentSettingsDto ToDto(PaymentSettings row, string stripeWebhookUrl, string nowPaymentsIpnUrl);

    /// <summary>The caller opens the sealed secrets and passes them. The result stays on the server.</summary>
    [MapProperty(nameof(PaymentSettings.StripePublishableKey), nameof(PaymentConfig.StripePublishableKey), Use = nameof(Blank))]
    public static partial PaymentConfig ToConfig(
        PaymentSettings row, string? stripeSecretKey, string? stripeWebhookSecret, string? nowPaymentsApiKey, string? nowPaymentsIpnSecret);

    private static string VersionToString(uint version) => version.ToString(CultureInfo.InvariantCulture);

    [UserMapping(Default = false)]
    private static bool IsSaved(string? sealedSecret) => sealedSecret is not null;

    [UserMapping(Default = false)]
    private static string? Blank(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
