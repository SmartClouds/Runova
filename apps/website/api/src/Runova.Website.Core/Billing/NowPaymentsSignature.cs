using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Runova.Website.Core.Billing;

/// <summary>
/// The signature NOWPayments puts on each IPN in <c>x-nowpayments-sig</c>: HMAC-SHA512, as lower
/// case hex, of the body with its keys sorted at every level and written without spaces, keyed
/// with the store's IPN secret.
/// </summary>
public static class NowPaymentsSignature
{
    private static readonly JsonSerializerOptions _compact = new() { WriteIndented = false, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public static string Compute(string body, string secret)
    {
        var sorted = Sort(JsonNode.Parse(body) as JsonObject ?? throw new JsonException("The body is not a JSON object."))!;
        var canonical = sorted.ToJsonString(_compact);
        return Convert.ToHexStringLower(HMACSHA512.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes(canonical)));
    }

    /// <summary>Whether the signature is right, compared in constant time. Anything unreadable fails.</summary>
    public static bool Verify(string body, string? signature, string secret)
    {
        if (string.IsNullOrWhiteSpace(signature))
        {
            return false;
        }

        string expected;
        try
        {
            expected = Compute(body, secret);
        }
        catch (JsonException)
        {
            return false;
        }

        var given = Encoding.ASCII.GetBytes(signature.Trim().ToLowerInvariant());
        return CryptographicOperations.FixedTimeEquals(given, Encoding.ASCII.GetBytes(expected));
    }

    private static JsonNode? Sort(JsonNode? node) => node switch
    {
        JsonObject obj => new JsonObject(obj
            .OrderBy(p => p.Key, StringComparer.Ordinal)
            .Select(p => KeyValuePair.Create(p.Key, Sort(p.Value)))),
        JsonArray array => new JsonArray([.. array.Select(Sort)]),
        null => null,
        _ => node.DeepClone(),
    };
}
