using System.Diagnostics.CodeAnalysis;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Runova.ServerCore.Cloudflare;

/// <summary>A Cloudflare Tunnel step failed or was refused; the message says what to do.</summary>
internal sealed class CloudflareTunnelException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>
/// A tunnel token as Cloudflare hands it out: base64 of {"a": account tag, "t": tunnel id, "s":
/// secret}. It goes into an environment file, so anything but that exact shape is refused before
/// it is written (a newline would add a variable of its own).
/// </summary>
internal sealed partial record TunnelToken(string AccountTag, Guid TunnelId)
{
    public const int MaxLength = 4096;

    public static bool TryParse(string? text, [NotNullWhen(true)] out TunnelToken? token)
    {
        token = null;
        if (text is null || text.Length is 0 or > MaxLength || !Base64().IsMatch(text))
        {
            return false;
        }

        try
        {
            var normalized = text.Replace('-', '+').Replace('_', '/');
            normalized = normalized.PadRight(normalized.Length + ((4 - (normalized.Length % 4)) % 4), '=');
            using var json = JsonDocument.Parse(Encoding.UTF8.GetString(Convert.FromBase64String(normalized)));
            var root = json.RootElement;
            if (root.ValueKind == JsonValueKind.Object
                && root.TryGetProperty("a", out var account) && account.GetString() is { Length: > 0 and <= 64 } tag && tag.All(char.IsAsciiLetterOrDigit)
                && root.TryGetProperty("t", out var tunnel) && Guid.TryParse(tunnel.GetString(), out var id)
                && root.TryGetProperty("s", out var secret) && secret.GetString() is { Length: >= 32 })
            {
                token = new TunnelToken(tag, id);
                return true;
            }
        }
        catch (Exception error) when (error is FormatException or JsonException or InvalidOperationException)
        {
            return false;
        }

        return false;
    }

    /// <summary>The token, or a refusal that never repeats it.</summary>
    public static TunnelToken Parse(string? text, Guid? expectedTunnel = null)
    {
        if (!TryParse(text, out var token))
        {
            throw new CloudflareTunnelException("That is not a Cloudflare Tunnel token. Set the tunnel up again from the app.");
        }

        if (expectedTunnel is { } expected && token.TunnelId != expected)
        {
            throw new CloudflareTunnelException("The token belongs to another tunnel than the one the app set up. Set the tunnel up again from the app.");
        }

        return token;
    }

    [GeneratedRegex("^[A-Za-z0-9+/_=-]+$", RegexOptions.CultureInvariant)]
    private static partial Regex Base64();
}
