using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Runova.Website.Api.Audit;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Audit;
using Runova.Website.Data;
using Runova.Website.Data.Billing;
using JsonOptions = Microsoft.AspNetCore.Http.Json.JsonOptions;

namespace Runova.Website.Api.Billing;

/// <summary>The payment settings as an Admin sees them: never a secret, only whether one is saved.</summary>
public sealed record PaymentSettingsDto(
    bool StripeEnabled,
    string? StripePublishableKey,
    bool HasStripeSecretKey,
    bool HasStripeWebhookSecret,
    string StripeWebhookUrl,
    bool NowPaymentsEnabled,
    bool HasNowPaymentsApiKey,
    bool HasNowPaymentsIpnSecret,
    bool NowPaymentsSandbox,
    string NowPaymentsIpnUrl,
    IReadOnlyList<int> CryptoMonths,
    DateTimeOffset? UpdatedAt,
    string Version);

/// <summary>A merge patch of the settings. A secret given replaces the saved one; null removes it.</summary>
public sealed record PaymentSettingsPatch(
    bool? StripeEnabled,
    string? StripePublishableKey,
    string? StripeSecretKey,
    string? StripeWebhookSecret,
    bool? NowPaymentsEnabled,
    string? NowPaymentsApiKey,
    string? NowPaymentsIpnSecret,
    bool? NowPaymentsSandbox,
    IReadOnlyList<int>? CryptoMonths);

public sealed record PaymentConnectionCheckRequest(string? Provider);

/// <summary>Whether the provider took the saved keys, and what it said when it did not.</summary>
public sealed record PaymentConnectionCheckDto(string Provider, bool Ok, string Detail);

/// <summary>
/// The Admin's payment switches and keys (E53), in the shape of the sign-in settings (E52). A
/// provider can only be on with its keys, and an Admin can ask either provider whether it takes them.
/// </summary>
internal static class PaymentSettingsEndpoints
{
    public const int MaxKey = 300;
    public const string StripeEventsPath = "/stripe-events";
    public const string NowPaymentsEventsPath = "/nowpayments-events";

    public static RouteGroupBuilder MapPaymentSettings(this RouteGroupBuilder api)
    {
        var settings = api.MapGroup("/payment-settings").RequireAuthorization(Policies.Admin);
        settings.MapGet("", GetAsync);
        settings.MapPatch("", PatchAsync).Accepts<PaymentSettingsPatch>("application/merge-patch+json", "application/json");
        api.MapPost("/payment-connection-checks", CheckAsync).RequireAuthorization(Policies.Admin);
        return api;
    }

    private static async Task<Ok<PaymentSettingsDto>> GetAsync(HttpContext http, AppDbContext db, IConfiguration configuration)
    {
        var row = await db.PaymentSettings.AsNoTracking().SingleAsync();
        return Answer(http, configuration, row);
    }

    private static async Task<Results<Ok<PaymentSettingsDto>, ValidationProblem, ProblemHttpResult>> PatchAsync(
        HttpContext http, AppDbContext db, PaymentSecrets secrets, AuditLog audit, TimeProvider time, IConfiguration configuration, IOptions<JsonOptions> json)
    {
        var row = await db.PaymentSettings.SingleAsync();
        if (Versions.CheckIfMatch(http.Request, row.Version) is { } precondition)
        {
            return precondition;
        }

        var errors = new Dictionary<string, string[]>();
        if (await RequestBodies.ReadObjectAsync(http.Request, errors) is not { } body
            || RequestBodies.Deserialize<PaymentSettingsPatch>(body, json.Value.SerializerOptions, errors) is not { } patch)
        {
            return ApiProblems.Invalid(errors);
        }

        var changed = new List<string>();
        var stripeEnabled = Switch(body, "stripeEnabled", patch.StripeEnabled, row.StripeEnabled, errors);
        var publishable = Text(body, "stripePublishableKey", patch.StripePublishableKey, row.StripePublishableKey, errors);
        var stripeSecret = Secret(body, "stripeSecretKey", patch.StripeSecretKey, row.StripeSecretKeySealed, secrets, errors);
        var webhookSecret = Secret(body, "stripeWebhookSecret", patch.StripeWebhookSecret, row.StripeWebhookSecretSealed, secrets, errors);
        var nowEnabled = Switch(body, "nowPaymentsEnabled", patch.NowPaymentsEnabled, row.NowPaymentsEnabled, errors);
        var apiKey = Secret(body, "nowPaymentsApiKey", patch.NowPaymentsApiKey, row.NowPaymentsApiKeySealed, secrets, errors);
        var ipnSecret = Secret(body, "nowPaymentsIpnSecret", patch.NowPaymentsIpnSecret, row.NowPaymentsIpnSecretSealed, secrets, errors);
        var sandbox = Switch(body, "nowPaymentsSandbox", patch.NowPaymentsSandbox, row.NowPaymentsSandbox, errors);
        var months = row.CryptoMonths;
        if (body.ContainsKey("cryptoMonths"))
        {
            var given = patch.CryptoMonths ?? [];
            if (given.Count is < 1 or > 4 || given.Any(m => m is < 1 or > 24) || given.Distinct().Count() != given.Count)
            {
                errors["cryptoMonths"] = ["Give 1 to 4 different periods of 1 to 24 months."];
            }
            else
            {
                months = [.. given.Order()];
            }
        }

        if (stripeEnabled && (stripeSecret.Value is null || webhookSecret.Value is null))
        {
            errors["stripeEnabled"] = ["Add the secret key and the webhook signing secret before turning card payments on."];
        }

        if (nowEnabled && (apiKey.Value is null || ipnSecret.Value is null))
        {
            errors["nowPaymentsEnabled"] = ["Add the API key and the IPN secret before turning crypto payments on."];
        }

        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        void Track(string field, bool differs)
        {
            if (differs)
            {
                changed.Add(field);
            }
        }

        Track("stripeEnabled", stripeEnabled != row.StripeEnabled);
        Track("stripePublishableKey", publishable != row.StripePublishableKey);
        Track("stripeSecretKey", stripeSecret.Changed);
        Track("stripeWebhookSecret", webhookSecret.Changed);
        Track("nowPaymentsEnabled", nowEnabled != row.NowPaymentsEnabled);
        Track("nowPaymentsApiKey", apiKey.Changed);
        Track("nowPaymentsIpnSecret", ipnSecret.Changed);
        Track("nowPaymentsSandbox", sandbox != row.NowPaymentsSandbox);
        Track("cryptoMonths", !months.SequenceEqual(row.CryptoMonths));

        if (changed.Count > 0)
        {
            row.StripeEnabled = stripeEnabled;
            row.StripePublishableKey = publishable;
            row.StripeSecretKeySealed = stripeSecret.Sealed;
            row.StripeWebhookSecretSealed = webhookSecret.Sealed;
            row.NowPaymentsEnabled = nowEnabled;
            row.NowPaymentsApiKeySealed = apiKey.Sealed;
            row.NowPaymentsIpnSecretSealed = ipnSecret.Sealed;
            row.NowPaymentsSandbox = sandbox;
            row.CryptoMonths = months;
            row.UpdatedAt = time.GetUtcNow();
            audit.Add(AuditActions.PaymentSettingsUpdate, AuditTargetTypes.PaymentSettings, row.Id, new { fields = changed });
            try
            {
                await db.SaveChangesAsync();
            }
            catch (DbUpdateConcurrencyException)
            {
                return Versions.Stale((await db.PaymentSettings.AsNoTracking().SingleAsync()).Version);
            }
        }

        return Answer(http, configuration, row);
    }

    /// <summary>Asks a provider whether it takes the saved keys. A no is still a 200: the check itself worked.</summary>
    private static async Task<Results<Ok<PaymentConnectionCheckDto>, ValidationProblem>> CheckAsync(
        PaymentConnectionCheckRequest request, PaymentSettingsStore store, StripeGateway stripe, NowPaymentsClient nowPayments, HttpContext http)
    {
        var config = await store.GetAsync(http.RequestAborted);
        switch (request.Provider)
        {
            case "stripe":
                var (stripeOk, stripeDetail) = config.StripeSecretKey is null
                    ? (false, "There is no secret key saved.")
                    : await stripe.CheckAsync(config, http.RequestAborted);
                return TypedResults.Ok(new PaymentConnectionCheckDto("stripe", stripeOk, stripeDetail));
            case "nowpayments":
                var (nowOk, nowDetail) = config.NowPaymentsApiKey is null
                    ? (false, "There is no API key saved.")
                    : await nowPayments.CheckAsync(config, http.RequestAborted);
                return TypedResults.Ok(new PaymentConnectionCheckDto("nowpayments", nowOk, nowDetail));
            default:
                return ApiProblems.Invalid("provider", "Give stripe or nowpayments.");
        }
    }

    private static Ok<PaymentSettingsDto> Answer(HttpContext http, IConfiguration configuration, PaymentSettings row)
    {
        var api = SiteUrl.From(configuration) + ApiV1.Prefix;
        Versions.SetETag(http.Response, row.Version);
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(PaymentSettingsMapper.ToDto(row, api + StripeEventsPath, api + NowPaymentsEventsPath));
    }

    private static bool Switch(JsonObject body, string name, bool? value, bool current, Dictionary<string, string[]> errors)
    {
        if (!body.ContainsKey(name))
        {
            return current;
        }

        if (value is null)
        {
            errors[name] = ["Give true or false."];
            return current;
        }

        return value.Value;
    }

    private static string? Text(JsonObject body, string name, string? value, string? current, Dictionary<string, string[]> errors)
    {
        if (!body.ContainsKey(name))
        {
            return current;
        }

        var trimmed = string.IsNullOrWhiteSpace(value) ? null : value.Trim();
        if (trimmed?.Length > MaxKey)
        {
            errors[name] = [$"Give at most {MaxKey} characters."];
            return current;
        }

        return trimmed;
    }

    /// <summary>A secret the patch names: sealed anew when given, gone when null or empty, else kept as it is.</summary>
    private static SecretField Secret(JsonObject body, string name, string? value, string? sealedNow, PaymentSecrets secrets, Dictionary<string, string[]> errors)
    {
        var current = secrets.Unseal(sealedNow);
        if (!body.ContainsKey(name))
        {
            return new SecretField(current, sealedNow, false);
        }

        var trimmed = string.IsNullOrWhiteSpace(value) ? null : value.Trim();
        if (trimmed?.Length > MaxKey)
        {
            errors[name] = [$"Give at most {MaxKey} characters."];
            return new SecretField(current, sealedNow, false);
        }

        return trimmed == current
            ? new SecretField(current, sealedNow, false)
            : new SecretField(trimmed, trimmed is null ? null : secrets.Seal(trimmed), true);
    }

    private sealed record SecretField(string? Value, string? Sealed, bool Changed);
}
