using Runova.Website.Api.Dependencies;
using Runova.Website.Core.Dependencies;
using Runova.Website.Data.Dependencies;

namespace Runova.Website.Tests.Mapping;

public class DependencyMapperTests
{
    private static readonly DateTimeOffset _at = new(2026, 10, 1, 8, 0, 0, TimeSpan.Zero);

    private static readonly DependencyFinding _finding = new()
    {
        Id = 1,
        InventoryId = 2,
        Ecosystem = "npm",
        Name = "left-pad",
        Kind = FindingKinds.Security,
        CurrentVersion = "1.0.0",
        TargetVersion = "1.3.0",
        AdvisoryId = "GHSA-1",
        Severity = "high",
        Summary = "Pads too far",
        Key = "2|npm|left-pad",
        FirstSeenAt = _at,
    };

    private static readonly PackageInventory _inventory = new()
    {
        Id = 2,
        ScopeId = 5,
        ItemId = "proj-1",
        ProjectName = "Shop",
        UploadedBy = 3,
        UploadedAt = _at,
        ContentHash = "abc",
        LastCheckedAt = _at.AddHours(1),
    };

    [Fact]
    public void Alert_settings_map_to_the_dto_and_to_the_preferences()
    {
        var settings = new DependencyAlertSettings
        {
            UserId = 3,
            Enabled = true,
            SecurityMinSeverity = "medium",
            Deprecated = false,
            Major = true,
            Minor = true,
            Patch = false,
            InApp = false,
            Telegram = true,
        };

        Assert.Equal(new DependencyAlertSettingsDto(true, "medium", false, true, true, false, false, true), DependencyMapper.ToDto(settings));
        Assert.Equal(new AlertPreferences(true, "medium", false, true, true, false), DependencyMapper.ToPreferences(settings));
    }

    [Fact]
    public void A_finding_maps_to_the_dto_and_to_the_rules_finding()
    {
        Assert.Equal(
            new FindingDto("npm", "left-pad", "security", "1.0.0", "1.3.0", "GHSA-1", "high", "Pads too far", _at),
            DependencyMapper.ToDto(_finding));
        Assert.Equal(
            new Finding("npm", "left-pad", "security", "1.0.0", "1.3.0", "GHSA-1", "high", "Pads too far"),
            DependencyMapper.ToFinding(_finding));
    }

    [Fact]
    public void An_inventory_takes_its_counts_and_findings_from_the_caller()
    {
        var counts = new FindingCountsDto(1, 0, 0, 0, 0);
        var findings = new[] { DependencyMapper.ToDto(_finding) };

        Assert.Equal(new PackageInventoryDto(2, 5, "proj-1", "Shop", 40, _at, _at.AddHours(1)), DependencyMapper.ToDto(_inventory, 40));
        Assert.Equal(
            new ProjectFindingsDto(2, 5, "proj-1", "Shop", false, _at.AddHours(1), 1, "high", counts, findings),
            DependencyMapper.ToDto(_inventory, false, 1, "high", counts, findings));
    }

    [Fact]
    public void A_package_from_a_request_is_trimmed_and_feeds_the_checks()
    {
        var package = DependencyMapper.ToPackage(new InventoryPackageRequest("npm", " left-pad ", " 1.0.0 ", true));

        Assert.Equal((0L, 0L, "npm", "left-pad", "1.0.0", true), (package.Id, package.InventoryId, package.Ecosystem, package.Name, package.Version, package.Dev));
        Assert.Equal(new InventoryItem("npm", "left-pad", "1.0.0", true), DependencyMapper.ToItem(package));
    }

    [Fact]
    public void Registry_facts_and_advisories_map_to_what_the_rules_read()
    {
        var facts = new PackageFacts { Ecosystem = "npm", Name = "left-pad", Found = true, LatestVersion = "1.3.0", Deprecated = "Use padStart", CheckedAt = _at };
        var advisory = new OsvClient.Advisory("GHSA-1", "high", "Pads too far", [("npm", "left-pad", "1.3.0")]);

        var stored = DependencyMapper.ToStored(advisory, "1.3.0");

        Assert.Equal(new PackageFactsView("1.3.0", "Use padStart"), DependencyMapper.ToView(facts));
        Assert.Equal(new DependencyCheckJob.StoredAdvisory("GHSA-1", "high", "Pads too far", "1.3.0"), stored);
        Assert.Equal(new AdvisoryView("GHSA-1", "high", "Pads too far", "1.3.0"), DependencyMapper.ToView(stored));
    }

    [Fact]
    public void The_dtos_carry_no_secret()
    {
        Assert.Empty(SecretProperties.In(typeof(DependencyAlertSettingsDto)));
        Assert.Empty(SecretProperties.In(typeof(FindingDto)));
        Assert.Empty(SecretProperties.In(typeof(PackageInventoryDto)));
        Assert.Empty(SecretProperties.In(typeof(ProjectFindingsDto)));
    }
}
