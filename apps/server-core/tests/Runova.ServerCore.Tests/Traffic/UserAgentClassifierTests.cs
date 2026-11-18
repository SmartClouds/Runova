using System.Text;
using Runova.ServerCore.Traffic;

namespace Runova.ServerCore.Tests.Traffic;

/// <summary>
/// E109 T3: real user agent strings sorted into browser and major version, operating system,
/// device, and bot name, by a small table of our own instead of a regex-heavy library. Results are
/// kept in an LRU of 4096, keyed by a hash of the bytes, so a known agent costs one lookup.
/// </summary>
public sealed class UserAgentClassifierTests
{
    [Theory]
    [InlineData("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", "Chrome", 131, "Windows", "Desktop")]
    [InlineData("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.86", "Edge", 131, "Windows", "Desktop")]
    [InlineData("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0", "Firefox", 133, "Windows", "Desktop")]
    [InlineData("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15", "Safari", 18, "macOS", "Desktop")]
    [InlineData("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0", "Opera", 115, "macOS", "Desktop")]
    [InlineData("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", "Chrome", 131, "Linux", "Desktop")]
    [InlineData("Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0", "Firefox", 132, "Linux", "Desktop")]
    [InlineData("Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", "Chrome", 131, "ChromeOS", "Desktop")]
    [InlineData("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1", "Safari", 18, "iOS", "Mobile")]
    [InlineData("Mozilla/5.0 (iPhone; CPU iPhone OS 17_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1", "Chrome", 131, "iOS", "Mobile")]
    [InlineData("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/605.1.15", "Firefox", 132, "iOS", "Mobile")]
    [InlineData("Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1", "Safari", 17, "iOS", "Tablet")]
    [InlineData("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36", "Chrome", 131, "Android", "Mobile")]
    [InlineData("Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36", "Samsung Internet", 26, "Android", "Mobile")]
    [InlineData("Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", "Chrome", 131, "Android", "Tablet")]
    [InlineData("Mozilla/5.0 (Android 14; Mobile; rv:133.0) Gecko/133.0 Firefox/133.0", "Firefox", 133, "Android", "Mobile")]
    [InlineData("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 YaBrowser/24.12.0.0 Safari/537.36", "Yandex Browser", 24, "Windows", "Desktop")]
    [InlineData("Mozilla/5.0 (Windows NT 6.1; WOW64; Trident/7.0; rv:11.0) like Gecko", "Internet Explorer", 11, "Windows", "Desktop")]
    [InlineData("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Vivaldi/7.0.3495.18", "Vivaldi", 7, "Windows", "Desktop")]
    public void A_browser_is_known_by_its_name_version_system_and_device(string agent, string browser, int major, string os, string device)
    {
        var info = new UserAgentClassifier().Classify(Encoding.UTF8.GetBytes(agent));

        Assert.Equal((browser, major, os, Enum.Parse<TrafficDevice>(device), (string?)null), (info.Browser, info.BrowserMajor, info.OperatingSystem, info.Device, info.Bot));
        Assert.False(info.IsBot);
    }

    [Theory]
    [InlineData("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "Googlebot")]
    [InlineData("Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.69 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "Googlebot")]
    [InlineData("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36", "Bingbot")]
    [InlineData("Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)", "YandexBot")]
    [InlineData("Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)", "AhrefsBot")]
    [InlineData("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)", "GPTBot")]
    [InlineData("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", "ClaudeBot")]
    [InlineData("facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)", "Facebook")]
    [InlineData("Twitterbot/1.0", "Twitterbot")]
    [InlineData("Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)", "Discordbot")]
    [InlineData("curl/8.5.0", "curl")]
    [InlineData("Wget/1.21.4", "Wget")]
    [InlineData("python-requests/2.32.3", "Python")]
    [InlineData("Go-http-client/1.1", "Go")]
    [InlineData("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36", "Headless Chrome")]
    [InlineData("Mozilla/5.0 zgrab/0.x", "zgrab")]
    [InlineData("Mozilla/5.0 (compatible; SomeNewCrawler/0.1)", "Other bot")]
    [InlineData("Mozilla/5.0 (compatible; Barkrowler/0.9; +https://babbar.tech/crawler)", "Other bot")]
    [InlineData("UptimeRobot/2.0 (http://www.uptimerobot.com/)", "UptimeRobot")]
    [InlineData("", "No user agent")]
    [InlineData("-", "No user agent")]
    public void A_bot_is_known_by_name_and_is_never_a_person(string agent, string bot)
    {
        var info = new UserAgentClassifier().Classify(Encoding.UTF8.GetBytes(agent));

        Assert.True(info.IsBot);
        Assert.Equal(bot, info.Bot);
        Assert.Equal(TrafficDevice.Bot, info.Device);
    }

    [Fact]
    public void An_agent_it_does_not_know_is_other_on_a_desktop()
    {
        var info = new UserAgentClassifier().Classify("SomeApp/1.0 (Unknown OS)"u8);

        Assert.Equal(("Other", 0, "Other", TrafficDevice.Desktop), (info.Browser, info.BrowserMajor, info.OperatingSystem, info.Device));
        Assert.False(info.IsBot);
    }

    [Fact]
    public void A_known_agent_comes_from_the_cache_and_the_cache_stays_bounded()
    {
        var classifier = new UserAgentClassifier(capacity: 4);
        var agent = "Mozilla/5.0 (X11; Linux x86_64) Firefox/133.0"u8.ToArray();

        var first = classifier.Classify(agent);
        var again = classifier.Classify(agent);
        for (var i = 0; i < 20; i++)
        {
            classifier.Classify(Encoding.UTF8.GetBytes($"Agent{i}/1.0"));
        }

        Assert.Same(first, again);
        Assert.Equal(4, classifier.Cached);
        Assert.Equal(4096, UserAgentClassifier.DefaultCapacity);
    }
}
