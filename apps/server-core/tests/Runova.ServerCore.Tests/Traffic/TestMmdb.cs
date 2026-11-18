using System.Buffers.Binary;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Runova.ServerCore.Tests.Traffic;

/// <summary>
/// Writes a tiny MaxMind DB file (format 2.0) mapping networks to countries, the way DB-IP's
/// country file is laid out: an IPv6 search tree with IPv4 under ::/96, 24-bit records, and each
/// record that ends a network pointing at a map like {"country": {"iso_code": "DE"}}. MaxMind.Db
/// has no writer, and a real DB-IP file is too big for the repository, so lookups are tested on this.
/// Networks must not nest.
/// </summary>
internal static class TestMmdb
{
    private const int RecordBytes = 3;

    public static byte[] Build(params (string Network, string Country)[] entries)
    {
        var root = new Node();
        var data = new MemoryStream();
        var offsets = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var (network, country) in entries)
        {
            if (!offsets.TryGetValue(country, out var offset))
            {
                offset = (int)data.Length;
                offsets[country] = offset;
                WriteMap(data, 1);
                WriteString(data, "country");
                WriteMap(data, 1);
                WriteString(data, "iso_code");
                WriteString(data, country);
            }

            Insert(root, network, offset);
        }

        // Nodes numbered breadth first, so every child comes after its parent.
        var nodes = new List<Node>();
        var queue = new Queue<Node>([root]);
        while (queue.TryDequeue(out var node))
        {
            node.Number = nodes.Count;
            nodes.Add(node);
            foreach (var child in new[] { node.Left, node.Right })
            {
                if (child is not null)
                {
                    queue.Enqueue(child);
                }
            }
        }

        var file = new MemoryStream();
        var nodeCount = nodes.Count;
        foreach (var node in nodes)
        {
            WriteRecord(file, Record(node.Left, node.LeftData, nodeCount));
            WriteRecord(file, Record(node.Right, node.RightData, nodeCount));
        }

        file.Write(new byte[16]);
        data.Position = 0;
        data.CopyTo(file);
        file.Write([0xAB, 0xCD, 0xEF]);
        file.Write("MaxMind.com"u8);
        WriteMap(file, 9);
        WriteString(file, "binary_format_major_version");
        WriteUnsigned(file, 5, 2);
        WriteString(file, "binary_format_minor_version");
        WriteUnsigned(file, 5, 0);
        WriteString(file, "build_epoch");
        WriteUint64(file, 1_700_000_000);
        WriteString(file, "database_type");
        WriteString(file, "DBIP-Country-Lite");
        WriteString(file, "description");
        WriteMap(file, 1);
        WriteString(file, "en");
        WriteString(file, "Runova test countries");
        WriteString(file, "ip_version");
        WriteUnsigned(file, 5, 6);
        WriteString(file, "languages");
        file.Write([0x01, 0x04]);
        WriteString(file, "en");
        WriteString(file, "node_count");
        WriteUnsigned(file, 6, (uint)nodeCount);
        WriteString(file, "record_size");
        WriteUnsigned(file, 5, 24);
        return file.ToArray();
    }

    public static byte[] Gzip(byte[] bytes)
    {
        var output = new MemoryStream();
        using (var gzip = new GZipStream(output, CompressionLevel.Fastest, leaveOpen: true))
        {
            gzip.Write(bytes);
        }

        return output.ToArray();
    }

    /// <summary>A small file with a few networks the tests know.</summary>
    public static byte[] Sample() => Build(
        ("81.2.69.0/24", "GB"),
        ("89.160.20.0/24", "SE"),
        ("203.0.113.0/24", "AU"),
        ("2001:db8:1::/48", "JP"));

    private static void Insert(Node root, string network, int dataOffset)
    {
        var slash = network.IndexOf('/', StringComparison.Ordinal);
        var address = IPAddress.Parse(network[..slash]);
        var prefix = int.Parse(network[(slash + 1)..], System.Globalization.CultureInfo.InvariantCulture);
        var bytes = new byte[16];
        if (address.AddressFamily == AddressFamily.InterNetwork)
        {
            address.GetAddressBytes().CopyTo(bytes, 12);
            prefix += 96;
        }
        else
        {
            address.GetAddressBytes().CopyTo(bytes, 0);
        }

        var node = root;
        for (var bit = 0; bit < prefix; bit++)
        {
            var right = ((bytes[bit / 8] >> (7 - (bit % 8))) & 1) == 1;
            if (bit == prefix - 1)
            {
                if (right)
                {
                    node.RightData = dataOffset;
                }
                else
                {
                    node.LeftData = dataOffset;
                }

                return;
            }

            if (right)
            {
                node = node.Right ??= new Node();
            }
            else
            {
                node = node.Left ??= new Node();
            }
        }
    }

    private static int Record(Node? child, int? dataOffset, int nodeCount) =>
        child is not null ? child.Number : dataOffset is { } offset ? nodeCount + 16 + offset : nodeCount;

    private static void WriteRecord(Stream stream, int value)
    {
        Span<byte> bytes = stackalloc byte[4];
        BinaryPrimitives.WriteInt32BigEndian(bytes, value);
        stream.Write(bytes[(4 - RecordBytes)..]);
    }

    private static void WriteMap(Stream stream, int count) => stream.WriteByte((byte)((7 << 5) | count));

    private static void WriteString(Stream stream, string text)
    {
        var bytes = Encoding.UTF8.GetBytes(text);
        if (bytes.Length >= 29)
        {
            stream.WriteByte((2 << 5) | 29);
            stream.WriteByte((byte)(bytes.Length - 29));
        }
        else
        {
            stream.WriteByte((byte)((2 << 5) | bytes.Length));
        }

        stream.Write(bytes);
    }

    /// <summary>uint16 (type 5) or uint32 (type 6), in as few bytes as the value needs.</summary>
    private static void WriteUnsigned(Stream stream, int type, uint value)
    {
        Span<byte> bytes = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(bytes, value);
        var length = value == 0 ? 0 : 4 - (BitOperationsLeadingZeroBytes(value));
        stream.WriteByte((byte)((type << 5) | length));
        stream.Write(bytes[(4 - length)..]);
    }

    private static int BitOperationsLeadingZeroBytes(uint value) => System.Numerics.BitOperations.LeadingZeroCount(value) / 8;

    /// <summary>uint64 is an extended type (9): a size byte, then 9 - 7.</summary>
    private static void WriteUint64(Stream stream, ulong value)
    {
        Span<byte> bytes = stackalloc byte[8];
        BinaryPrimitives.WriteUInt64BigEndian(bytes, value);
        stream.WriteByte(8);
        stream.WriteByte(2);
        stream.Write(bytes);
    }

    private sealed class Node
    {
        public Node? Left { get; set; }

        public Node? Right { get; set; }

        public int? LeftData { get; set; }

        public int? RightData { get; set; }

        public int Number { get; set; }
    }
}
