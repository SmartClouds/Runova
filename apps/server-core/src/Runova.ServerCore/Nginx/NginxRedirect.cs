using System.Globalization;
using System.Net;
using System.Net.Sockets;

namespace Runova.ServerCore.Nginx;

/// <summary>
/// Where a redirect sends visitors. The address goes into the configuration as one bare token of a
/// return line, so only a plain web address passes: http:// or https://, a host name or IP
/// address, an optional port, and a path (and a query, when the visitor's own path is not added)
/// made of characters nginx reads as part of the token and never as syntax or a variable.
/// </summary>
internal static class NginxRedirect
{
    public const int MaxLength = 2048;

    /// <summary>Why visitors cannot be sent to this address, or null when they can.</summary>
    /// <param name="ownNames">The site's own names: an address among them would send visitors round in a loop.</param>
    public static string? Problem(NginxRedirectUpstream redirect, IEnumerable<string> ownNames)
    {
        ArgumentNullException.ThrowIfNull(redirect);
        ArgumentNullException.ThrowIfNull(ownNames);
        var url = redirect.Url ?? string.Empty;
        if (url.Length == 0)
        {
            return "Enter the address to send visitors to, like https://example.com.";
        }

        if (url.Length > MaxLength)
        {
            return $"The address is longer than {MaxLength} characters.";
        }

        var rest = url.StartsWith("https://", StringComparison.Ordinal) ? url[8..]
            : url.StartsWith("http://", StringComparison.Ordinal) ? url[7..]
            : null;
        if (rest is null)
        {
            return $"'{NginxNames.Show(url)}' needs to start with https:// or http://.";
        }

        var end = rest.IndexOfAny(['/', '?']);
        var authority = end < 0 ? rest : rest[..end];
        var tail = end < 0 ? string.Empty : rest[end..];
        if (authority.Contains('@', StringComparison.Ordinal))
        {
            return "The address cannot carry a user name or password.";
        }

        if (HostOf(authority, out var host) is { } hostProblem)
        {
            return hostProblem;
        }

        foreach (var c in tail.Where(c => !IsPathCharacter(c)).Take(1))
        {
            return c == '#'
                ? "The address cannot have a #fragment."
                : $"The address cannot contain {Describe(c)}; write it percent-encoded.";
        }

        if (redirect.KeepPath && tail.Contains('?', StringComparison.Ordinal))
        {
            return "With the visitor's path kept, the address cannot have a query of its own. Turn off keeping the path to send everyone to this exact address.";
        }

        if (ownNames.Any(name => Covers(name, host)))
        {
            return $"{host} is one of this site's own names, so visitors would loop back to it forever.";
        }

        return null;
    }

    /// <summary>The return line's target: the address, with the visitor's path and query when kept.</summary>
    public static string Target(NginxRedirectUpstream redirect)
    {
        ArgumentNullException.ThrowIfNull(redirect);
        return redirect.KeepPath ? redirect.Url.TrimEnd('/') + "$request_uri" : redirect.Url;
    }

    public static int Status(NginxRedirectUpstream redirect) => redirect.Permanent ? 301 : 302;

    /// <summary>A name covers a host exactly, or as a wildcard for any name below it (not the bare domain, as in nginx).</summary>
    public static bool Covers(string name, string host)
    {
        var lower = (name ?? string.Empty).ToLowerInvariant();
        return lower.StartsWith("*.", StringComparison.Ordinal)
            ? host.EndsWith(lower[1..], StringComparison.Ordinal)
            : host == lower;
    }

    private static string? HostOf(string authority, out string host)
    {
        host = string.Empty;
        string? port;
        if (authority.StartsWith('['))
        {
            var close = authority.IndexOf(']', StringComparison.Ordinal);
            if (close < 0 || !IPAddress.TryParse(authority[1..close], out var v6) || v6.AddressFamily != AddressFamily.InterNetworkV6)
            {
                return $"'{NginxNames.Show(authority)}' is not an IPv6 address in brackets.";
            }

            host = authority[1..close].ToLowerInvariant();
            var after = authority[(close + 1)..];
            if (after.Length > 0 && after[0] != ':')
            {
                return $"'{NginxNames.Show(authority)}' is not a host and port.";
            }

            port = after.Length > 0 ? after[1..] : null;
        }
        else
        {
            var colon = authority.IndexOf(':', StringComparison.Ordinal);
            host = (colon < 0 ? authority : authority[..colon]).ToLowerInvariant();
            port = colon < 0 ? null : authority[(colon + 1)..];
            if (!NginxAddresses.TryParse(host, out _) && NginxNames.HostNameProblem(host) is { } problem)
            {
                return host.Length == 0 ? "The address needs a host name, like https://example.com." : problem;
            }
        }

        if (port is not null
            && (port.Length is 0 or > 5 || !port.All(char.IsAsciiDigit)
                || int.Parse(port, CultureInfo.InvariantCulture) is < 1 or > 65535))
        {
            return "The port in the address must be a number from 1 to 65535.";
        }

        return null;
    }

    /// <summary>
    /// Unreserved and percent-encoded characters, and the delimiters that are safe inside a bare
    /// nginx token. Never whitespace, quotes, a semicolon, braces, a backslash or $.
    /// </summary>
    private static bool IsPathCharacter(char c) =>
        char.IsAsciiLetterOrDigit(c) || "-._~/%!*+,=:@&?".Contains(c, StringComparison.Ordinal);

    private static string Describe(char c) => c switch
    {
        ' ' => "spaces",
        '$' => "$",
        '"' or '\'' => "quotes",
        ';' => "a semicolon",
        _ when char.IsControl(c) => "control characters",
        _ => $"'{c}'",
    };
}
