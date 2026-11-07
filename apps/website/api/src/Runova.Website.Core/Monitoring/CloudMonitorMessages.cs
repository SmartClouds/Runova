using System.Globalization;
using Runova.Website.Core.Billing;

namespace Runova.Website.Core.Monitoring;

/// <summary>What a monitor is called in a message: its name, its project and the environment, if any.</summary>
public sealed record MonitorLabel(string Name, string ProjectName, string? EnvironmentName)
{
    public override string ToString() =>
        string.IsNullOrWhiteSpace(EnvironmentName) ? $"{Name} in {ProjectName}" : $"{Name} in {ProjectName} ({EnvironmentName})";
}

/// <summary>A message for the app, the website and Telegram.</summary>
public sealed record MonitorMessage(string Title, string Body, string Telegram);

/// <summary>The words of the online monitor alerts (E55).</summary>
public static class CloudMonitorMessages
{
    public const int TelegramLimit = 4096;

    public static MonitorMessage Down(MonitorLabel monitor, string state, string? problem, string? seenFrom, string? confirmedFrom)
    {
        var title = $"{monitor} is down";
        var what = state switch
        {
            "unreachable" => "It could not be reached",
            "unauthorized" => "It refused the access key",
            "invalid" => "Its answer is not a health report",
            _ => "It reports that it is failing",
        };
        var body = string.IsNullOrWhiteSpace(problem) ? $"{what}." : $"{what}: {problem.Trim().TrimEnd('.')}.";
        if (seenFrom is not null)
        {
            body += confirmedFrom is null ? $" Seen from {seenFrom}." : $" Seen from {seenFrom} and confirmed from {confirmedFrom}.";
        }

        return new MonitorMessage(title, body, Clip($"🔴 {title}\n{body}"));
    }

    public static MonitorMessage Recovered(MonitorLabel monitor, TimeSpan downFor)
    {
        var title = $"{monitor} is back up";
        var body = $"It was down for {Duration(downFor)}.";
        return new MonitorMessage(title, body, Clip($"🟢 {title}\n{body}"));
    }

    /// <summary>The notice after plan enforcement changed a scope's monitors.</summary>
    public static MonitorMessage PlanChanged(string scopeName, Entitlement entitlement, int paused, int lengthened)
    {
        var title = $"Online monitors in {scopeName} changed";
        var allows = entitlement.MaxCloudMonitors switch
        {
            null => "any number of online monitors",
            1 => "1 online monitor",
            { } n => string.Create(CultureInfo.InvariantCulture, $"{n} online monitors"),
        };
        var parts = new List<string>();
        if (paused > 0)
        {
            parts.Add(paused == 1 ? "1 monitor was paused" : string.Create(CultureInfo.InvariantCulture, $"{paused} monitors were paused"));
        }

        if (lengthened > 0)
        {
            parts.Add(lengthened == 1 ? "1 now checks less often" : string.Create(CultureInfo.InvariantCulture, $"{lengthened} now check less often"));
        }

        var body = $"{scopeName} now uses {entitlement.Name}, which allows {allows} checked {CloudMonitorRules.Every(CloudMonitorRules.Floor(entitlement))} or slower.";
        if (parts.Count > 0)
        {
            body += $" {string.Join(" and ", parts)}.";
        }

        return new MonitorMessage(title, body, Clip($"⚠️ {title}\n{body}"));
    }

    public static string Duration(TimeSpan span)
    {
        if (span < TimeSpan.FromMinutes(1))
        {
            return "less than a minute";
        }

        static string Unit(int n, string one) => n == 1 ? $"1 {one}" : string.Create(CultureInfo.InvariantCulture, $"{n} {one}s");
        var days = (int)span.TotalDays;
        if (days > 0)
        {
            return span.Hours > 0 ? $"{Unit(days, "day")} {Unit(span.Hours, "hour")}" : Unit(days, "day");
        }

        var hours = (int)span.TotalHours;
        if (hours > 0)
        {
            return span.Minutes > 0 ? $"{Unit(hours, "hour")} {Unit(span.Minutes, "minute")}" : Unit(hours, "hour");
        }

        return Unit((int)span.TotalMinutes, "minute");
    }

    private static string Clip(string text)
    {
        if (text.Length <= TelegramLimit)
        {
            return text;
        }

        var cut = TelegramLimit - 1;
        if (char.IsHighSurrogate(text[cut - 1]))
        {
            cut--;
        }

        return text[..cut] + "…";
    }
}
