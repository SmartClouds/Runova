using Runova.Website.Core.Dependencies;

namespace Runova.Website.Tests.Dependencies;

public sealed class AlertPolicyTests
{
    private static Finding Security(string severity, string id = "GHSA-1") =>
        new(Ecosystems.Npm, "lodash", FindingKinds.Security, "4.17.20", "4.17.21", id, severity, "Prototype pollution");

    private static Finding Bump(string kind, string target = "5.0.0") =>
        new(Ecosystems.Npm, "lodash", kind, "4.17.20", target, null, null, null);

    private static readonly Finding _deprecated = new(Ecosystems.Npm, "request", FindingKinds.Deprecated, "2.88.2", null, null, null, "request is deprecated");

    [Fact]
    public void The_defaults_tell_high_security_deprecations_and_majors_only()
    {
        var defaults = AlertPreferences.Defaults;

        Assert.True(AlertPolicy.Wants(defaults, Security(Severities.Critical)));
        Assert.True(AlertPolicy.Wants(defaults, Security(Severities.High)));
        Assert.False(AlertPolicy.Wants(defaults, Security(Severities.Moderate)));
        Assert.True(AlertPolicy.Wants(defaults, _deprecated));
        Assert.True(AlertPolicy.Wants(defaults, Bump(FindingKinds.Major)));
        Assert.False(AlertPolicy.Wants(defaults, Bump(FindingKinds.Minor)));
        Assert.False(AlertPolicy.Wants(defaults, Bump(FindingKinds.Patch)));
    }

    [Theory]
    [InlineData(Severities.Low, Severities.Low, true)]
    [InlineData(Severities.Critical, Severities.High, false)]
    [InlineData(Severities.Critical, Severities.Critical, true)]
    [InlineData(Severities.Off, Severities.Critical, false)]
    public void The_security_threshold_decides_by_severity(string threshold, string severity, bool wanted)
    {
        var preferences = AlertPreferences.Defaults with { SecurityMinSeverity = threshold };

        Assert.Equal(wanted, AlertPolicy.Wants(preferences, Security(severity)));
    }

    [Fact]
    public void Turned_off_tells_nothing()
    {
        var off = AlertPreferences.Defaults with { Enabled = false };

        Assert.False(AlertPolicy.Wants(off, Security(Severities.Critical)));
        Assert.False(AlertPolicy.Wants(off, _deprecated));
    }

    [Fact]
    public void Each_kind_can_be_turned_on_or_off_alone()
    {
        var onlyPatches = new AlertPreferences(true, Severities.Off, Deprecated: false, Major: false, Minor: false, Patch: true);

        Assert.True(AlertPolicy.Wants(onlyPatches, Bump(FindingKinds.Patch)));
        Assert.False(AlertPolicy.Wants(onlyPatches, Bump(FindingKinds.Major)));
        Assert.False(AlertPolicy.Wants(onlyPatches, _deprecated));
    }

    [Fact]
    public void The_dedupe_key_changes_with_a_new_release_or_a_worse_severity_only()
    {
        Assert.Equal(AlertPolicy.DedupeKey(7, Bump(FindingKinds.Major)), AlertPolicy.DedupeKey(7, Bump(FindingKinds.Major)));
        Assert.NotEqual(AlertPolicy.DedupeKey(7, Bump(FindingKinds.Major, "5.0.0")), AlertPolicy.DedupeKey(7, Bump(FindingKinds.Major, "6.0.0")));
        Assert.NotEqual(AlertPolicy.DedupeKey(7, Security(Severities.Moderate)), AlertPolicy.DedupeKey(7, Security(Severities.Critical)));
        Assert.NotEqual(AlertPolicy.DedupeKey(7, _deprecated), AlertPolicy.DedupeKey(8, _deprecated));
    }

    [Fact]
    public void The_worst_severity_leads_a_group_of_findings()
    {
        Assert.Equal(Severities.Critical, AlertPolicy.WorstSeverity([Bump(FindingKinds.Patch), Security(Severities.High), Security(Severities.Critical, "GHSA-2")]));
        Assert.Null(AlertPolicy.WorstSeverity([Bump(FindingKinds.Patch)]));
    }
}
