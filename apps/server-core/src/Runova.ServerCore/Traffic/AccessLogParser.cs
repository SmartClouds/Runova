using System.Buffers;
using System.Text;

namespace Runova.ServerCore.Traffic;

/// <summary>
/// One access log line as nginx wrote it, each field a slice of the line's bytes with nginx's
/// <c>\xHH</c> escapes still in it (<see cref="AccessLogParser.Text"/> turns a field into text).
/// A field nginx wrote as "-" is empty. The extra fields of <see cref="TrafficLogFormat"/> are set
/// only when <see cref="Extended"/> is.
/// </summary>
internal ref struct AccessLogLine
{
    public ReadOnlySpan<byte> RemoteAddress { get; set; }

    public long TimeUnixMs { get; set; }

    /// <summary>Empty when the request line was not a request (a TLS handshake on port 80, or "-").</summary>
    public ReadOnlySpan<byte> Method { get; set; }

    /// <summary>The path and query as asked for, still percent-encoded.</summary>
    public ReadOnlySpan<byte> Target { get; set; }

    public int Status { get; set; }

    public long BodyBytes { get; set; }

    public ReadOnlySpan<byte> Referrer { get; set; }

    public ReadOnlySpan<byte> UserAgent { get; set; }

    public bool Extended { get; set; }

    public ReadOnlySpan<byte> Host { get; set; }

    /// <summary>-1 on a line without it.</summary>
    public int RequestTimeMs { get; set; }

    public ReadOnlySpan<byte> ContentType { get; set; }

    public ReadOnlySpan<byte> Scheme { get; set; }

    /// <summary>The address that connected, before the real-IP modules put the visitor's in its place.</summary>
    public ReadOnlySpan<byte> ConnectingAddress { get; set; }

    public ReadOnlySpan<byte> CloudflareCountry { get; set; }

    public ReadOnlySpan<byte> CloudflareCity { get; set; }

    public ReadOnlySpan<byte> CloudflareRegion { get; set; }
}

/// <summary>
/// Reads access log lines in the runova_main format, and plain combined lines written before it
/// (E109). No regular expressions and no allocations: fields are slices of the line, and only a
/// field that is kept is turned into a string. A line that does not fit is refused, for the caller
/// to count and skip.
/// </summary>
internal static class AccessLogParser
{
    private const int MaxMethodLength = 16;

    public static bool TryParse(ReadOnlySpan<byte> text, out AccessLogLine line)
    {
        line = default;
        line.RequestTimeMs = -1;
        if (!text.IsEmpty && text[^1] == (byte)'\r')
        {
            text = text[..^1];
        }

        var rest = text;
        if (!Field(ref rest, out var address) || address.IsEmpty
            || !Field(ref rest, out var dash) || dash is not [(byte)'-']
            || !Field(ref rest, out _)
            || rest.IsEmpty || rest[0] != (byte)'[')
        {
            return false;
        }

        var close = rest.IndexOf((byte)']');
        if (close < 0 || !TryParseTime(rest[1..close], out var time))
        {
            return false;
        }

        rest = rest[(close + 1)..];
        if (rest.IsEmpty || rest[0] != (byte)' ')
        {
            return false;
        }

        rest = rest[1..];
        if (!Quoted(ref rest, out var request)
            || !Field(ref rest, out var statusText) || !TryStatus(statusText, out var status)
            || !Field(ref rest, out var bytesText) || !TryNumber(bytesText, out var bytes)
            || !Quoted(ref rest, out var referrer)
            || !Quoted(ref rest, out var agent, last: true))
        {
            return false;
        }

        line.RemoteAddress = address;
        line.TimeUnixMs = time;
        line.Status = status;
        line.BodyBytes = bytes;
        line.Referrer = Dash(referrer);
        line.UserAgent = Dash(agent);
        SplitRequest(request, ref line);

        if (!rest.IsEmpty)
        {
            ReadExtended(rest, ref line);
        }

        return true;
    }

    /// <summary>The field as text, nginx's \xHH escapes turned back into the bytes they stand for, read as UTF-8.</summary>
    public static string Text(ReadOnlySpan<byte> field)
    {
        if (field.IndexOf((byte)'\\') < 0)
        {
            return Encoding.UTF8.GetString(field);
        }

        byte[]? rented = null;
        var buffer = field.Length <= 512 ? stackalloc byte[field.Length] : (rented = ArrayPool<byte>.Shared.Rent(field.Length));
        try
        {
            var length = Unescape(field, buffer);
            return Encoding.UTF8.GetString(buffer[..length]);
        }
        finally
        {
            if (rented is not null)
            {
                ArrayPool<byte>.Shared.Return(rented);
            }
        }
    }

    /// <summary>Writes the field without its escapes; the destination must be as long as the field. Returns the length written.</summary>
    public static int Unescape(ReadOnlySpan<byte> field, Span<byte> destination)
    {
        var written = 0;
        for (var i = 0; i < field.Length; i++)
        {
            if (field[i] == (byte)'\\' && i + 3 < field.Length && field[i + 1] == (byte)'x'
                && Hex(field[i + 2]) is var high and >= 0 && Hex(field[i + 3]) is var low and >= 0)
            {
                destination[written++] = (byte)((high << 4) | low);
                i += 3;
            }
            else
            {
                destination[written++] = field[i];
            }
        }

        return written;
    }

    private static void ReadExtended(ReadOnlySpan<byte> rest, ref AccessLogLine line)
    {
        if (!Quoted(ref rest, out var host)
            || !Field(ref rest, out var requestTime) || !TrySeconds(requestTime, out var milliseconds)
            || !Quoted(ref rest, out var contentType)
            || !Field(ref rest, out var scheme)
            || !Field(ref rest, out var connecting)
            || !Quoted(ref rest, out var country)
            || !Quoted(ref rest, out var city)
            || !Quoted(ref rest, out var region, last: true)
            || !rest.IsEmpty)
        {
            return;
        }

        line.Extended = true;
        line.Host = Dash(host);
        line.RequestTimeMs = milliseconds;
        line.ContentType = Dash(contentType);
        line.Scheme = Dash(scheme);
        line.ConnectingAddress = Dash(connecting);
        line.CloudflareCountry = Dash(country);
        line.CloudflareCity = Dash(city);
        line.CloudflareRegion = Dash(region);
    }

    /// <summary>"GET /path HTTP/1.1": the method only when it looks like one, the target up to the next space.</summary>
    private static void SplitRequest(ReadOnlySpan<byte> request, ref AccessLogLine line)
    {
        var space = request.IndexOf((byte)' ');
        if (space <= 0 || space > MaxMethodLength)
        {
            return;
        }

        var method = request[..space];
        foreach (var b in method)
        {
            if (b is < (byte)'A' or > (byte)'Z')
            {
                return;
            }
        }

        var target = request[(space + 1)..];
        var end = target.IndexOf((byte)' ');
        line.Method = method;
        line.Target = end < 0 ? target : target[..end];
    }

    /// <summary>Up to the next space (which is used up), or to the end.</summary>
    private static bool Field(scoped ref ReadOnlySpan<byte> rest, out ReadOnlySpan<byte> field)
    {
        if (rest.IsEmpty)
        {
            field = default;
            return false;
        }

        var space = rest.IndexOf((byte)' ');
        if (space < 0)
        {
            field = rest;
            rest = default;
        }
        else
        {
            field = rest[..space];
            rest = rest[(space + 1)..];
        }

        return true;
    }

    /// <summary>
    /// A field in double quotes. nginx escapes a quote inside one as \x22, so the next quote ends it.
    /// A space after it is used up; the last field of a format has none.
    /// </summary>
    private static bool Quoted(scoped ref ReadOnlySpan<byte> rest, out ReadOnlySpan<byte> field, bool last = false)
    {
        field = default;
        if (rest.IsEmpty || rest[0] != (byte)'"')
        {
            return false;
        }

        var end = rest[1..].IndexOf((byte)'"');
        if (end < 0)
        {
            return false;
        }

        field = rest.Slice(1, end);
        rest = rest[(end + 2)..];
        if (!rest.IsEmpty && rest[0] == (byte)' ')
        {
            rest = rest[1..];
        }
        else if (!rest.IsEmpty && !last)
        {
            return false;
        }

        return true;
    }

    private static ReadOnlySpan<byte> Dash(ReadOnlySpan<byte> field) => field is [(byte)'-'] ? default : field;

    private static bool TryStatus(ReadOnlySpan<byte> text, out int status)
    {
        status = 0;
        if (text.Length != 3 || !TryNumber(text, out var value) || value < 100)
        {
            return false;
        }

        status = (int)value;
        return true;
    }

    private static bool TryNumber(ReadOnlySpan<byte> text, out long value)
    {
        value = 0;
        if (text.IsEmpty || text.Length > 18)
        {
            return false;
        }

        foreach (var b in text)
        {
            if (b is < (byte)'0' or > (byte)'9')
            {
                return false;
            }

            value = (value * 10) + (b - '0');
        }

        return true;
    }

    /// <summary>nginx's $request_time: seconds with milliseconds, "0.042".</summary>
    private static bool TrySeconds(ReadOnlySpan<byte> text, out int milliseconds)
    {
        milliseconds = 0;
        var dot = text.IndexOf((byte)'.');
        var whole = dot < 0 ? text : text[..dot];
        var fraction = dot < 0 ? default : text[(dot + 1)..];
        if (!TryNumber(whole, out var seconds) || seconds > 86_400 || fraction.Length > 3 || (dot >= 0 && !TryNumber(fraction, out _)))
        {
            return false;
        }

        long ms = 0;
        for (var i = 0; i < 3; i++)
        {
            ms = (ms * 10) + (i < fraction.Length ? fraction[i] - '0' : 0);
        }

        milliseconds = (int)((seconds * 1000) + ms);
        return true;
    }

    /// <summary>nginx's $time_local: "18/Nov/2026:10:15:32 +0100", as Unix milliseconds.</summary>
    private static bool TryParseTime(ReadOnlySpan<byte> text, out long unixMs)
    {
        unixMs = 0;
        if (text.Length != 26 || text[2] != (byte)'/' || text[6] != (byte)'/' || text[11] != (byte)':'
            || text[14] != (byte)':' || text[17] != (byte)':' || text[20] != (byte)' ' || text[21] is not ((byte)'+' or (byte)'-'))
        {
            return false;
        }

        var month = Month(text.Slice(3, 3));
        if (month == 0
            || !TryNumber(text[..2], out var day) || !TryNumber(text.Slice(7, 4), out var year)
            || !TryNumber(text.Slice(12, 2), out var hour) || !TryNumber(text.Slice(15, 2), out var minute)
            || !TryNumber(text.Slice(18, 2), out var second) || !TryNumber(text.Slice(22, 2), out var offsetHours)
            || !TryNumber(text.Slice(24, 2), out var offsetMinutes)
            || year is < 1970 or > 9998 || day < 1 || day > DateTime.DaysInMonth((int)year, month)
            || hour > 23 || minute > 59 || second > 60 || offsetHours > 23 || offsetMinutes > 59)
        {
            return false;
        }

        var local = new DateTime((int)year, month, (int)day, (int)hour, (int)minute, (int)Math.Min(second, 59), DateTimeKind.Utc);
        var offset = ((offsetHours * 60) + offsetMinutes) * 60_000 * (text[21] == (byte)'-' ? -1 : 1);
        unixMs = ((local.Ticks - DateTime.UnixEpoch.Ticks) / TimeSpan.TicksPerMillisecond) - offset;
        return true;
    }

    private static int Month(ReadOnlySpan<byte> name) => name switch
    {
        [(byte)'J', (byte)'a', (byte)'n'] => 1,
        [(byte)'F', (byte)'e', (byte)'b'] => 2,
        [(byte)'M', (byte)'a', (byte)'r'] => 3,
        [(byte)'A', (byte)'p', (byte)'r'] => 4,
        [(byte)'M', (byte)'a', (byte)'y'] => 5,
        [(byte)'J', (byte)'u', (byte)'n'] => 6,
        [(byte)'J', (byte)'u', (byte)'l'] => 7,
        [(byte)'A', (byte)'u', (byte)'g'] => 8,
        [(byte)'S', (byte)'e', (byte)'p'] => 9,
        [(byte)'O', (byte)'c', (byte)'t'] => 10,
        [(byte)'N', (byte)'o', (byte)'v'] => 11,
        [(byte)'D', (byte)'e', (byte)'c'] => 12,
        _ => 0,
    };

    private static int Hex(byte b) => b switch
    {
        >= (byte)'0' and <= (byte)'9' => b - '0',
        >= (byte)'A' and <= (byte)'F' => b - 'A' + 10,
        >= (byte)'a' and <= (byte)'f' => b - 'a' + 10,
        _ => -1,
    };
}
