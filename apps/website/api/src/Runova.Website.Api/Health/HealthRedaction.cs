using System.Text.RegularExpressions;
using Npgsql;
using Runova.Website.Data;

namespace Runova.Website.Api.Health;

/// <summary>
/// Takes secrets out of the error text the healthcheck reports. It replaces the values of the
/// settings that hold secrets wherever they appear, and anything shaped like a password in a
/// connection string, a bearer token, a Runova health key or credentials in a URL.
/// </summary>
internal sealed partial class HealthRedaction
{
    public const string Mask = "***";

    // Shorter values would mask ordinary words.
    private const int ShortestSecret = 6;

    private readonly string[] _secrets;

    public HealthRedaction(IConfiguration configuration)
    {
        var secrets = new List<string?>
        {
            configuration["GitHub:Token"],
            configuration["Sentry:Dsn"],
            configuration["OTEL_EXPORTER_OTLP_HEADERS"],
            configuration[RunovaHealthEndpoint.TokenHashVariable],
        };
        if (configuration.GetConnectionString(DataServiceCollectionExtensions.ConnectionStringName) is { Length: > 0 } connectionString)
        {
            secrets.Add(connectionString);
            try
            {
                secrets.Add(new NpgsqlConnectionStringBuilder(connectionString).Password);
            }
            catch (ArgumentException)
            {
                // A connection string Npgsql can not read fails the postgres check on its own.
            }
        }

        _secrets = [.. secrets.OfType<string>().Where(s => s.Length >= ShortestSecret).Distinct().OrderByDescending(s => s.Length)];
    }

    public string Redact(string text)
    {
        foreach (var secret in _secrets)
        {
            text = text.Replace(secret, Mask, StringComparison.Ordinal);
        }

        text = PasswordSetting().Replace(text, "$1=" + Mask);
        text = BearerToken().Replace(text, "$1 " + Mask);
        text = HealthKey().Replace(text, Mask);
        return UrlCredentials().Replace(text, "://" + Mask + "@");
    }

    [GeneratedRegex(@"\b(password|pwd)\s*=\s*[^;\s""']*", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex PasswordSetting();

    [GeneratedRegex(@"\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex BearerToken();

    [GeneratedRegex(@"\brnh_[A-Za-z0-9_-]+", RegexOptions.CultureInvariant)]
    private static partial Regex HealthKey();

    [GeneratedRegex(@"://[^/\s:@]+:[^/\s@]+@", RegexOptions.CultureInvariant)]
    private static partial Regex UrlCredentials();
}
