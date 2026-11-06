using Runova.Website.Core.Dependencies;

namespace Runova.Website.Tests.Dependencies;

public sealed class AlertMessagesTests
{
    private static readonly Finding _security = new(Ecosystems.Npm, "lodash", FindingKinds.Security, "4.17.20", "4.17.21", "GHSA-1", Severities.High, "Prototype pollution");
    private static readonly Finding _major = new(Ecosystems.NuGet, "Serilog", FindingKinds.Major, "3.1.1", "4.0.0", null, null, null);
    private static readonly Finding _deprecated = new(Ecosystems.Npm, "request", FindingKinds.Deprecated, "2.88.2", null, null, null, "request has been deprecated");

    [Fact]
    public void One_finding_names_the_package_in_the_title()
    {
        Assert.Equal("Security fix for lodash in Shop", AlertMessages.Title("Shop", [_security]));
        Assert.Equal("Serilog 4.0.0 is out for Shop", AlertMessages.Title("Shop", [_major]));
        Assert.Equal("request is deprecated in Shop", AlertMessages.Title("Shop", [_deprecated]));
    }

    [Fact]
    public void Several_findings_count_in_the_title()
    {
        Assert.Equal("3 package updates for Shop", AlertMessages.Title("Shop", [_security, _major, _deprecated]));
    }

    [Fact]
    public void The_body_has_one_line_per_package_worst_first()
    {
        var body = AlertMessages.Body([_major, _deprecated, _security]);

        Assert.Equal(
            [
                "lodash 4.17.20 to 4.17.21: high security issue, Prototype pollution (GHSA-1)",
                "request 2.88.2: deprecated, request has been deprecated",
                "Serilog 3.1.1 to 4.0.0: major update",
            ],
            body.Split('\n'));
    }

    [Fact]
    public void The_telegram_text_starts_with_the_title_and_fits_telegram()
    {
        var many = Enumerable.Range(0, 500).Select(i => _major with { Name = $"Package.Number{i}" }).ToList();

        var text = AlertMessages.Telegram("Shop", many);

        Assert.StartsWith("📦 500 package updates for Shop\n", text, StringComparison.Ordinal);
        Assert.True(text.Length <= AlertMessages.TelegramLimit);
        Assert.EndsWith("…", text, StringComparison.Ordinal);
    }

    [Fact]
    public void A_security_issue_marks_the_telegram_text()
    {
        Assert.StartsWith("🔴 Security fix for lodash in Shop", AlertMessages.Telegram("Shop", [_security]), StringComparison.Ordinal);
    }
}
