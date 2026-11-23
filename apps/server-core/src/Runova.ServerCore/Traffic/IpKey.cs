using System.Buffers.Binary;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Traffic;

/// <summary>
/// An IP address as a number, so the tailer can key maps and caches by address without an
/// <see cref="IPAddress"/> or a string per log line. IPv4, and IPv4 mapped into IPv6, keep the
/// address in the low 32 bits.
/// </summary>
internal readonly record struct IpKey(UInt128 Value, bool IsV4)
{
    private const int MaxText = 45;

    /// <summary>Private, loopback, link-local, carrier-grade NAT or unspecified: never a visitor on the internet.</summary>
    public bool IsLocal
    {
        get
        {
            if (IsV4)
            {
                var v4 = (uint)Value;
                return (v4 >> 24) is 0 or 10 or 127
                    || (v4 >> 16) == 0xA9FE
                    || (v4 >> 20) == 0xAC1
                    || (v4 >> 16) == 0xC0A8
                    || (v4 >> 22) == (100 << 2 | 1);
            }

            return Value == UInt128.Zero
                || Value == UInt128.One
                || (Value >> 121) == 0x7E
                || (Value >> 118) == 0x3FA;
        }
    }

    /// <summary>
    /// Who an attack is counted and blocked under (E110): an IPv4 address on its own, and the /64 of
    /// an IPv6 one, since one subscriber normally holds a whole /64 and could move around in it.
    /// </summary>
    public IpNetwork Visitor => IsV4 ? new IpNetwork(this, 32) : new IpNetwork(this with { Value = Value & ~((UInt128.One << 64) - 1) }, 64);

    public static IpKey FromAddress(IPAddress address)
    {
        ArgumentNullException.ThrowIfNull(address);
        if (address.IsIPv4MappedToIPv6)
        {
            address = address.MapToIPv4();
        }

        Span<byte> bytes = stackalloc byte[16];
        if (address.AddressFamily == AddressFamily.InterNetwork)
        {
            address.TryWriteBytes(bytes, out _);
            return new IpKey(BinaryPrimitives.ReadUInt32BigEndian(bytes), IsV4: true);
        }

        address.TryWriteBytes(bytes, out _);
        return new IpKey(BinaryPrimitives.ReadUInt128BigEndian(bytes), IsV4: false);
    }

    /// <summary>Plain dotted IPv4 (no shorthands, no leading zeros) or IPv6 without a zone, as ASCII.</summary>
    public static bool TryParse(ReadOnlySpan<byte> text, out IpKey key)
    {
        key = default;
        if (text.IsEmpty || text.Length > MaxText)
        {
            return false;
        }

        if (text.IndexOf((byte)':') < 0)
        {
            return TryParseV4(text, out key);
        }

        Span<char> chars = stackalloc char[text.Length];
        foreach (var b in text)
        {
            if (!(char.IsAsciiHexDigit((char)b) || b is (byte)':' or (byte)'.'))
            {
                return false;
            }
        }

        for (var i = 0; i < text.Length; i++)
        {
            chars[i] = (char)text[i];
        }

        if (!IPAddress.TryParse(chars, out var address) || address.AddressFamily != AddressFamily.InterNetworkV6 || address.ScopeId != 0)
        {
            return false;
        }

        key = FromAddress(address);
        return true;
    }

    public static bool TryParse(string text, out IpKey key)
    {
        ArgumentNullException.ThrowIfNull(text);
        Span<byte> bytes = stackalloc byte[Math.Min(text.Length, MaxText + 1)];
        if (text.Length > MaxText)
        {
            key = default;
            return false;
        }

        for (var i = 0; i < text.Length; i++)
        {
            if (text[i] > 127)
            {
                key = default;
                return false;
            }

            bytes[i] = (byte)text[i];
        }

        return TryParse(bytes[..text.Length], out key);
    }

    public IPAddress ToAddress()
    {
        if (IsV4)
        {
            return new IPAddress(BinaryPrimitivesReverse((uint)Value));
        }

        Span<byte> bytes = stackalloc byte[16];
        BinaryPrimitives.WriteUInt128BigEndian(bytes, Value);
        return new IPAddress(bytes);
    }

    public override string ToString() =>
        IsV4
            ? string.Create(CultureInfo.InvariantCulture, $"{(uint)Value >> 24}.{((uint)Value >> 16) & 0xFF}.{((uint)Value >> 8) & 0xFF}.{(uint)Value & 0xFF}")
            : ToAddress().ToString();

    /// <summary>IPAddress takes an IPv4 address as a little-endian long of its bytes in network order.</summary>
    private static long BinaryPrimitivesReverse(uint value) => BinaryPrimitives.ReverseEndianness(value);

    private static bool TryParseV4(ReadOnlySpan<byte> text, out IpKey key)
    {
        key = default;
        uint value = 0;
        var parts = 0;
        var digits = 0;
        var part = 0;
        for (var i = 0; i <= text.Length; i++)
        {
            if (i == text.Length || text[i] == (byte)'.')
            {
                if (digits == 0 || part > 255)
                {
                    return false;
                }

                value = (value << 8) | (uint)part;
                parts++;
                digits = 0;
                part = 0;
                continue;
            }

            var b = text[i];
            if (b is < (byte)'0' or > (byte)'9' || (digits == 1 && part == 0) || digits == 3)
            {
                return false;
            }

            part = (part * 10) + (b - '0');
            digits++;
        }

        if (parts != 4)
        {
            return false;
        }

        key = new IpKey(value, IsV4: true);
        return true;
    }
}

/// <summary>An address or a CIDR network, for allowlists and Cloudflare's ranges.</summary>
internal readonly record struct IpNetwork(IpKey Base, int Prefix)
{
    public bool Contains(IpKey key)
    {
        if (key.IsV4 != Base.IsV4)
        {
            return false;
        }

        var bits = Base.IsV4 ? 32 : 128;
        if (Prefix <= 0)
        {
            return true;
        }

        var shift = bits - Prefix;
        return (key.Value >> shift) == (Base.Value >> shift);
    }

    /// <summary>Whether every address of <paramref name="other"/> is in this network.</summary>
    public bool Covers(IpNetwork other) => Prefix <= other.Prefix && Contains(other.Base);

    /// <summary>Whether the two networks share any address.</summary>
    public bool Overlaps(IpNetwork other) => Covers(other) || other.Covers(this);

    /// <summary>As nginx is given it (<see cref="NginxAddresses.TryParseNetwork"/>): the address alone for a single address, else address/prefix.</summary>
    public string Text => Prefix == (Base.IsV4 ? 32 : 128) ? Base.ToString() : $"{Base}/{Prefix}";

    /// <summary>What <see cref="NginxAddresses.TryParseNetwork"/> accepts: an address, or a network without bits past its prefix.</summary>
    public static bool TryParse(string text, out IpNetwork network)
    {
        network = default;
        if (string.IsNullOrWhiteSpace(text) || !NginxAddresses.TryParseNetwork(text.Trim(), out var canonical, out _))
        {
            return false;
        }

        var slash = canonical.IndexOf('/', StringComparison.Ordinal);
        if (!IpKey.TryParse(slash < 0 ? canonical : canonical[..slash], out var address))
        {
            return false;
        }

        var prefix = slash < 0
            ? (address.IsV4 ? 32 : 128)
            : int.Parse(canonical.AsSpan(slash + 1), NumberStyles.None, CultureInfo.InvariantCulture);
        if (address.IsV4 && prefix > 32)
        {
            // An IPv4-mapped IPv6 network: its prefix counts from the IPv6 side.
            prefix = Math.Max(0, prefix - 96);
        }

        network = new IpNetwork(address, prefix);
        return true;
    }
}
