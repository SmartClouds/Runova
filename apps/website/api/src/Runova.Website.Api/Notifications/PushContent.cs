using System.Buffers;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Runova.Website.Api.Notifications;

/// <summary>
/// What the desktop app sends about something that happened: a category and short named fields,
/// never a message. Unknown properties are refused, so nothing else can ride along.
/// </summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record NotificationEventRequest(
    string? Category,
    string? Status,
    string? Agent,
    string? Project,
    string? Subject,
    string? ItemId,
    IReadOnlyList<SealedCopyWrite>? SealedFor = null);

/// <summary>One phone's copy of a line the computer sealed (E92), as the computer sends it.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record SealedCopyWrite(string? KeyId, string? Sealed);

/// <summary>A composed one-line notification, ready to save and push. <c>Sealed</c> is the copies as stored.</summary>
internal sealed record ComposedNotification(string Category, string Line, string? Severity, string? ItemId, string? Sealed = null);

/// <summary>The sealed copies as the <c>Sealed</c> column holds them: a JSON array, which may be empty.</summary>
internal static class SealedCopies
{
    private static readonly JsonSerializerOptions _json = new(JsonSerializerDefaults.Web);

    public static string Write(IEnumerable<SealedCopyDto> copies) => JsonSerializer.Serialize(copies, _json);

    public static IReadOnlyList<SealedCopyDto>? Read(string? stored) =>
        stored is null ? null : JsonSerializer.Deserialize<List<SealedCopyDto>>(stored, _json);
}

/// <summary>
/// Turns a forwarded event into the one short line a phone shows (E82). The line is put together
/// here from fixed templates and a few bounded names; the desktop's own words never get in. A
/// value that holds a control character, a line break, shell punctuation, or runs too long is
/// refused, so terminal output has nowhere to go. Names on a screen never need those characters.
/// </summary>
internal static partial class PushContent
{
    public const int MaxLine = 140;
    public const int MaxAgent = 40;
    public const int MaxName = 80;
    public const int MaxSealedCopies = 8;
    public const int MaxSealedLength = 1024;

    /// <summary>What the server knows of a sealed notification, and what a phone with no copy shows.</summary>
    public const string SealedLine = "New activity on your computer";

    private const string Agent = "{agent}";
    private const string Project = "{project}";
    private const string Subject = "{subject}";

    private static readonly SearchValues<char> _terminalPunctuation = SearchValues.Create("$|<>=\\\"`{}[];*~^%!");

    /// <summary>What a status's template says and the fields it needs. <c>""</c> is a category with no status.</summary>
    private sealed record Template(string Text, string? Severity = null);

    private static readonly Dictionary<string, Dictionary<string, Template>> _templates = new(StringComparer.Ordinal)
    {
        [NotificationCategories.AgentNeedsInput] = new() { [""] = new($"{Agent} needs your input in {Project}", "warning") },
        [NotificationCategories.AgentFinished] = new() { [""] = new($"{Agent} finished in {Project}") },
        [NotificationCategories.Tasks] = new()
        {
            ["finished"] = new($"{Subject} finished in {Project}"),
            ["failed"] = new($"{Subject} failed in {Project}", "warning"),
            ["needs-input"] = new($"{Subject} needs your input in {Project}", "warning"),
            ["added"] = new($"A task was added in {Project}"),
        },
        [NotificationCategories.Pipelines] = new()
        {
            ["failed"] = new($"{Subject} failed in {Project}", "critical"),
            ["passed"] = new($"{Subject} passed in {Project}"),
            ["fixed"] = new($"Auto-fix got {Subject} passing in {Project}"),
            ["attention"] = new($"Auto-fix needs you in {Project}", "warning"),
            ["gave-up"] = new($"Auto-fix gave up on {Subject} in {Project}", "warning"),
        },
        [NotificationCategories.Deploys] = new()
        {
            ["critical"] = new($"Critical alert on {Subject}", "critical"),
            ["warning"] = new($"Warning on {Subject}", "warning"),
            ["info"] = new($"Notice on {Subject}"),
            ["review"] = new($"{Subject} needs a look", "warning"),
        },
        [NotificationCategories.Monitors] = new()
        {
            ["failed"] = new($"{Subject} is down", "critical"),
            ["recovered"] = new($"{Subject} is back up", "info"),
        },
        [NotificationCategories.Relay] = new()
        {
            ["attention"] = new($"A Relay task needs you in {Project}", "warning"),
            ["finished"] = new($"A relay finished in {Project}"),
            ["planner-ready"] = new($"A plan is ready to review in {Project}"),
            ["planner-failed"] = new($"Planning failed in {Project}", "warning"),
        },
        [NotificationCategories.AiLimits] = new()
        {
            ["threshold"] = new($"{Subject} is close to its limit", "warning"),
            ["reset"] = new($"{Subject} has reset"),
        },
        [NotificationCategories.SecurityNews] = new() { [""] = new($"A security alert affects {Subject}", "critical") },
        [NotificationCategories.ToolUpdates] = new() { [""] = new($"An update is available for {Subject}") },
        [NotificationCategories.Remote] = new()
        {
            ["connected"] = new($"{Subject} connected to this computer", "warning"),
            ["locked"] = new("Password access to this computer was locked", "warning"),
        },
    };

    /// <summary>The line for this event, or null with the reasons in <paramref name="errors"/>.</summary>
    public static ComposedNotification? Compose(NotificationEventRequest request, IDictionary<string, string[]> errors)
    {
        if (request.Category is null
            || !NotificationCategories.IsKnown(request.Category)
            || !NotificationCategories.IsForwarded(request.Category)
            || !_templates.TryGetValue(request.Category, out var statuses))
        {
            errors["category"] = ["That category can not be sent."];
            return null;
        }

        if (request.SealedFor is { } copies)
        {
            return ComposeSealed(request, copies, errors);
        }

        Check("agent", request.Agent, MaxAgent, errors);
        Check("project", request.Project, MaxName, errors);
        Check("subject", request.Subject, MaxName, errors);
        if (request.ItemId is not null && !ItemId().IsMatch(request.ItemId))
        {
            errors["itemId"] = ["itemId is up to 64 letters, digits, dots, dashes or underscores."];
        }

        if (!statuses.TryGetValue(request.Status ?? "", out var template))
        {
            errors["status"] = ["That status does not belong to this category."];
            return null;
        }

        Require("agent", Agent, template, request.Agent, errors);
        Require("project", Project, template, request.Project, errors);
        Require("subject", Subject, template, request.Subject, errors);
        if (errors.Count > 0)
        {
            return null;
        }

        var line = template.Text
            .Replace(Agent, request.Agent, StringComparison.Ordinal)
            .Replace(Project, request.Project, StringComparison.Ordinal)
            .Replace(Subject, request.Subject, StringComparison.Ordinal);
        return new ComposedNotification(request.Category, Clip(line), template.Severity, request.ItemId);
    }

    /// <summary>
    /// A sealed event carries its category, item id and copies and nothing else: a field the
    /// templates would have read is refused, so plain text can not travel beside the sealed copy.
    /// An empty list is still sealed; every phone then gets the generic line.
    /// </summary>
    private static ComposedNotification? ComposeSealed(NotificationEventRequest request, IReadOnlyList<SealedCopyWrite> copies, IDictionary<string, string[]> errors)
    {
        foreach (var (field, value) in new[] { ("status", request.Status), ("agent", request.Agent), ("project", request.Project), ("subject", request.Subject) })
        {
            if (value is not null)
            {
                errors[field] = ["A sealed event has only a category, an item id and its copies."];
            }
        }

        if (request.ItemId is not null && !ItemId().IsMatch(request.ItemId))
        {
            errors["itemId"] = ["itemId is up to 64 letters, digits, dots, dashes or underscores."];
        }

        if (copies.Count > MaxSealedCopies)
        {
            errors["sealedFor"] = [$"Send up to {MaxSealedCopies} copies."];
        }
        else
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            for (var i = 0; i < copies.Count; i++)
            {
                if (copies[i]?.KeyId is not { } keyId || !SealKeyId().IsMatch(keyId))
                {
                    errors[$"sealedFor[{i}].keyId"] = ["keyId is 12 letters, digits, dashes or underscores."];
                }
                else if (!seen.Add(keyId))
                {
                    errors[$"sealedFor[{i}].keyId"] = ["Each keyId appears once."];
                }

                if (copies[i]?.Sealed is not { } content || !IsSealedText(content))
                {
                    errors[$"sealedFor[{i}].sealed"] = [$"sealed is base64url of at most {MaxSealedLength} characters."];
                }
            }
        }

        return errors.Count > 0
            ? null
            : new ComposedNotification(request.Category!, SealedLine, null, request.ItemId, SealedCopies.Write(copies.Select(NotificationMapper.ToDto)));
    }

    /// <summary>A key id a phone or a computer gives for its X25519 key.</summary>
    public static bool IsSealKeyId(string value) => SealKeyId().IsMatch(value);

    // Base64url of no bytes is nothing, and a length of 4n + 1 can not come out of the encoding.
    private static bool IsSealedText(string value) =>
        value.Length is > 0 and <= MaxSealedLength && value.Length % 4 != 1 && SealedText().IsMatch(value);

    /// <summary>The line for a message made on the server: its title's first line, plain and short.</summary>
    public static string LineFromTitle(string title)
    {
        var first = title.Split('\n', '\r')[0];
        return Clip(new string(first.Where(c => !IsBanned(c)).ToArray()).Trim());
    }

    /// <summary>A fixed heading: the line says everything, so a push has no other title.</summary>
    public const string Title = "Runova";

    private static void Check(string field, string? value, int max, IDictionary<string, string[]> errors)
    {
        if (value is null)
        {
            return;
        }

        if (value.Trim().Length == 0)
        {
            errors[field] = [$"{field} can not be blank."];
        }
        else if (value.Length > max)
        {
            errors[field] = [$"{field} is up to {max} characters."];
        }
        else if (value.AsSpan().IndexOfAny(_terminalPunctuation) >= 0 || value.Any(IsBanned))
        {
            errors[field] = [$"{field} must be a plain name: no control characters, line breaks or shell punctuation."];
        }
    }

    private static void Require(string field, string placeholder, Template template, string? value, IDictionary<string, string[]> errors)
    {
        if (template.Text.Contains(placeholder, StringComparison.Ordinal) && value is null)
        {
            errors.TryAdd(field, [$"This status needs {field}."]);
        }
    }

    private static string Clip(string line) => line.Length <= MaxLine ? line : line[..(MaxLine - 3)] + "...";

    private static bool IsBanned(char c) =>
        char.IsControl(c)
        || char.GetUnicodeCategory(c) is System.Globalization.UnicodeCategory.Format
            or System.Globalization.UnicodeCategory.LineSeparator
            or System.Globalization.UnicodeCategory.ParagraphSeparator;

    [GeneratedRegex(@"\A[A-Za-z0-9_.:-]{1,64}\z", RegexOptions.CultureInvariant)]
    private static partial Regex ItemId();

    [GeneratedRegex(@"\A[A-Za-z0-9_-]{12}\z", RegexOptions.CultureInvariant)]
    private static partial Regex SealKeyId();

    [GeneratedRegex(@"\A[A-Za-z0-9_-]+\z", RegexOptions.CultureInvariant)]
    private static partial Regex SealedText();
}
