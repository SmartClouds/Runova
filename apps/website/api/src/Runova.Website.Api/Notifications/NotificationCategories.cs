using Runova.Website.Api.Billing;
using Runova.Website.Api.CloudMonitoring;
using Runova.Website.Api.Dependencies;

namespace Runova.Website.Api.Notifications;

/// <summary>A category people can turn on or off. <see cref="FromDesktop"/> marks the ones the desktop app forwards.</summary>
internal sealed record NotificationCategory(string Id, string Label, bool FromDesktop);

/// <summary>
/// The categories of notification (E82). A category is both what a person switches on or off and
/// the <c>kind</c> of a message the desktop forwarded. Messages made on the server keep their own
/// kinds, which <see cref="OfKind"/> maps onto a category.
/// </summary>
internal static class NotificationCategories
{
    public const string AgentNeedsInput = "agent-needs-input";
    public const string AgentFinished = "agent-finished";
    public const string Tasks = "tasks";
    public const string Pipelines = "pipelines";
    public const string Deploys = "deploys";
    public const string Monitors = "monitors";
    public const string Dependencies = "dependencies";
    public const string Relay = "relay";
    public const string AiLimits = "ai-limits";
    public const string SecurityNews = "security-news";
    public const string ToolUpdates = "tool-updates";
    public const string Remote = "remote";
    public const string Account = "account";

    /// <summary>The order the settings screen shows them in.</summary>
    public static IReadOnlyList<NotificationCategory> All { get; } =
    [
        new(AgentNeedsInput, "Agent needs input", FromDesktop: true),
        new(AgentFinished, "Agent finished", FromDesktop: true),
        new(Tasks, "Tasks", FromDesktop: true),
        new(Pipelines, "Pipelines", FromDesktop: true),
        new(Deploys, "Deploys and servers", FromDesktop: true),
        new(Monitors, "Monitors", FromDesktop: true),
        new(Dependencies, "Package updates", FromDesktop: false),
        new(Relay, "Relay", FromDesktop: true),
        new(AiLimits, "AI limits", FromDesktop: true),
        new(SecurityNews, "Security news", FromDesktop: true),
        new(ToolUpdates, "Tool updates", FromDesktop: true),
        new(Remote, "Remote connections", FromDesktop: true),
        new(Account, "Account and plan", FromDesktop: false),
    ];

    private static readonly HashSet<string> _ids = [.. All.Select(c => c.Id)];

    private static readonly HashSet<string> _forwarded = [.. All.Where(c => c.FromDesktop).Select(c => c.Id)];

    public static bool IsKnown(string id) => _ids.Contains(id);

    /// <summary>True for a message the desktop app forwarded: only a phone sees those.</summary>
    public static bool IsForwarded(string kind) => _forwarded.Contains(kind);

    /// <summary>The kinds forwarded messages have, for the database filter.</summary>
    public static IReadOnlyCollection<string> ForwardedKinds => _forwarded;

    /// <summary>The category a message of this kind falls under.</summary>
    public static string OfKind(string kind) => kind switch
    {
        AlertNotifier.Kind => Dependencies,
        CloudMonitorNotifier.DownKind or CloudMonitorNotifier.RecoveredKind or CloudMonitorNotifier.PlanKind => Monitors,
        BillingNotices.Kind => Account,
        _ when _forwarded.Contains(kind) => kind,
        _ => Account,
    };

    /// <summary>The kinds a set of turned-off categories hides, for the database filter.</summary>
    public static IReadOnlyCollection<string> KindsOf(IReadOnlySet<string> categories) =>
        [.. _serverKinds.Where(k => categories.Contains(OfKind(k))).Concat(categories.Where(_forwarded.Contains))];

    private static readonly string[] _serverKinds =
    [
        AlertNotifier.Kind,
        CloudMonitorNotifier.DownKind,
        CloudMonitorNotifier.RecoveredKind,
        CloudMonitorNotifier.PlanKind,
        BillingNotices.Kind,
    ];
}
