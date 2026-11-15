using System.Text;
using Runova.ServerCore.Cloudflare;

namespace Runova.ServerCore.Tests.Cloudflare;

/// <summary>E95: only a token in Cloudflare's exact shape reaches the environment file, and a refusal never repeats it.</summary>
public sealed class TunnelTokenTests
{
    private static readonly Guid _tunnel = Guid.Parse("c1744f8b-faa1-48a4-9e5c-02ac921467fa");

    [Fact]
    public void A_cloudflare_token_gives_its_account_and_tunnel()
    {
        var token = TunnelToken.Parse(CloudflaredSetupTests.Token(_tunnel), _tunnel);

        Assert.Equal("699d98642c564d2e855e9661899b7252", token.AccountTag);
        Assert.Equal(_tunnel, token.TunnelId);
    }

    [Fact]
    public void A_token_for_another_tunnel_is_refused()
    {
        var refusal = Assert.Throws<CloudflareTunnelException>(() => TunnelToken.Parse(CloudflaredSetupTests.Token(Guid.NewGuid()), _tunnel));

        Assert.Contains("another tunnel", refusal.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("")]
    [InlineData("eyJhIjoiYSJ9\nTUNNEL_TOKEN=x")]
    [InlineData("eyJhIjoiYSJ9 ")]
    public void Anything_that_could_break_out_of_the_environment_file_is_refused(string text)
    {
        Assert.False(TunnelToken.TryParse(text, out _));
    }

    [Fact]
    public void Base64_that_is_not_the_token_s_json_is_refused_without_repeating_it()
    {
        var secretLooking = Convert.ToBase64String(Encoding.UTF8.GetBytes("{\"a\":\"x\",\"t\":\"not-a-guid\",\"s\":\"" + new string('k', 40) + "\"}"));

        var refusal = Assert.Throws<CloudflareTunnelException>(() => TunnelToken.Parse(secretLooking));

        Assert.DoesNotContain(secretLooking, refusal.Message, StringComparison.Ordinal);
    }
}
