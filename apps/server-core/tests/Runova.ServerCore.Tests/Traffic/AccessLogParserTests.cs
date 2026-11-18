using System.Text;
using Runova.ServerCore.Traffic;

namespace Runova.ServerCore.Tests.Traffic;

/// <summary>
/// E109 T2: the access log parser reads the runova_main format and plain combined lines, keeps
/// nginx's \xHH escapes until a field is turned into text, and skips what it cannot read. It works
/// on the bytes as they are, with spans, so a warm parse allocates nothing.
/// </summary>
public sealed class AccessLogParserTests
{
    public const string Extended =
        "203.0.113.7 - - [18/Nov/2026:10:15:32 +0100] \"GET /blog/hello?ref=news HTTP/2.0\" 200 5123 \"https://news.example.org/top\" "
        + "\"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\" "
        + "\"app.example.com\" 0.042 \"text/html; charset=utf-8\" https 172.70.1.2 \"DE\" \"Berlin\" \"Land Berlin\"";

    public const string Combined =
        "198.51.100.4 - alice [01/Jan/2026:00:00:05 +0000] \"POST /wp-login.php HTTP/1.1\" 302 0 \"-\" \"curl/8.5.0\"";

    private static string Text(ReadOnlySpan<byte> field) => Encoding.UTF8.GetString(field);

    private static byte[] Bytes(string line) => Encoding.UTF8.GetBytes(line);

    [Fact]
    public void A_runova_main_line_gives_every_field()
    {
        Assert.True(AccessLogParser.TryParse(Bytes(Extended), out var line));

        Assert.Equal("203.0.113.7", Text(line.RemoteAddress));
        Assert.Equal(DateTimeOffset.Parse("2026-11-18T09:15:32Z", System.Globalization.CultureInfo.InvariantCulture).ToUnixTimeMilliseconds(), line.TimeUnixMs);
        Assert.Equal("GET", Text(line.Method));
        Assert.Equal("/blog/hello?ref=news", Text(line.Target));
        Assert.Equal(200, line.Status);
        Assert.Equal(5123, line.BodyBytes);
        Assert.Equal("https://news.example.org/top", Text(line.Referrer));
        Assert.StartsWith("Mozilla/5.0 (Windows NT 10.0", Text(line.UserAgent), StringComparison.Ordinal);
        Assert.True(line.Extended);
        Assert.Equal("app.example.com", Text(line.Host));
        Assert.Equal(42, line.RequestTimeMs);
        Assert.Equal("text/html; charset=utf-8", Text(line.ContentType));
        Assert.Equal("https", Text(line.Scheme));
        Assert.Equal("172.70.1.2", Text(line.ConnectingAddress));
        Assert.Equal("DE", Text(line.CloudflareCountry));
        Assert.Equal("Berlin", Text(line.CloudflareCity));
        Assert.Equal("Land Berlin", Text(line.CloudflareRegion));
    }

    [Fact]
    public void A_plain_combined_line_parses_without_the_extra_fields()
    {
        Assert.True(AccessLogParser.TryParse(Bytes(Combined), out var line));

        Assert.Equal("198.51.100.4", Text(line.RemoteAddress));
        Assert.Equal(1_767_225_605_000, line.TimeUnixMs);
        Assert.Equal("POST", Text(line.Method));
        Assert.Equal("/wp-login.php", Text(line.Target));
        Assert.Equal(302, line.Status);
        Assert.Equal(0, line.BodyBytes);
        Assert.True(line.Referrer.IsEmpty);
        Assert.Equal("curl/8.5.0", Text(line.UserAgent));
        Assert.False(line.Extended);
        Assert.True(line.Host.IsEmpty);
        Assert.Equal(-1, line.RequestTimeMs);
        Assert.True(line.ContentType.IsEmpty);
        Assert.True(line.CloudflareCountry.IsEmpty);
    }

    [Theory]
    [InlineData("2001:db8::7 - - [18/Nov/2026:10:15:32 -0530] \"HEAD / HTTP/1.1\" 304 0 \"-\" \"-\" \"a.test\" 0.000 \"-\" http 2001:db8::7 \"-\" \"-\" \"-\"", "2001:db8::7", "HEAD", "/", 304)]
    [InlineData("192.0.2.1 - - [18/Nov/2026:10:15:32 +0000] \"-\" 400 0 \"-\" \"-\"", "192.0.2.1", "", "", 400)]
    [InlineData("192.0.2.1 - - [18/Nov/2026:10:15:32 +0000] \"\\x16\\x03\\x01\\x00\\xF1\" 400 157 \"-\" \"-\"", "192.0.2.1", "", "", 400)]
    [InlineData("192.0.2.1 - - [18/Nov/2026:10:15:32 +0000] \"GET /old\" 200 12 \"-\" \"-\"", "192.0.2.1", "GET", "/old", 200)]
    [InlineData("192.0.2.1 - - [18/Nov/2026:10:15:32 +0000] \"GET /a HTTP/1.1\" 200 12 \"-\" \"x\"\r", "192.0.2.1", "GET", "/a", 200)]
    [InlineData("192.0.2.1 - - [18/Nov/2026:10:15:32 +0000] \"GET /a HTTP/1.1\" 200 12 \"-\" \"x\" \"only-a-host.test\"", "192.0.2.1", "GET", "/a", 200)]
    public void Odd_but_real_lines_parse(string text, string address, string method, string target, int status)
    {
        Assert.True(AccessLogParser.TryParse(Bytes(text), out var line));

        Assert.Equal(address, Text(line.RemoteAddress));
        Assert.Equal(method, Text(line.Method));
        Assert.Equal(target, Text(line.Target));
        Assert.Equal(status, line.Status);
    }

    [Fact]
    public void A_time_zone_offset_moves_the_time_to_utc()
    {
        Assert.True(AccessLogParser.TryParse(Bytes("2001:db8::7 - - [18/Nov/2026:10:15:32 -0530] \"HEAD / HTTP/1.1\" 304 0 \"-\" \"-\""), out var line));

        Assert.Equal(DateTimeOffset.Parse("2026-11-18T15:45:32Z", System.Globalization.CultureInfo.InvariantCulture).ToUnixTimeMilliseconds(), line.TimeUnixMs);
    }

    [Fact]
    public void A_line_with_only_some_of_the_extra_fields_counts_as_combined()
    {
        Assert.True(AccessLogParser.TryParse(Bytes("192.0.2.1 - - [18/Nov/2026:10:15:32 +0000] \"GET /a HTTP/1.1\" 200 12 \"-\" \"x\" \"only-a-host.test\""), out var line));

        Assert.False(line.Extended);
    }

    [Theory]
    [InlineData("")]
    [InlineData("hello world")]
    [InlineData("192.0.2.1 - - 18/Nov/2026:10:15:32 +0000 \"GET / HTTP/1.1\" 200 12 \"-\" \"x\"")]
    [InlineData("192.0.2.1 - - [18/Nov/2026:10:15:32 +0000] \"GET / HTTP/1.1\" 2x0 12 \"-\" \"x\"")]
    [InlineData("192.0.2.1 - - [18/Nov/2026:10:15:32 +0000] \"GET / HTTP/1.1\" 200 12 \"-\" \"x")]
    [InlineData("192.0.2.1 - - [18/Nov/2026:10:15:32 +0000] \"GET / HTTP/1.1")]
    [InlineData("192.0.2.1 - - [31/Feb/2026:10:15:32 +0000] \"GET / HTTP/1.1\" 200 12 \"-\" \"x\"")]
    [InlineData("192.0.2.1 - - [18/Abc/2026:10:15:32 +0000] \"GET / HTTP/1.1\" 200 12 \"-\" \"x\"")]
    [InlineData("192.0.2.1 - - [18/Nov/2026:10:15:32 +0000] \"GET / HTTP/1.1\" 99999 12 \"-\" \"x\"")]
    public void A_line_it_cannot_read_is_refused(string text)
    {
        Assert.False(AccessLogParser.TryParse(Bytes(text), out _));
    }

    [Fact]
    public void Escapes_stay_until_a_field_becomes_text()
    {
        var text = "192.0.2.1 - - [18/Nov/2026:10:15:32 +0000] \"GET /caf\\xC3\\xA9 HTTP/1.1\" 200 12 \"-\" \"say \\x22hi\\x22 \\x5C o/\"";
        Assert.True(AccessLogParser.TryParse(Bytes(text), out var line));

        Assert.Equal("say \\x22hi\\x22 \\x5C o/", Text(line.UserAgent));
        Assert.Equal("say \"hi\" \\ o/", AccessLogParser.Text(line.UserAgent));
        Assert.Equal("/café", AccessLogParser.Text(line.Target));
        Assert.Equal("broken \\xZZ and \\x4", AccessLogParser.Text("broken \\xZZ and \\x4"u8));
    }

    /// <remarks>
    /// Counted in bytes on this thread, not timed, so it cannot flake. The runtime may allocate a
    /// fixed kilobyte or so while it compiles the loop; one allocation per line would be at least
    /// 24 bytes a line, half a megabyte over these 20,000.
    /// </remarks>
    [Fact]
    public void A_warm_parse_allocates_nothing()
    {
        var bytes = Bytes(Extended);
        var old = Bytes(Combined);
        Parse(bytes, old, 1000);

        var (parsed, allocated) = Parse(bytes, old, 10_000);

        Assert.Equal(20_000, parsed);
        Assert.True(allocated <= 4096, $"Parsing 20,000 lines allocated {allocated} bytes.");
    }

    private static (int Parsed, long Allocated) Parse(byte[] extended, byte[] combined, int times)
    {
        var parsed = 0;
        var before = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < times; i++)
        {
            parsed += AccessLogParser.TryParse(extended, out var line) && line.Status == 200 ? 1 : 0;
            parsed += AccessLogParser.TryParse(combined, out var old) && old.Status == 302 ? 1 : 0;
        }

        return (parsed, GC.GetAllocatedBytesForCurrentThread() - before);
    }
}
