using System.IO.Hashing;
using Runova.ServerCore.Traffic;

namespace Runova.ServerCore.Tests.Traffic;

/// <summary>
/// E109 T4: unique visitors over any range from HyperLogLog sketches (precision 12, 4 KB each,
/// about 1.6% error), merged across days. The values are fixed by a seed, so the error bound is
/// checked on the same million values every run and cannot flake.
/// </summary>
public sealed class HyperLogLogTests
{
    private static ulong Hash(long value) => XxHash64.HashToUInt64(BitConverter.GetBytes(value));

    [Fact]
    public void A_million_visitors_are_counted_within_the_error_bound()
    {
        var sketch = new HyperLogLog();
        var random = new Random(1234);
        var distinct = new HashSet<long>();
        while (distinct.Count < 1_000_000)
        {
            var value = random.NextInt64();
            distinct.Add(value);
            sketch.Add(Hash(value));
            if (distinct.Count % 3 == 0)
            {
                // The same visitor again changes nothing.
                sketch.Add(Hash(value));
            }
        }

        var error = Math.Abs(sketch.Estimate() - 1_000_000) / 1_000_000.0;
        Assert.True(error < 0.05, $"The estimate was {sketch.Estimate()}, {error:P2} off.");
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(10)]
    [InlineData(100)]
    [InlineData(1000)]
    public void Small_counts_are_close_to_exact(int count)
    {
        var sketch = new HyperLogLog();
        for (var i = 0; i < count; i++)
        {
            sketch.Add(Hash(i));
        }

        Assert.InRange(sketch.Estimate(), (long)Math.Floor(count * 0.97), (long)Math.Ceiling(count * 1.03));
    }

    [Fact]
    public void Merged_days_count_a_returning_visitor_once()
    {
        var monday = new HyperLogLog();
        var tuesday = new HyperLogLog();
        for (var i = 0; i < 20_000; i++)
        {
            monday.Add(Hash(i));
            tuesday.Add(Hash(i + 10_000));
        }

        var week = new HyperLogLog();
        week.Merge(monday);
        week.Merge(tuesday);

        Assert.InRange(week.Estimate(), 29_000, 31_000);
    }

    [Fact]
    public void A_sketch_is_4_kb_and_reads_back_the_same()
    {
        var sketch = new HyperLogLog();
        for (var i = 0; i < 5000; i++)
        {
            sketch.Add(Hash(i));
        }

        var bytes = sketch.ToArray();
        var back = HyperLogLog.From(bytes);

        Assert.Equal(4096, bytes.Length);
        Assert.Equal(sketch.Estimate(), back.Estimate());
        Assert.Equal(0, HyperLogLog.From(null).Estimate());
        Assert.Equal(0, HyperLogLog.From([1, 2, 3]).Estimate());
    }

    [Fact]
    public void A_visitor_is_a_salted_hash_of_address_and_agent()
    {
        var salt = new byte[32];
        salt[0] = 7;
        var visitors = new VisitorHasher(salt);
        var other = new VisitorHasher(new byte[32]);

        var a = visitors.Hash("203.0.113.7"u8, "Firefox"u8);

        Assert.Equal(a, visitors.Hash("203.0.113.7"u8, "Firefox"u8));
        Assert.NotEqual(a, visitors.Hash("203.0.113.8"u8, "Firefox"u8));
        Assert.NotEqual(a, visitors.Hash("203.0.113.7"u8, "Chrome"u8));
        Assert.NotEqual(a, other.Hash("203.0.113.7"u8, "Firefox"u8));
        // The field boundary counts: these concatenate to the same bytes.
        Assert.NotEqual(visitors.Hash("1.2.3.4"u8, "5x"u8), visitors.Hash("1.2.3.45"u8, "x"u8));
    }

    [Fact]
    public void The_salt_is_made_once_kept_private_and_read_back()
    {
        var folder = TestFolders.Create("traffic-salt");
        try
        {
            var first = VisitorHasher.LoadSalt(folder);
            var again = VisitorHasher.LoadSalt(folder);

            Assert.Equal(32, first.Length);
            Assert.Equal(first, again);
            if (!OperatingSystem.IsWindows())
            {
                Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(Path.Combine(folder, VisitorHasher.SaltFile)));
            }
        }
        finally
        {
            TestFolders.Delete(folder);
        }
    }
}
