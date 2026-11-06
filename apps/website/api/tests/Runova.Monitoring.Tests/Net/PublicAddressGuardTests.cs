using System.Net;
using Runova.Monitoring.Core.Net;

namespace Runova.Monitoring.Tests.Net;

public sealed class PublicAddressGuardTests
{
    [Theory]
    [InlineData("8.8.8.8")]
    [InlineData("1.1.1.1")]
    [InlineData("93.184.216.34")]
    [InlineData("11.0.0.1")]
    [InlineData("9.255.255.255")]
    [InlineData("100.63.255.255")]
    [InlineData("100.128.0.0")]
    [InlineData("126.255.255.255")]
    [InlineData("128.0.0.1")]
    [InlineData("169.253.255.255")]
    [InlineData("169.255.0.1")]
    [InlineData("172.15.255.255")]
    [InlineData("172.32.0.0")]
    [InlineData("192.0.1.1")]
    [InlineData("192.0.3.1")]
    [InlineData("192.167.255.255")]
    [InlineData("192.169.0.0")]
    [InlineData("198.17.255.255")]
    [InlineData("198.20.0.0")]
    [InlineData("198.51.99.1")]
    [InlineData("203.0.112.1")]
    [InlineData("223.255.255.255")]
    [InlineData("2606:4700:4700::1111")]
    [InlineData("2001:4860:4860::8888")]
    [InlineData("2a00:1450:4001:82a::200e")]
    [InlineData("2001:200::1")]
    [InlineData("2c0f:fb50::1")]
    [InlineData("::ffff:8.8.8.8")]
    [InlineData("::8.8.8.8")]
    [InlineData("64:ff9b::808:808")]
    [InlineData("2002:808:808::1")]
    public void Lets_a_public_address_through(string address)
    {
        Assert.True(PublicAddressGuard.IsPublic(IPAddress.Parse(address)), PublicAddressGuard.WhyBlocked(IPAddress.Parse(address)));
    }

    [Theory]
    // IPv4: this network, loopback, private, link-local and metadata, CGNAT.
    [InlineData("0.0.0.0")]
    [InlineData("0.1.2.3")]
    [InlineData("127.0.0.1")]
    [InlineData("127.255.255.254")]
    [InlineData("10.0.0.1")]
    [InlineData("10.255.255.255")]
    [InlineData("172.16.0.1")]
    [InlineData("172.31.255.255")]
    [InlineData("192.168.0.1")]
    [InlineData("192.168.255.255")]
    [InlineData("169.254.0.1")]
    [InlineData("169.254.169.254")]
    [InlineData("100.64.0.1")]
    [InlineData("100.127.255.255")]
    // IPv4: special purpose, documentation, benchmarking, multicast, reserved and broadcast.
    [InlineData("192.0.0.8")]
    [InlineData("192.0.2.1")]
    [InlineData("192.88.99.1")]
    [InlineData("198.18.0.1")]
    [InlineData("198.19.255.255")]
    [InlineData("198.51.100.7")]
    [InlineData("203.0.113.9")]
    [InlineData("224.0.0.1")]
    [InlineData("239.255.255.250")]
    [InlineData("240.0.0.1")]
    [InlineData("255.255.255.255")]
    // IPv6: unspecified, loopback, unique local, link-local, site-local, multicast.
    [InlineData("::")]
    [InlineData("::1")]
    [InlineData("fc00::1")]
    [InlineData("fd12:3456:789a::1")]
    [InlineData("fd00:ec2::254")]
    [InlineData("fe80::1")]
    [InlineData("fe80::1%2")]
    [InlineData("febf:ffff::1")]
    [InlineData("fec0::1")]
    [InlineData("ff02::1")]
    [InlineData("ff05::2")]
    // IPv6 forms that carry a blocked IPv4 address.
    [InlineData("::ffff:127.0.0.1")]
    [InlineData("::ffff:10.0.0.1")]
    [InlineData("::ffff:169.254.169.254")]
    [InlineData("::ffff:0.0.0.0")]
    [InlineData("::127.0.0.1")]
    [InlineData("::10.0.0.1")]
    [InlineData("64:ff9b::a00:1")]
    [InlineData("64:ff9b::7f00:1")]
    [InlineData("64:ff9b::a9fe:a9fe")]
    [InlineData("2002:a00:1::1")]
    [InlineData("2002:7f00:1::")]
    [InlineData("2002:a9fe:a9fe::1")]
    // IPv6: Teredo, special purpose, documentation, local NAT64, discard, outside global unicast.
    [InlineData("2001::1")]
    [InlineData("2001:0:4136:e378:8000:63bf:3fff:fdd2")]
    [InlineData("2001:2::1")]
    [InlineData("2001:10::1")]
    [InlineData("2001:1ff::1")]
    [InlineData("2001:db8::1")]
    [InlineData("2001:db8:ffff::1")]
    [InlineData("3fff::1")]
    [InlineData("3fff:fff::1")]
    [InlineData("64:ff9b:1::1")]
    [InlineData("100::1")]
    [InlineData("5f00::1")]
    [InlineData("4000::1")]
    [InlineData("1::1")]
    [InlineData("::ffff:0:a00:1")]
    public void Refuses_an_address_that_is_not_public(string address)
    {
        var parsed = IPAddress.Parse(address);
        Assert.False(PublicAddressGuard.IsPublic(parsed));
        Assert.False(string.IsNullOrWhiteSpace(PublicAddressGuard.WhyBlocked(parsed)));
    }

    [Theory]
    [InlineData("127.0.0.1", "a loopback address")]
    [InlineData("169.254.169.254", "the cloud metadata address")]
    [InlineData("fd00:ec2::254", "the AWS metadata address")]
    [InlineData("10.1.2.3", "a private address in 10.0.0.0/8")]
    [InlineData("::ffff:10.1.2.3", "an IPv4-mapped form of 10.1.2.3, which is a private address in 10.0.0.0/8")]
    [InlineData("64:ff9b::7f00:1", "a NAT64 form of 127.0.0.1, which is a loopback address")]
    [InlineData("2002:a9fe:a9fe::1", "a 6to4 form of 169.254.169.254, which is the cloud metadata address")]
    [InlineData("2001::1", "a Teredo address in 2001::/32")]
    [InlineData("255.255.255.255", "the broadcast address")]
    public void Says_what_a_blocked_address_is(string address, string reason)
    {
        Assert.Equal(reason, PublicAddressGuard.WhyBlocked(IPAddress.Parse(address)));
    }

    [Fact]
    public void Writes_a_plain_message_for_a_literal_and_for_a_name()
    {
        var literal = new BlockedAddressException("127.0.0.1", IPAddress.Loopback, "a loopback address");
        Assert.Equal(
            "127.0.0.1 is not a public address (it is a loopback address). Runova only checks public addresses.",
            literal.Message);

        var named = new BlockedAddressException("intranet.example", IPAddress.Parse("10.0.0.5"), "a private address in 10.0.0.0/8");
        Assert.Equal(
            "intranet.example resolves to 10.0.0.5, which is not a public address (it is a private address in 10.0.0.0/8). Runova only checks public addresses.",
            named.Message);
        Assert.Equal("intranet.example", named.Host);
        Assert.Equal(IPAddress.Parse("10.0.0.5"), named.Address);

        var bracketed = new BlockedAddressException("[::1]", IPAddress.IPv6Loopback, "a loopback address");
        Assert.StartsWith("::1 is not a public address", bracketed.Message, StringComparison.Ordinal);
    }
}
