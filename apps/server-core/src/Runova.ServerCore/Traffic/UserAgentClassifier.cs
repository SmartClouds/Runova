using System.Globalization;
using System.IO.Hashing;

namespace Runova.ServerCore.Traffic;

internal enum TrafficDevice
{
    Desktop,
    Mobile,
    Tablet,
    Bot,
}

/// <summary>What a user agent says about the visitor. A bot has a name and is never counted as a person.</summary>
internal sealed record UserAgentInfo(string Browser, int BrowserMajor, string OperatingSystem, TrafficDevice Device, string? Bot)
{
    public bool IsBot => Bot is not null;
}

/// <summary>
/// Sorts user agents into browser and major version, operating system, device and bot name (E109),
/// with a small table of our own instead of a regex-heavy library. The order of the tables matters:
/// most browsers also name the ones they were built from (Edge says Chrome and Safari), so the more
/// specific names come first. Results are kept in an LRU keyed by XxHash64 of the agent's bytes, so
/// a known agent is one lookup and no string.
/// </summary>
internal sealed class UserAgentClassifier(int capacity = UserAgentClassifier.DefaultCapacity)
{
    public const int DefaultCapacity = 4096;

    public const string NoAgent = "No user agent";

    public const string OtherBot = "Other bot";

    public const string Other = "Other";

    /// <summary>Known bots and tools by a token in their agent (case does not matter), and the name they are counted under.</summary>
    private static readonly (string Token, string Name)[] _bots =
    [
        ("Googlebot", "Googlebot"), ("AdsBot-Google", "Googlebot"), ("Mediapartners-Google", "Googlebot"), ("Google-InspectionTool", "Googlebot"),
        ("bingbot", "Bingbot"), ("BingPreview", "Bingbot"), ("Slurp", "Yahoo"), ("DuckDuckBot", "DuckDuckBot"), ("Baiduspider", "Baiduspider"),
        ("YandexBot", "YandexBot"), ("YandexImages", "YandexBot"), ("Applebot", "Applebot"), ("AhrefsBot", "AhrefsBot"), ("SemrushBot", "SemrushBot"),
        ("MJ12bot", "MJ12bot"), ("DotBot", "DotBot"), ("PetalBot", "PetalBot"), ("Bytespider", "Bytespider"), ("Amazonbot", "Amazonbot"),
        ("GPTBot", "GPTBot"), ("ChatGPT-User", "ChatGPT"), ("OAI-SearchBot", "ChatGPT"), ("ClaudeBot", "ClaudeBot"), ("Claude-User", "ClaudeBot"),
        ("anthropic-ai", "ClaudeBot"), ("PerplexityBot", "PerplexityBot"), ("CCBot", "CCBot"), ("facebookexternalhit", "Facebook"),
        ("meta-externalagent", "Facebook"), ("Twitterbot", "Twitterbot"), ("LinkedInBot", "LinkedInBot"), ("Discordbot", "Discordbot"),
        ("Slackbot", "Slackbot"), ("TelegramBot", "TelegramBot"), ("WhatsApp", "WhatsApp"), ("Pinterestbot", "Pinterest"),
        ("UptimeRobot", "UptimeRobot"), ("Pingdom", "Pingdom"), ("StatusCake", "StatusCake"), ("HeadlessChrome", "Headless Chrome"),
        ("PhantomJS", "PhantomJS"), ("curl/", "curl"), ("Wget/", "Wget"), ("python-requests", "Python"), ("Python-urllib", "Python"),
        ("aiohttp", "Python"), ("python-httpx", "Python"), ("Go-http-client", "Go"), ("Java/", "Java"), ("axios/", "Node.js"),
        ("node-fetch", "Node.js"), ("undici", "Node.js"), ("libwww-perl", "Perl"), ("Scrapy", "Scrapy"), ("zgrab", "zgrab"),
        ("masscan", "masscan"), ("Nmap", "Nmap"), ("Nikto", "Nikto"), ("sqlmap", "sqlmap"), ("CensysInspect", "Censys"),
        ("Expanse", "Expanse"), ("InternetMeasurement", "InternetMeasurement"),
    ];

    /// <summary>Words that give away an unknown bot (case does not matter).</summary>
    private static readonly string[] _botHints = ["bot/", "bot;", "bot)", "crawler", "spider", "scraper", "+http", "headless"];

    /// <summary>Browsers by the token their version follows, most specific first.</summary>
    private static readonly (string Token, string Name)[] _browsers =
    [
        ("Edg/", "Edge"), ("EdgA/", "Edge"), ("EdgiOS/", "Edge"), ("OPR/", "Opera"), ("Opera/", "Opera"),
        ("SamsungBrowser/", "Samsung Internet"), ("YaBrowser/", "Yandex Browser"), ("Vivaldi/", "Vivaldi"),
        ("FxiOS/", "Firefox"), ("Firefox/", "Firefox"), ("CriOS/", "Chrome"), ("Chrome/", "Chrome"), ("Chromium/", "Chrome"),
    ];

    private static readonly UserAgentInfo _noAgent = new(Other, 0, Other, TrafficDevice.Bot, NoAgent);

    private readonly LruCache<ulong, UserAgentInfo> _cache = new(capacity);

    public int Cached => _cache.Count;

    public UserAgentInfo Classify(ReadOnlySpan<byte> agent)
    {
        if (agent.IsEmpty || agent is [(byte)'-'])
        {
            return _noAgent;
        }

        var key = XxHash64.HashToUInt64(agent);
        if (_cache.TryGet(key, out var known))
        {
            return known;
        }

        var info = Classify(AccessLogParser.Text(agent));
        _cache.Set(key, info);
        return info;
    }

    private static UserAgentInfo Classify(string agent)
    {
        var os = OperatingSystemOf(agent);
        if (BotOf(agent) is { } bot)
        {
            return new UserAgentInfo(Other, 0, os, TrafficDevice.Bot, bot);
        }

        var (browser, major) = BrowserOf(agent);
        return new UserAgentInfo(browser, major, os, DeviceOf(agent), null);
    }

    private static string? BotOf(string agent)
    {
        foreach (var (token, name) in _bots)
        {
            if (agent.Contains(token, StringComparison.OrdinalIgnoreCase))
            {
                return name;
            }
        }

        foreach (var hint in _botHints)
        {
            if (agent.Contains(hint, StringComparison.OrdinalIgnoreCase))
            {
                return OtherBot;
            }
        }

        return null;
    }

    private static (string Name, int Major) BrowserOf(string agent)
    {
        foreach (var (token, name) in _browsers)
        {
            var at = agent.IndexOf(token, StringComparison.Ordinal);
            if (at >= 0)
            {
                return (name, MajorAfter(agent, at + token.Length));
            }
        }

        if (agent.Contains("Safari/", StringComparison.Ordinal) && agent.IndexOf("Version/", StringComparison.Ordinal) is var version and >= 0)
        {
            return ("Safari", MajorAfter(agent, version + "Version/".Length));
        }

        if (agent.IndexOf("MSIE ", StringComparison.Ordinal) is var msie and >= 0)
        {
            return ("Internet Explorer", MajorAfter(agent, msie + "MSIE ".Length));
        }

        if (agent.Contains("Trident/", StringComparison.Ordinal))
        {
            var rv = agent.IndexOf("rv:", StringComparison.Ordinal);
            return ("Internet Explorer", rv >= 0 ? MajorAfter(agent, rv + 3) : 0);
        }

        return (Other, 0);
    }

    private static string OperatingSystemOf(string agent) =>
        agent.Contains("Windows", StringComparison.Ordinal) ? "Windows"
        : agent.Contains("iPhone", StringComparison.Ordinal) || agent.Contains("iPad", StringComparison.Ordinal) || agent.Contains("iPod", StringComparison.Ordinal) ? "iOS"
        : agent.Contains("Android", StringComparison.Ordinal) ? "Android"
        : agent.Contains("CrOS", StringComparison.Ordinal) ? "ChromeOS"
        : agent.Contains("Mac OS X", StringComparison.Ordinal) || agent.Contains("Macintosh", StringComparison.Ordinal) ? "macOS"
        : agent.Contains("Linux", StringComparison.Ordinal) || agent.Contains("X11", StringComparison.Ordinal) ? "Linux"
        : Other;

    private static TrafficDevice DeviceOf(string agent)
    {
        var android = agent.Contains("Android", StringComparison.Ordinal);
        if (agent.Contains("iPad", StringComparison.Ordinal) || agent.Contains("Tablet", StringComparison.Ordinal)
            || (android && !agent.Contains("Mobile", StringComparison.Ordinal)))
        {
            return TrafficDevice.Tablet;
        }

        return android || agent.Contains("Mobi", StringComparison.Ordinal) || agent.Contains("iPhone", StringComparison.Ordinal) || agent.Contains("iPod", StringComparison.Ordinal)
            ? TrafficDevice.Mobile
            : TrafficDevice.Desktop;
    }

    private static int MajorAfter(string agent, int start)
    {
        var end = start;
        while (end < agent.Length && end - start < 6 && char.IsAsciiDigit(agent[end]))
        {
            end++;
        }

        return end > start && int.TryParse(agent.AsSpan(start, end - start), NumberStyles.None, CultureInfo.InvariantCulture, out var major) ? major : 0;
    }
}
