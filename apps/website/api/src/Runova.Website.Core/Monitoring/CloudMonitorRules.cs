using System.Globalization;
using System.Net;
using Runova.Monitoring.Core.Net;
using Runova.Website.Core.Billing;

namespace Runova.Website.Core.Monitoring;

/// <summary>A monitor as plan enforcement sees it.</summary>
public sealed record EnforcedMonitor(long Id, DateTimeOffset CreatedAt, int IntervalSec, bool Paused);

/// <summary>What plan enforcement changes: monitors to pause, and intervals to lengthen.</summary>
public sealed record EnforcementResult(IReadOnlyList<long> Pause, IReadOnlyDictionary<long, int> Intervals)
{
    public bool Changed => Pause.Count > 0 || Intervals.Count > 0;
}

/// <summary>
/// What an online monitor may be (E55): an address a node may check, an interval the scope's
/// account type allows, and what happens to the monitors when the type goes down.
/// </summary>
public static class CloudMonitorRules
{
    public const int NameMax = 200;
    public const int UrlMax = 2048;
    public const int SecretMax = 1024;

    /// <summary>No account type checks more often than this, whatever an Admin sets.</summary>
    public const int ServerMinIntervalSec = 30;

    public const int MaxIntervalSec = 86_400;
    public const int TimeoutMinSec = 2;
    public const int TimeoutMaxSec = 60;

    /// <summary>How long a second opinion may take before the first node's word is taken.</summary>
    public static readonly TimeSpan ConfirmTimeout = TimeSpan.FromMinutes(2);

    // Names that only mean something on a private network.
    private static readonly string[] _privateSuffixes = [".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp"];

    /// <summary>Null when a node may check the address, otherwise why not.</summary>
    public static string? UrlProblem(string? url, bool allowInsecure)
    {
        var text = url?.Trim() ?? "";
        if (text.Length == 0)
        {
            return "Give the address of the health endpoint.";
        }

        if (text.Length > UrlMax)
        {
            return $"The address is longer than {UrlMax} characters.";
        }

        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri) || string.IsNullOrEmpty(uri.Host))
        {
            return "Give the full address, such as https://api.example.com/health.";
        }

        if (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp)
        {
            return "The address must start with http or https.";
        }

        if (uri.Scheme == Uri.UriSchemeHttp && !allowInsecure)
        {
            return "Use an https address, or allow plain http for this monitor.";
        }

        if (!string.IsNullOrEmpty(uri.UserInfo))
        {
            return "Leave the user name and password out of the address; give them as the monitor's access key.";
        }

        var host = uri.IdnHost.TrimEnd('.').ToLowerInvariant();
        if (host == "localhost" || host.EndsWith(".localhost", StringComparison.Ordinal))
        {
            return "This address is on this computer. Runova Cloud checks from the internet, so it can only check public addresses.";
        }

        if (uri.HostNameType is UriHostNameType.IPv4 or UriHostNameType.IPv6
            && IPAddress.TryParse(host.Trim('[', ']'), out var address)
            && PublicAddressGuard.WhyBlocked(address) is { } why)
        {
            return $"Runova Cloud checks from the internet, and this address is {why}.";
        }

        if (!host.Contains('.', StringComparison.Ordinal) || _privateSuffixes.Any(s => host.EndsWith(s, StringComparison.Ordinal)))
        {
            return "This name only works on a private network. Runova Cloud checks from the internet, so give a public address.";
        }

        return null;
    }

    /// <summary>Null when the scope's type allows the interval, otherwise why not.</summary>
    public static string? IntervalProblem(int? intervalSec, Entitlement entitlement)
    {
        var floor = Floor(entitlement);
        if (intervalSec is not { } seconds || seconds > MaxIntervalSec)
        {
            return $"Give an interval from {Every(floor)} to once a day.";
        }

        return seconds < floor
            ? $"{entitlement.Name} checks {Every(floor)} or slower. Choose a longer interval, or a type that allows it."
            : null;
    }

    public static string? TimeoutProblem(int? timeoutSec, int intervalSec) =>
        timeoutSec is not ({ } t and >= TimeoutMinSec and <= TimeoutMaxSec) || t >= intervalSec
            ? $"Give a timeout of {TimeoutMinSec} to {TimeoutMaxSec} seconds, shorter than the interval."
            : null;

    /// <summary>The shortest interval the type allows, never under the server's.</summary>
    public static int Floor(Entitlement entitlement) => Math.Max(ServerMinIntervalSec, entitlement.MinIntervalSec);

    /// <summary>
    /// Brings a scope's monitors within its type: the oldest active ones stay on and the newest
    /// over the limit are paused; every interval under the floor, paused or not, is lengthened to it.
    /// </summary>
    public static EnforcementResult Enforce(Entitlement entitlement, IReadOnlyList<EnforcedMonitor> monitors)
    {
        var pause = new List<long>();
        if (entitlement.MaxCloudMonitors is { } max)
        {
            pause.AddRange(monitors
                .Where(m => !m.Paused)
                .OrderBy(m => m.CreatedAt).ThenBy(m => m.Id)
                .Skip(Math.Max(0, max))
                .Select(m => m.Id));
        }

        var floor = Floor(entitlement);
        var intervals = monitors.Where(m => m.IntervalSec < floor).ToDictionary(m => m.Id, _ => floor);
        return new EnforcementResult(pause, intervals);
    }

    /// <summary>The start of the UTC hour the moment falls in.</summary>
    public static DateTimeOffset HourOf(DateTimeOffset at)
    {
        var utc = at.UtcDateTime;
        return new DateTimeOffset(utc.Year, utc.Month, utc.Day, utc.Hour, 0, 0, TimeSpan.Zero);
    }

    /// <summary>"every 30 seconds", "every minute", "every 5 minutes".</summary>
    public static string Every(int seconds) => seconds switch
    {
        60 => "every minute",
        3600 => "every hour",
        _ when seconds % 3600 == 0 => string.Create(CultureInfo.InvariantCulture, $"every {seconds / 3600} hours"),
        _ when seconds % 60 == 0 => string.Create(CultureInfo.InvariantCulture, $"every {seconds / 60} minutes"),
        _ => string.Create(CultureInfo.InvariantCulture, $"every {seconds} seconds"),
    };
}
