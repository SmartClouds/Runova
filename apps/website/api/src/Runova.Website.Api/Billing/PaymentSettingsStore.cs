using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Data;
using Runova.Website.Data.Billing;

namespace Runova.Website.Api.Billing;

/// <summary>Seals the payment keys for the database and opens them again. They never leave the API.</summary>
internal sealed class PaymentSecrets(IDataProtectionProvider provider)
{
    public const string Purpose = "Runova.PaymentSettings.v1";

    private readonly IDataProtector _protector = provider.CreateProtector(Purpose);

    public string Seal(string secret) => Base64Url.EncodeToString(_protector.Protect(Encoding.UTF8.GetBytes(secret)));

    /// <summary>The secret, or null when there is none or it was sealed by another key ring.</summary>
    public string? Unseal(string? sealedSecret)
    {
        if (string.IsNullOrEmpty(sealedSecret))
        {
            return null;
        }

        try
        {
            return Encoding.UTF8.GetString(_protector.Unprotect(Base64Url.DecodeFromChars(sealedSecret)));
        }
        catch (Exception e) when (e is CryptographicException or FormatException)
        {
            return null;
        }
    }
}

/// <summary>The payment settings in force, with the secrets opened. Never serialized.</summary>
internal sealed record PaymentConfig(
    bool StripeEnabled,
    string? StripePublishableKey,
    string? StripeSecretKey,
    string? StripeWebhookSecret,
    bool NowPaymentsEnabled,
    string? NowPaymentsApiKey,
    string? NowPaymentsIpnSecret,
    bool NowPaymentsSandbox,
    IReadOnlyList<int> CryptoMonths)
{
    /// <summary>Card checkout works: on, with the secret key and the webhook secret.</summary>
    public bool StripeReady => StripeEnabled && StripeSecretKey is not null && StripeWebhookSecret is not null;

    /// <summary>Crypto works: on, with the API key and the IPN secret.</summary>
    public bool NowPaymentsReady => NowPaymentsEnabled && NowPaymentsApiKey is not null && NowPaymentsIpnSecret is not null;
}

/// <summary>Reads the payment settings. Payments are rare enough that it reads the row every time.</summary>
internal sealed class PaymentSettingsStore(AppDbContext db, PaymentSecrets secrets)
{
    public async Task<PaymentConfig> GetAsync(CancellationToken cancellationToken = default)
    {
        var row = await db.PaymentSettings.AsNoTracking().SingleOrDefaultAsync(cancellationToken) ?? new PaymentSettings();
        return From(row);
    }

    public PaymentConfig From(PaymentSettings row) => new(
        row.StripeEnabled,
        Blank(row.StripePublishableKey),
        secrets.Unseal(row.StripeSecretKeySealed),
        secrets.Unseal(row.StripeWebhookSecretSealed),
        row.NowPaymentsEnabled,
        secrets.Unseal(row.NowPaymentsApiKeySealed),
        secrets.Unseal(row.NowPaymentsIpnSecretSealed),
        row.NowPaymentsSandbox,
        row.CryptoMonths);

    private static string? Blank(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
