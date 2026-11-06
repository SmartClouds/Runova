namespace Runova.Website.Core.Dependencies;

/// <summary>The words of a dependency alert: the same in the app, on the website and on Telegram.</summary>
public static class AlertMessages
{
    /// <summary>Telegram's limit for one message.</summary>
    public const int TelegramLimit = 4096;

    public static string Title(string projectName, IReadOnlyList<Finding> findings)
    {
        if (findings.Count != 1)
        {
            return $"{findings.Count} package updates for {projectName}";
        }

        var finding = findings[0];
        return finding.Kind switch
        {
            FindingKinds.Security => $"Security fix for {finding.Name} in {projectName}",
            FindingKinds.Deprecated => $"{finding.Name} is deprecated in {projectName}",
            _ => $"{finding.Name} {finding.TargetVersion} is out for {projectName}",
        };
    }

    /// <summary>One line per finding, security first and worst first, then deprecations, then majors down to patches.</summary>
    public static string Body(IEnumerable<Finding> findings) =>
        string.Join('\n', Ordered(findings).Select(Line));

    public static IEnumerable<Finding> Ordered(IEnumerable<Finding> findings) =>
        findings.OrderBy(f => FindingKinds.Order(f.Kind))
            .ThenByDescending(f => Severities.Rank(f.Severity))
            .ThenBy(f => f.Name, StringComparer.OrdinalIgnoreCase);

    public static string Line(Finding finding)
    {
        var from = finding.TargetVersion is null
            ? $"{finding.Name} {finding.CurrentVersion}"
            : $"{finding.Name} {finding.CurrentVersion} to {finding.TargetVersion}";
        return finding.Kind switch
        {
            FindingKinds.Security => $"{from}: {finding.Severity} security issue, {finding.Summary} ({finding.AdvisoryId})",
            FindingKinds.Deprecated => string.IsNullOrWhiteSpace(finding.Summary) ? $"{from}: deprecated" : $"{from}: deprecated, {finding.Summary}",
            _ => $"{from}: {finding.Kind} update",
        };
    }

    /// <summary>The Telegram message: a marker, the title and the body, clipped to fit one message.</summary>
    public static string Telegram(string projectName, IReadOnlyList<Finding> findings)
    {
        var marker = findings.Any(f => f.Kind == FindingKinds.Security) ? "🔴" : "📦";
        var text = $"{marker} {Title(projectName, findings)}\n{Body(findings)}";
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
