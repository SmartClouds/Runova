using System.Buffers.Binary;
using System.Text;

namespace Runova.RemoteAgent.Core;

/// <summary>The byte helpers the protocol shares with the app: base64url and length-prefixed fields.</summary>
public static class Bytes
{
    public static string ToB64u(ReadOnlySpan<byte> data) => Convert.ToBase64String(data).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public static byte[] FromB64u(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        if (text.Length % 4 == 1 || text.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '-' or '_')))
        {
            throw new FormatException("Not base64url.");
        }

        var padded = text.Replace('-', '+').Replace('_', '/');
        padded += new string('=', (4 - (padded.Length % 4)) % 4);
        return Convert.FromBase64String(padded);
    }

    public static byte[] Utf8(string text) => Encoding.UTF8.GetBytes(text);

    /// <summary>A big-endian u32 length, then the bytes.</summary>
    public static byte[] Lv(ReadOnlySpan<byte> value)
    {
        var output = new byte[4 + value.Length];
        BinaryPrimitives.WriteUInt32BigEndian(output, (uint)value.Length);
        value.CopyTo(output.AsSpan(4));
        return output;
    }

    public static byte[] Concat(params byte[][] parts)
    {
        var output = new byte[parts.Sum(p => p.Length)];
        var offset = 0;
        foreach (var part in parts)
        {
            part.CopyTo(output, offset);
            offset += part.Length;
        }

        return output;
    }
}
