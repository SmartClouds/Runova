using Runova.Website.Core.Dependencies;

namespace Runova.Website.Tests.Dependencies;

public sealed class FindingRulesTests
{
    private static readonly InventoryItem _lodash = new(Ecosystems.Npm, "lodash", "4.17.20", Dev: false);

    [Fact]
    public void A_newer_stable_release_is_a_bump_of_its_kind()
    {
        var findings = FindingRules.For(_lodash, new PackageFactsView("5.0.0", null), []);

        var finding = Assert.Single(findings);
        Assert.Equal(FindingKinds.Major, finding.Kind);
        Assert.Equal("4.17.20", finding.CurrentVersion);
        Assert.Equal("5.0.0", finding.TargetVersion);
    }

    [Fact]
    public void Up_to_date_with_no_advisory_finds_nothing()
    {
        Assert.Empty(FindingRules.For(_lodash, new PackageFactsView("4.17.20", null), []));
    }

    [Fact]
    public void A_prerelease_latest_is_not_offered_to_a_stable_version()
    {
        Assert.Empty(FindingRules.For(_lodash, new PackageFactsView("5.0.0-beta.1", null), []));
    }

    [Fact]
    public void Each_advisory_on_the_version_is_a_security_finding_with_its_fix()
    {
        var advisories = new[]
        {
            new AdvisoryView("GHSA-1111", Severities.High, "Prototype pollution", "4.17.21"),
            new AdvisoryView("GHSA-2222", Severities.Critical, "Command injection", null),
        };

        var findings = FindingRules.For(_lodash, new PackageFactsView("4.17.20", null), advisories);

        Assert.Equal(2, findings.Count);
        Assert.All(findings, f => Assert.Equal(FindingKinds.Security, f.Kind));
        Assert.Equal(("GHSA-1111", Severities.High, "4.17.21"), (findings[0].AdvisoryId, findings[0].Severity, findings[0].TargetVersion));
        Assert.Equal("Command injection", findings[1].Summary);
    }

    [Fact]
    public void A_deprecated_package_is_a_finding_even_on_the_latest_version()
    {
        var findings = FindingRules.For(_lodash, new PackageFactsView("4.17.20", "Use lodash-es"), []);

        var finding = Assert.Single(findings);
        Assert.Equal(FindingKinds.Deprecated, finding.Kind);
        Assert.Equal("Use lodash-es", finding.Summary);
    }

    [Fact]
    public void A_version_that_can_not_be_read_still_gets_its_advisories_and_deprecation()
    {
        var item = new InventoryItem(Ecosystems.Npm, "left-pad", "github:someone/left-pad", Dev: true);

        var findings = FindingRules.For(item, new PackageFactsView("9.0.0", "gone"), [new AdvisoryView("GHSA-3", Severities.Low, "x", null)]);

        Assert.Equal([FindingKinds.Security, FindingKinds.Deprecated], findings.Select(f => f.Kind));
    }

    [Fact]
    public void Without_registry_facts_only_advisories_count()
    {
        Assert.Empty(FindingRules.For(_lodash, null, []));
    }

    [Theory]
    [InlineData("4.17.20", new[] { "4.17.19", "4.17.21", "5.0.0" }, "4.17.21")]
    [InlineData("4.17.20", new[] { "4.17.19" }, null)]
    [InlineData("1.0.0", new string[0], null)]
    public void The_fix_is_the_first_fixed_version_after_the_current_one(string current, string[] fixedVersions, string? fix)
    {
        Assert.Equal(fix, FindingRules.FirstFixAfter(current, fixedVersions));
    }
}
