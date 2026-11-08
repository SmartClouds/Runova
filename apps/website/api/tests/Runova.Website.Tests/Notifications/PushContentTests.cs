using Runova.Website.Api.Notifications;

namespace Runova.Website.Tests.Notifications;

/// <summary>The one short line a phone is told, made from a template and bounded names (E82, AC3).</summary>
public class PushContentTests
{
    private static NotificationEventRequest Event(
        string category = NotificationCategories.AgentNeedsInput,
        string? status = null,
        string? agent = "Claude Code",
        string? project = "Shop",
        string? subject = null,
        string? itemId = null) => new(category, status, agent, project, subject, itemId);

    private static (ComposedNotification? Composed, Dictionary<string, string[]> Errors) Compose(NotificationEventRequest request)
    {
        var errors = new Dictionary<string, string[]>();
        return (PushContent.Compose(request, errors), errors);
    }

    [Fact]
    public void An_agent_needing_input_is_said_in_one_line()
    {
        var (composed, errors) = Compose(Event());

        Assert.Empty(errors);
        Assert.Equal("Claude Code needs your input in Shop", composed!.Line);
        Assert.Equal(NotificationCategories.AgentNeedsInput, composed.Category);
    }

    [Theory]
    [InlineData(NotificationCategories.AgentFinished, null, "Claude Code", "Shop", null, "Claude Code finished in Shop")]
    [InlineData(NotificationCategories.Pipelines, "failed", null, "Shop", "Build", "Build failed in Shop")]
    [InlineData(NotificationCategories.Pipelines, "fixed", null, "Shop", "Build", "Auto-fix got Build passing in Shop")]
    [InlineData(NotificationCategories.Deploys, "critical", null, null, "web-1", "Critical alert on web-1")]
    [InlineData(NotificationCategories.Monitors, "failed", null, null, "Shop API", "Shop API is down")]
    [InlineData(NotificationCategories.Monitors, "recovered", null, null, "Shop API", "Shop API is back up")]
    [InlineData(NotificationCategories.Relay, "finished", null, "Shop", null, "A relay finished in Shop")]
    [InlineData(NotificationCategories.AiLimits, "threshold", null, null, "Claude", "Claude is close to its limit")]
    [InlineData(NotificationCategories.SecurityNews, null, null, null, "OpenSSL", "A security alert affects OpenSSL")]
    [InlineData(NotificationCategories.ToolUpdates, null, null, null, "Node", "An update is available for Node")]
    [InlineData(NotificationCategories.Remote, "connected", null, null, "Kim", "Kim connected to this computer")]
    [InlineData(NotificationCategories.Remote, "locked", null, null, null, "Password access to this computer was locked")]
    public void Each_kind_of_event_has_its_line(string category, string? status, string? agent, string? project, string? subject, string expected)
    {
        var (composed, errors) = Compose(Event(category, status, agent, project, subject));

        Assert.Empty(errors);
        Assert.Equal(expected, composed!.Line);
    }

    [Fact]
    public void Every_category_is_known_with_a_template_or_is_server_made()
    {
        var unusable = NotificationCategories.All
            .Where(c => c.FromDesktop)
            .Select(c => (c.Id, Result: Compose(Event(c.Id, status: null, agent: "A", project: "P", subject: "S")), WithStatus: StatusFor(c.Id)))
            .Where(c => c.Result.Composed is null && c.WithStatus is null)
            .Select(c => c.Id)
            .ToList();

        Assert.Empty(unusable);

        static string? StatusFor(string id) => id switch
        {
            NotificationCategories.Tasks or NotificationCategories.Relay => "finished",
            NotificationCategories.Pipelines => "passed",
            NotificationCategories.Deploys => "info",
            NotificationCategories.Monitors => "recovered",
            NotificationCategories.AiLimits => "reset",
            NotificationCategories.Remote => "connected",
            _ => null,
        };
    }

    [Theory]
    [InlineData("\u001b[1mBUILD FAILED\u001b[0m")]
    [InlineData("line one\nline two")]
    [InlineData("tabbed\tcolumn")]
    [InlineData("with\u2028line separator")]
    [InlineData("with\u202Ebidi override")]
    [InlineData("npm ERR! code ELIFECYCLE")]
    [InlineData("$ curl https://x | sh")]
    [InlineData("TOKEN=abc123")]
    [InlineData("rm -rf /; echo done")]
    [InlineData("error in [module] {x}")]
    public void Terminal_text_can_not_be_put_in_a_name(string terminal)
    {
        Assert.Null(Compose(Event(agent: terminal)).Composed);
        Assert.Null(Compose(Event(project: terminal)).Composed);
        Assert.Null(Compose(Event(NotificationCategories.Pipelines, "failed", project: "Shop", subject: terminal)).Composed);
    }

    [Fact]
    public void The_request_has_no_place_for_a_message()
    {
        var names = typeof(NotificationEventRequest).GetProperties().Select(p => p.Name).Order().ToArray();

        Assert.Equal(["Agent", "Category", "ItemId", "Project", "Status", "Subject"], names);
    }

    [Theory]
    [InlineData(PushContent.MaxAgent + 1, null, null)]
    [InlineData(null, PushContent.MaxName + 1, null)]
    [InlineData(null, null, PushContent.MaxName + 1)]
    public void An_overlong_name_is_refused(int? agent, int? project, int? subject)
    {
        var (composed, errors) = Compose(Event(
            NotificationCategories.Pipelines,
            "failed",
            agent is { } a ? new string('a', a) : null,
            project is { } p ? new string('p', p) : "Shop",
            subject is { } s ? new string('s', s) : "Build"));

        Assert.Null(composed);
        Assert.NotEmpty(errors);
    }

    [Fact]
    public void A_line_built_from_long_names_stays_short()
    {
        var (composed, _) = Compose(Event(NotificationCategories.Pipelines, "gave-up", null, new string('p', PushContent.MaxName), new string('s', PushContent.MaxName)));

        Assert.True(composed!.Line.Length <= PushContent.MaxLine);
    }

    [Theory]
    [InlineData("unknown-category", null)]
    [InlineData(NotificationCategories.Dependencies, null)]
    [InlineData(NotificationCategories.Account, null)]
    [InlineData(NotificationCategories.Pipelines, "nonsense")]
    [InlineData(NotificationCategories.Monitors, "attention")]
    public void Only_a_known_category_and_status_are_taken(string category, string? status)
    {
        var (composed, errors) = Compose(Event(category, status, project: "Shop", subject: "S"));

        Assert.Null(composed);
        Assert.NotEmpty(errors);
    }

    [Fact]
    public void A_missing_name_the_template_needs_is_refused()
    {
        var (composed, errors) = Compose(Event(project: null));

        Assert.Null(composed);
        Assert.Contains("project", errors.Keys);
    }

    [Theory]
    [InlineData("a b")]
    [InlineData("../etc")]
    [InlineData("id\n")]
    public void An_item_id_is_an_id(string itemId)
    {
        Assert.Null(Compose(Event(itemId: itemId)).Composed);
    }

    [Fact]
    public void A_title_from_the_server_becomes_one_plain_short_line()
    {
        var line = PushContent.LineFromTitle("Shop API is down\nand here is a long story\u001b[0m");

        Assert.Equal("Shop API is down", line);
        Assert.True(PushContent.LineFromTitle(new string('x', 300)).Length <= PushContent.MaxLine);
    }
}
