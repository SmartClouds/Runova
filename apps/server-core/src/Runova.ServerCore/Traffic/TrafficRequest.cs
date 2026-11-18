using System.Buffers.Binary;

namespace Runova.ServerCore.Traffic;

internal enum TrafficMethod
{
    None,
    Get,
    Head,
    Post,
    Other,
}

/// <summary>
/// One access log line as statistics and detection read it (E109, E110), made by the tailer from an
/// <see cref="AccessLogLine"/>. Path is the target before any '?', with nginx's escapes undone but
/// still percent-encoded as the visitor sent it; Query is what came after the '?'. Html is null when
/// the line does not say the content type. SuspiciousAgent is a user agent that carries "${", which
/// Log4Shell probes use.
/// </summary>
internal readonly record struct TrafficRequest(
    string Site,
    long AtUnixMs,
    IpKey Address,
    TrafficMethod Method,
    string Path,
    string? Query,
    int Status,
    long Bytes,
    int ResponseMs,
    bool? Html,
    string? Referrer,
    string? Host,
    UserAgentInfo Agent,
    GeoResult Geo,
    ulong Visitor,
    bool SuspiciousAgent);

/// <summary>Names shared by statistics rows and reports.</summary>
internal static class TrafficSites
{
    /// <summary>The site id the rows for every site together are kept under; no site id can be "*".</summary>
    public const string All = "*";

    /// <summary>A dimension's values past the ones kept, together.</summary>
    public const string Other = "Other";

    public const int MaxValueLength = 300;

    public static string Clip(string value) =>
        value.Length <= MaxValueLength ? value : value[..MaxValueLength];
}

/// <summary>
/// Response times in a fixed set of buckets (milliseconds), so the 95th percentile of any range
/// comes from adding the buckets of its hours or days. Stored as little-endian 64-bit counts.
/// </summary>
internal static class ResponseHistogram
{
    /// <summary>The upper bound of each bucket but the last, which holds everything slower.</summary>
    private static readonly int[] _bounds = [5, 10, 25, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 10_000, 30_000];

    public static int Buckets => _bounds.Length + 1;

    public static void Add(long[] counts, int milliseconds)
    {
        ArgumentNullException.ThrowIfNull(counts);
        var bucket = Array.BinarySearch(_bounds, Math.Max(0, milliseconds));
        counts[bucket < 0 ? ~bucket : bucket]++;
    }

    public static void AddTo(long[] total, long[] counts)
    {
        ArgumentNullException.ThrowIfNull(total);
        ArgumentNullException.ThrowIfNull(counts);
        for (var i = 0; i < Math.Min(total.Length, counts.Length); i++)
        {
            total[i] += counts[i];
        }
    }

    /// <summary>The time below which that share of requests finished, read within its bucket as if spread evenly.</summary>
    public static double Percentile(long[] counts, double share)
    {
        ArgumentNullException.ThrowIfNull(counts);
        var total = counts.Sum();
        if (total == 0)
        {
            return 0;
        }

        var target = share * total;
        double seen = 0;
        for (var i = 0; i < counts.Length; i++)
        {
            if (counts[i] == 0)
            {
                continue;
            }

            if (seen + counts[i] >= target)
            {
                var low = i == 0 ? 0 : _bounds[i - 1];
                var high = i < _bounds.Length ? _bounds[i] : _bounds[^1] * 2;
                return low + ((high - low) * ((target - seen) / counts[i]));
            }

            seen += counts[i];
        }

        return _bounds[^1];
    }

    public static byte[] Write(long[] counts)
    {
        ArgumentNullException.ThrowIfNull(counts);
        var bytes = new byte[Buckets * 8];
        for (var i = 0; i < Buckets; i++)
        {
            BinaryPrimitives.WriteInt64LittleEndian(bytes.AsSpan(i * 8), i < counts.Length ? counts[i] : 0);
        }

        return bytes;
    }

    /// <summary>The counts stored in a row; anything that is not a histogram reads as empty.</summary>
    public static long[] Read(byte[]? bytes)
    {
        var counts = new long[Buckets];
        if (bytes is { Length: var length } && length == Buckets * 8)
        {
            for (var i = 0; i < Buckets; i++)
            {
                counts[i] = BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(i * 8));
            }
        }

        return counts;
    }
}
