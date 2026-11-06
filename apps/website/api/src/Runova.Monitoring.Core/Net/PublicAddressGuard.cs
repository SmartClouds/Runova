using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;

namespace Runova.Monitoring.Core.Net;

/// <summary>
/// Decides whether a monitoring node may connect to an address. A node checks addresses users
/// type in, so without this anyone could point a monitor at the node's own loopback, the
/// provider's private network or the cloud metadata service and read the answer back.
/// </summary>
/// <remarks>
/// IPv4 is checked against the special-purpose registry. IPv6 is allowed only inside the global
/// unicast range 2000::/3, minus its special blocks; forms that carry an IPv4 address (mapped,
/// compatible, NAT64 and 6to4) are judged by that IPv4 address.
/// </remarks>
public static class PublicAddressGuard
{
    private static readonly (uint Network, int Bits, string Reason)[] _blockedV4 =
    [
        (0x00000000, 8, "an address in 0.0.0.0/8, which means this network"),
        (0x0A000000, 8, "a private address in 10.0.0.0/8"),
        (0x64400000, 10, "a carrier-grade NAT address in 100.64.0.0/10"),
        (0x7F000000, 8, "a loopback address"),
        (0xA9FE0000, 16, "a link-local address in 169.254.0.0/16, where cloud metadata services answer"),
        (0xAC100000, 12, "a private address in 172.16.0.0/12"),
        (0xC0000000, 24, "an IETF protocol address in 192.0.0.0/24"),
        (0xC0000200, 24, "a documentation address in 192.0.2.0/24"),
        (0xC0586300, 24, "a 6to4 relay address in 192.88.99.0/24"),
        (0xC0A80000, 16, "a private address in 192.168.0.0/16"),
        (0xC6120000, 15, "a benchmarking address in 198.18.0.0/15"),
        (0xC6336400, 24, "a documentation address in 198.51.100.0/24"),
        (0xCB007100, 24, "a documentation address in 203.0.113.0/24"),
        (0xE0000000, 4, "a multicast address"),
        (0xF0000000, 4, "a reserved address in 240.0.0.0/4"),
    ];

    /// <summary>True when the address is on the public internet and a node may connect to it.</summary>
    public static bool IsPublic(IPAddress address) => WhyBlocked(address) is null;

    /// <summary>
    /// Null for a public address, otherwise what it is, in words that follow "it is"
    /// ("a loopback address", "the cloud metadata address").
    /// </summary>
    public static string? WhyBlocked(IPAddress address)
    {
        ArgumentNullException.ThrowIfNull(address);
        var bytes = address.GetAddressBytes();
        return address.AddressFamily switch
        {
            AddressFamily.InterNetwork => V4(BinaryPrimitives.ReadUInt32BigEndian(bytes)),
            AddressFamily.InterNetworkV6 => V6(bytes),
            _ => "not an IP address",
        };
    }

    private static string? V4(uint value)
    {
        switch (value)
        {
            case 0:
                return "the unspecified address";
            case 0xFFFFFFFF:
                return "the broadcast address";
            case 0xA9FEA9FE:
                return "the cloud metadata address";
            default:
                break;
        }

        foreach (var (network, bits, reason) in _blockedV4)
        {
            var mask = uint.MaxValue << (32 - bits);
            if ((value & mask) == network)
            {
                return reason;
            }
        }

        return null;
    }

    private static string? V6(byte[] b)
    {
        var high = BinaryPrimitives.ReadUInt64BigEndian(b);
        var low = BinaryPrimitives.ReadUInt64BigEndian(b.AsSpan(8));

        if (high == 0 && low == 0)
        {
            return "the unspecified address";
        }

        if (high == 0 && low == 1)
        {
            return "a loopback address";
        }

        // ::ffff:a.b.c.d, the IPv4-mapped form.
        if (high == 0 && low >> 32 == 0xFFFF)
        {
            return Wrapped("an IPv4-mapped form of", (uint)low);
        }

        // ::a.b.c.d, the old IPv4-compatible form.
        if (high == 0 && low >> 32 == 0)
        {
            return Wrapped("an IPv4-compatible form of", (uint)low);
        }

        // 64:ff9b::a.b.c.d, the well-known NAT64 prefix, which a NAT64 gateway turns into IPv4.
        if (high == 0x0064_FF9B_0000_0000 && low >> 32 == 0)
        {
            return Wrapped("a NAT64 form of", (uint)low);
        }

        // 2002:aabb:ccdd::/48, 6to4, which carries the IPv4 address of its relay.
        if (b[0] == 0x20 && b[1] == 0x02)
        {
            return Wrapped("a 6to4 form of", (uint)(high >> 16));
        }

        // fd00:ec2::254. A unique local address anyway, named so the reason is plain.
        if (high == 0xFD00_0EC2_0000_0000 && low == 0x254)
        {
            return "the AWS metadata address";
        }

        if ((b[0] & 0xE0) != 0x20)
        {
            return b[0] switch
            {
                0xFF => "a multicast address",
                0xFC or 0xFD => "a unique local address in fc00::/7",
                0xFE when (b[1] & 0xC0) == 0x80 => "a link-local address in fe80::/10",
                0xFE when (b[1] & 0xC0) == 0xC0 => "a site-local address in fec0::/10",
                _ when high == 0x0100_0000_0000_0000 => "a discard-only address in 100::/64",
                _ when high >> 16 == 0x0064_FF9B_0001 => "a local NAT64 address in 64:ff9b:1::/48",
                _ => "an address outside the global unicast range 2000::/3",
            };
        }

        var first32 = (uint)(high >> 32);
        if (first32 == 0x2001_0DB8)
        {
            return "a documentation address in 2001:db8::/32";
        }

        if (first32 == 0x2001_0000)
        {
            return "a Teredo address in 2001::/32";
        }

        // 2001::/23 holds the IETF special-purpose blocks (benchmarking, ORCHID, AMT and more).
        if (first32 >> 9 == 0x2001_0000 >> 9)
        {
            return "a special-purpose address in 2001::/23";
        }

        if (first32 >> 12 == 0x3FFF_0000 >> 12)
        {
            return "a documentation address in 3fff::/20";
        }

        return null;
    }

    private static string? Wrapped(string form, uint v4)
    {
        var reason = V4(v4);
        if (reason is null)
        {
            return null;
        }

        Span<byte> bytes = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(bytes, v4);
        return $"{form} {new IPAddress(bytes)}, which is {reason}";
    }
}
