using Runova.Website.Core.Accounts;

namespace Runova.Website.Tests.Accounts;

public sealed class DeviceNamesTests
{
    [Theory]
    [InlineData("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0", "Firefox on Windows", "Windows")]
    [InlineData("Mozilla/5.0 (Macintosh; Intel Mac OS X 15_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15", "Safari on macOS", "macOS")]
    [InlineData("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0", "Edge on Windows", "Windows")]
    [InlineData("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36", "Chrome on Linux", "Linux")]
    [InlineData("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36", "Chrome on Android", "Android")]
    [InlineData(null, "Browser", "Unknown")]
    public void Names_the_browser_and_platform(string? userAgent, string name, string platform)
    {
        Assert.Equal((name, platform), DeviceNames.FromUserAgent(userAgent));
    }
}
