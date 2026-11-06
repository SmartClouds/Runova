using Runova.Website.Core.Dependencies;

namespace Runova.Website.Tests.Dependencies;

public sealed class PackageVersionTests
{
    [Theory]
    [InlineData("1.2.3", 1, 2, 3, 0, "")]
    [InlineData("v1.2.3", 1, 2, 3, 0, "")]
    [InlineData("^4.17.20", 4, 17, 20, 0, "")]
    [InlineData("~0.3", 0, 3, 0, 0, "")]
    [InlineData(">=2.0.0 <3", 2, 0, 0, 0, "")]
    [InlineData("13.0.3.1", 13, 0, 3, 1, "")]
    [InlineData("8.0.0-preview.7", 8, 0, 0, 0, "preview.7")]
    [InlineData("1.0.0+build.5", 1, 0, 0, 0, "")]
    [InlineData("=5", 5, 0, 0, 0, "")]
    public void Reads_the_version_a_manifest_or_registry_gives(string text, int major, int minor, int patch, int revision, string prerelease)
    {
        Assert.True(PackageVersion.TryParse(text, out var version));
        Assert.Equal((major, minor, patch, revision, prerelease), (version.Major, version.Minor, version.Patch, version.Revision, version.Prerelease));
    }

    [Theory]
    [InlineData("")]
    [InlineData("*")]
    [InlineData("latest")]
    [InlineData("workspace:*")]
    [InlineData("github:user/repo")]
    [InlineData("file:../lib")]
    public void Refuses_what_is_not_a_version(string text)
    {
        Assert.False(PackageVersion.TryParse(text, out _));
    }

    [Theory]
    [InlineData("1.0.0", "1.0.1")]
    [InlineData("1.9.9", "1.10.0")]
    [InlineData("1.0.0-alpha", "1.0.0")]
    [InlineData("1.0.0-alpha", "1.0.0-alpha.1")]
    [InlineData("1.0.0-alpha.2", "1.0.0-alpha.10")]
    [InlineData("1.0.0-alpha.10", "1.0.0-beta")]
    [InlineData("1.0.0", "1.0.0.1")]
    public void Orders_versions_as_semver_does(string lower, string higher)
    {
        Assert.True(PackageVersion.Parse(lower) < PackageVersion.Parse(higher));
        Assert.True(PackageVersion.Parse(higher) > PackageVersion.Parse(lower));
    }

    [Fact]
    public void The_same_version_written_two_ways_is_equal()
    {
        Assert.Equal(0, PackageVersion.Parse("1.2").CompareTo(PackageVersion.Parse("1.2.0+meta")));
    }

    [Theory]
    [InlineData("1.2.3", "2.0.0", "major")]
    [InlineData("1.2.3", "1.3.0", "minor")]
    [InlineData("1.2.3", "1.2.4", "patch")]
    [InlineData("13.0.1", "13.0.1.2", "patch")]
    [InlineData("1.2.3-rc.1", "1.2.3", "patch")]
    public void Names_the_kind_of_bump(string current, string latest, string kind)
    {
        Assert.Equal(kind, PackageVersion.BumpKind(PackageVersion.Parse(current), PackageVersion.Parse(latest)));
    }

    [Theory]
    [InlineData("2.0.0", "2.0.0")]
    [InlineData("2.0.0", "1.9.0")]
    public void No_bump_when_the_latest_is_not_newer(string current, string latest)
    {
        Assert.Null(PackageVersion.BumpKind(PackageVersion.Parse(current), PackageVersion.Parse(latest)));
    }
}
