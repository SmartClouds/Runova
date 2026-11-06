using System.Globalization;
using System.Text.RegularExpressions;

namespace Runova.Monitoring.Core.Health;

/// <summary>
/// A health report is written by the project's own error handlers, which is exactly where a
/// connection string or an echoed header ends up. Every string that leaves a probe goes through
/// this before it is stored, shown or sent on. A port of <c>health/redact.ts</c> and the parts of
/// <c>security/redact.ts</c> it uses.
/// </summary>
/// <remarks>
/// In order: literal secrets the caller knows (the key it just sent), Authorization header values,
/// passwords inside URLs, values under secret-looking names (<c>KEY=value</c>, <c>key: value</c>,
/// <c>"key": "value"</c>, and the <c>Password=...;</c> pairs of a connection string), Runova health
/// keys, and the known token shapes. Plain error prose is left as it is.
///
/// The patterns spell out what JavaScript means by <c>\b</c> and <c>\s</c>, because .NET reads
/// both with Unicode rules and the two ports must mask exactly the same text.
/// </remarks>
public static partial class HealthRedactor
{
    private const string Redacted = "[redacted]";

    // JavaScript's \w, \b and \s (without the u flag).
    private const string Word = "[A-Za-z0-9_]";
    private const string B = "(?:(?<=" + Word + ")(?!" + Word + ")|(?<!" + Word + ")(?=" + Word + "))";
    private const string SpaceChars = @"\t\n\v\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF";
    private const string Space = "[" + SpaceChars + "]";

    /// <summary>Masks the health text: known secrets, then every secret shape the protocol knows.</summary>
    public static string Redact(string text, IReadOnlyList<string>? knownSecrets = null)
    {
        ArgumentNullException.ThrowIfNull(text);
        var output = MaskKnownSecrets(text, knownSecrets ?? []);
        output = AuthHeader().Replace(output, match => match.Groups[1].Value + " " + Redacted);
        output = UrlCredentials().Replace(output, match => match.Groups[1].Value + Redacted + "@");
        output = RedactAssignments(output);
        output = HealthKey().Replace(output, Redacted);
        return MaskSecrets(output);
    }

    /// <summary>
    /// Masks vendor-prefixed keys, JWTs, PEM private keys and long high-entropy runs, keeping the
    /// length as a hint (<c>[redacted 40 chars]</c>).
    /// </summary>
    public static string MaskSecrets(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        var output = text;
        foreach (var pattern in _secretPatterns)
        {
            output = pattern.Replace(output, MaskValue);
        }

        return output;
    }

    /// <summary>Masks literal secrets wherever they appear. Ones shorter than 8 characters are skipped.</summary>
    public static string MaskKnownSecrets(string text, IEnumerable<string?> secrets)
    {
        ArgumentNullException.ThrowIfNull(text);
        ArgumentNullException.ThrowIfNull(secrets);
        var output = text;
        foreach (var secret in secrets)
        {
            if (secret is null || secret.Length < 8)
            {
                continue;
            }

            output = output.Replace(secret, Redacted, StringComparison.Ordinal);
        }

        return output;
    }

    private static string MaskValue(Match match) =>
        string.Create(CultureInfo.InvariantCulture, $"[redacted {match.Length} chars]");

    private static readonly Regex[] _secretPatterns =
    [
        VendorKey(),
        GitHubToken(),
        SlackToken(),
        AwsAccessKey(),
        GoogleApiKey(),
        Jwt(),
        PemPrivateKey(),
        // Last, so the specific ones win first.
        LongRun(),
    ];

    private static readonly HashSet<string> _secretWords =
        ["pass", "password", "passwd", "passphrase", "pwd", "secret", "token", "apikey", "credential", "credentials"];

    private static readonly HashSet<string> _secretPairs =
        ["api key", "private key", "access key", "secret key", "client secret"];

    /// <summary>
    /// Splits a name into words (<c>DB_PASSWORD</c>, <c>clientSecret</c>, <c>api-key</c>) and asks
    /// whether any of them names a secret. Whole words only, so "Passing" or "tokenizer" is not one.
    /// </summary>
    private static bool IsSecretName(string name)
    {
        var words = NameSeparator()
            .Split(CamelHump().Replace(name, "$1 $2").ToLowerInvariant())
            .Where(word => word.Length > 0)
            .ToArray();
        for (var index = 0; index < words.Length; index++)
        {
            if (_secretWords.Contains(words[index]) || (index > 0 && _secretPairs.Contains(words[index - 1] + " " + words[index])))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// How deep values inside values are followed. Real text nests two or three levels; a body
    /// like <c>a=a=a=...</c> nests once per pair, which would overflow the stack (JavaScript throws
    /// there), so past this depth the rest of the value is masked whole.
    /// </summary>
    private const int MaxNesting = 32;

    private static string RedactAssignments(string text, int depth = 0) => Assignment().Replace(text, match =>
    {
        var prefix = match.Groups[1].Value;
        var name = match.Groups[2].Value;
        var value = match.Groups[3].Value;
        var quote = value.StartsWith('"') ? "\"" : value.StartsWith('\'') ? "'" : "";
        if (IsSecretName(name))
        {
            return value == Redacted ? match.Value : prefix + quote + Redacted + quote;
        }

        // A value can hold assignments of its own, as in "detail": "password=..." or
        // error: DB_PASSWORD=..., where the label's match would otherwise swallow the secret.
        if (quote.Length > 0)
        {
            var inner = value.Length >= 2 ? value[1..^1] : "";
            return prefix + quote + (depth < MaxNesting ? RedactAssignments(inner, depth + 1) : Redacted) + quote;
        }

        if (value.AsSpan().IndexOfAny(':', '=') < 0)
        {
            return match.Value;
        }

        return prefix + (depth < MaxNesting ? RedactAssignments(value, depth + 1) : Redacted);
    });

    /// <summary><c>Authorization: Bearer xxx</c> and <c>Basic xxx</c>.</summary>
    [GeneratedRegex(B + "(Bearer|Basic|Digest|Token)" + Space + "+[A-Za-z0-9._~+/=-]{6,}")]
    private static partial Regex AuthHeader();

    /// <summary>scheme://user:password@</summary>
    [GeneratedRegex(B + "([A-Za-z][A-Za-z0-9+.-]*://[^" + SpaceChars + ":/@]+:)([^" + SpaceChars + "@/]+)@")]
    private static partial Regex UrlCredentials();

    /// <summary>A name, then = or :, then the value. Whether the name is a secret's is decided per word.</summary>
    [GeneratedRegex("([\"']?" + B + "([A-Za-z][A-Za-z0-9_.-]*)[\"']?" + Space + "*[:=]" + Space + "*)(\"[^\"]*\"|'[^']*'|[^" + SpaceChars + ",;}&]+)")]
    private static partial Regex Assignment();

    [GeneratedRegex("([a-z0-9])([A-Z])")]
    private static partial Regex CamelHump();

    [GeneratedRegex("[" + SpaceChars + "_.-]+")]
    private static partial Regex NameSeparator();

    /// <summary>The keys Runova generates: rnh_ now, amh_ for keys made before the app was renamed.</summary>
    [GeneratedRegex(B + "(?:rnh|amh)_[A-Za-z0-9_-]{16,}")]
    private static partial Regex HealthKey();

    [GeneratedRegex(B + "(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}")]
    private static partial Regex VendorKey();

    [GeneratedRegex(B + "gh[pousr]_[A-Za-z0-9]{16,}")]
    private static partial Regex GitHubToken();

    [GeneratedRegex(B + "xox[abposr]-[A-Za-z0-9-]{10,}")]
    private static partial Regex SlackToken();

    [GeneratedRegex(B + "AKIA[0-9A-Z]{16}" + B)]
    private static partial Regex AwsAccessKey();

    [GeneratedRegex(B + "AIza[0-9A-Za-z_-]{35}" + B)]
    private static partial Regex GoogleApiKey();

    [GeneratedRegex(B + @"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")]
    private static partial Regex Jwt();

    [GeneratedRegex(@"-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----")]
    private static partial Regex PemPrivateKey();

    [GeneratedRegex(B + "[A-Za-z0-9+/]{40,}={0,2}" + B)]
    private static partial Regex LongRun();
}
