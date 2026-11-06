using Runova.Website.Core.Billing;

namespace Runova.Website.Tests.Billing;

/// <summary>
/// NOWPayments signs each IPN with HMAC-SHA512 over the body with its keys sorted at every level,
/// written without spaces. The expected value was made with openssl, not with this code.
/// </summary>
public sealed class NowPaymentsSignatureTests
{
    private const string Secret = "ipn-secret";
    private const string Expected = "397e5548edfb03f370babfe19797e024f5a8ee80335c8624cfb478c672aa94f8488bbf50f3f87179be8b93c0a8b7cf0a037b98f0680e2485491cd62d639e4190";

    // The same body as NOWPayments may post it: keys in any order, with spaces.
    private const string Body = """{ "payment_status": "finished", "b": 2, "order_id": "ord_1", "a": { "d": 1, "c": "x" } }""";

    [Fact]
    public void The_body_is_signed_with_its_keys_sorted_at_every_level()
    {
        Assert.Equal(Expected, NowPaymentsSignature.Compute(Body, Secret));
    }

    [Fact]
    public void A_right_signature_passes_in_any_case()
    {
        Assert.True(NowPaymentsSignature.Verify(Body, Expected, Secret));
        Assert.True(NowPaymentsSignature.Verify(Body, Expected.ToUpperInvariant(), Secret));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not-hex")]
    [InlineData("397e")]
    public void A_missing_or_short_signature_fails(string? signature)
    {
        Assert.False(NowPaymentsSignature.Verify(Body, signature, Secret));
    }

    [Fact]
    public void Another_secret_or_a_changed_body_fails()
    {
        Assert.False(NowPaymentsSignature.Verify(Body, Expected, "other"));
        Assert.False(NowPaymentsSignature.Verify(Body.Replace("finished", "confirmed", StringComparison.Ordinal), Expected, Secret));
    }

    [Fact]
    public void A_body_that_is_not_a_json_object_fails()
    {
        Assert.False(NowPaymentsSignature.Verify("[1,2]", Expected, Secret));
        Assert.False(NowPaymentsSignature.Verify("{", Expected, Secret));
    }
}
