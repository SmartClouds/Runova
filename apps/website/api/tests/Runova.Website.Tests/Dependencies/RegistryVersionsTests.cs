using Runova.Website.Core.Dependencies;

namespace Runova.Website.Tests.Dependencies;

public class RegistryVersionsTests
{
    [Theory]
    [InlineData("1.0.0-alpha01")]
    [InlineData("2.0.0rc1")]
    [InlineData("2.0.0b3")]
    [InlineData("3.0.0-M1")]
    [InlineData("3.0.0-SNAPSHOT")]
    public void A_prerelease_is_recognized_in_every_registry_s_spelling(string version) =>
        Assert.True(RegistryVersions.IsPrerelease(version));

    [Theory]
    [InlineData("1.0.0")]
    [InlineData("33.0.0-jre")]
    [InlineData("33.0.0-android")]
    [InlineData("4.1.100.Final")]
    public void A_release_with_a_flavor_is_still_a_release(string version) =>
        Assert.False(RegistryVersions.IsPrerelease(version));

    [Fact]
    public void The_newest_release_is_picked_by_number_and_without_its_flavor()
    {
        Assert.Equal("33.1.0", RegistryVersions.NewestRelease(["32.0.0-jre", "33.1.0-android", "33.0.0-jre", "34.0.0-rc1"]));
        Assert.Equal("1.10.0", RegistryVersions.NewestRelease(["1.9.0", "1.10.0", "v1.2.0"]));
        Assert.Equal("4.1.100", RegistryVersions.NewestRelease(["4.1.100.Final", "4.1.99.Final"]));
    }

    [Fact]
    public void A_version_keeps_the_way_it_was_written() =>
        Assert.Equal("2026.09.00", RegistryVersions.NewestRelease(["2026.08.00", "2026.09.00"]));

    [Fact]
    public void Nothing_is_picked_when_there_is_no_release()
    {
        Assert.Null(RegistryVersions.NewestRelease(["1.0.0-beta1", "not a version"]));
        Assert.Null(RegistryVersions.NewestRelease([]));
    }

    [Theory]
    [InlineData("pypi", "Foo_Bar.baz", "foo-bar-baz")]
    [InlineData("nuget", "Serilog", "serilog")]
    [InlineData("npm", "Left_Pad", "Left_Pad")]
    [InlineData("crates", "serde_json", "serde_json")]
    [InlineData("maven", "a.B:c", "a.B:c")]
    public void A_package_is_looked_up_by_the_name_its_registry_goes_by(string ecosystem, string name, string key) =>
        Assert.Equal(key, Ecosystems.PackageKey(ecosystem, name));

    [Theory]
    [InlineData("pypi", "PyPI")]
    [InlineData("crates", "crates.io")]
    [InlineData("maven", "Maven")]
    [InlineData("swift", "SwiftURL")]
    public void Each_ecosystem_with_advisories_has_its_OSV_name(string ecosystem, string osv)
    {
        Assert.True(Ecosystems.HasAdvisories(ecosystem));
        Assert.Equal(osv, Ecosystems.OsvName(ecosystem));
    }

    [Fact]
    public void OSV_has_no_database_for_CocoaPods() => Assert.False(Ecosystems.HasAdvisories(Ecosystems.CocoaPods));

    [Fact]
    public void Every_code_fits_the_column() => Assert.All(Ecosystems.All, code => Assert.InRange(code.Length, 1, 8));
}
