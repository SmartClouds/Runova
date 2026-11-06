using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Runova.Website.Api.Billing;

/// <summary>An invoice NOWPayments made: its id and the page the person pays on.</summary>
internal sealed record NowPaymentsInvoice(string Id, string InvoiceUrl);

internal sealed class NowPaymentsException(string message) : Exception(message);

/// <summary>
/// Crypto payments through NOWPayments (E53), with the API key an Admin saved, against the real
/// API or its sandbox. Only invoices are made here; what is paid arrives as a signed IPN.
/// </summary>
internal sealed class NowPaymentsClient(HttpClient http, IOptions<BillingOptions> options)
{
    private static readonly JsonSerializerOptions _json = new(JsonSerializerDefaults.Web) { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };

    private Uri Base(PaymentConfig config) => config.NowPaymentsSandbox ? options.Value.NowPaymentsSandboxApiBase : options.Value.NowPaymentsApiBase;

    public async Task<NowPaymentsInvoice> CreateInvoiceAsync(
        PaymentConfig config, long amountCents, string currency, string orderId, string description, string ipnUrl, string successUrl, string cancelUrl, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(Base(config), "v1/invoice"))
        {
            Content = JsonContent.Create(new InvoiceRequest(
                decimal.Divide(amountCents, 100m), currency, orderId, description, ipnUrl, successUrl, cancelUrl), options: _json),
        };
        request.Headers.Add("x-api-key", config.NowPaymentsApiKey);
        using var response = await http.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new NowPaymentsException($"NOWPayments answered {(int)response.StatusCode} to the invoice.");
        }

        var invoice = await response.Content.ReadFromJsonAsync<InvoiceResponse>(_json, cancellationToken);
        if (invoice?.Id is not { } id || string.IsNullOrEmpty(invoice.InvoiceUrl))
        {
            throw new NowPaymentsException("NOWPayments answered without an invoice.");
        }

        return new NowPaymentsInvoice(id.ToString(), invoice.InvoiceUrl);
    }

    public async Task<(bool Ok, string Detail)> CheckAsync(PaymentConfig config, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(Base(config), "v1/merchant/coins"));
        request.Headers.Add("x-api-key", config.NowPaymentsApiKey);
        try
        {
            using var response = await http.SendAsync(request, cancellationToken);
            return response.IsSuccessStatusCode
                ? (true, config.NowPaymentsSandbox ? "NOWPayments took the key (sandbox)." : "NOWPayments took the key.")
                : (false, $"NOWPayments answered {(int)response.StatusCode}: the key was not accepted.");
        }
        catch (HttpRequestException)
        {
            return (false, "NOWPayments could not be reached.");
        }
    }

    private sealed record InvoiceRequest(
        decimal PriceAmount, string PriceCurrency, string OrderId, string OrderDescription, string IpnCallbackUrl, string SuccessUrl, string CancelUrl);

    // NOWPayments sends ids as a number or a string; JsonElement.ToString gives the text of either.
    private sealed record InvoiceResponse(JsonElement? Id, string? InvoiceUrl);
}
