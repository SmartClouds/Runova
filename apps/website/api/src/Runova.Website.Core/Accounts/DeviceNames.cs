namespace Runova.Website.Core.Accounts;

/// <summary>A short, readable name for a browser from its User-Agent: "Firefox on Windows".</summary>
public static class DeviceNames
{
    public static (string Name, string Platform) FromUserAgent(string? userAgent)
    {
        var ua = userAgent ?? "";
        var platform = ua switch
        {
            _ when ua.Contains("Android", StringComparison.Ordinal) => "Android",
            _ when ua.Contains("iPhone", StringComparison.Ordinal) || ua.Contains("iPad", StringComparison.Ordinal) => "iOS",
            _ when ua.Contains("Windows", StringComparison.Ordinal) => "Windows",
            _ when ua.Contains("Mac OS X", StringComparison.Ordinal) || ua.Contains("Macintosh", StringComparison.Ordinal) => "macOS",
            _ when ua.Contains("CrOS", StringComparison.Ordinal) => "ChromeOS",
            _ when ua.Contains("Linux", StringComparison.Ordinal) => "Linux",
            _ => "Unknown",
        };
        var browser = ua switch
        {
            _ when ua.Contains("Edg/", StringComparison.Ordinal) => "Edge",
            _ when ua.Contains("OPR/", StringComparison.Ordinal) => "Opera",
            _ when ua.Contains("Firefox/", StringComparison.Ordinal) => "Firefox",
            _ when ua.Contains("Chrome/", StringComparison.Ordinal) => "Chrome",
            _ when ua.Contains("Safari/", StringComparison.Ordinal) => "Safari",
            _ => "Browser",
        };
        return (platform == "Unknown" ? browser : $"{browser} on {platform}", platform);
    }
}
