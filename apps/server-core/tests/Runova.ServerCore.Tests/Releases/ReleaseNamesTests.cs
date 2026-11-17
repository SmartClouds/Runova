using Runova.ServerCore.Data;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Releases;

namespace Runova.ServerCore.Tests.Releases;

/// <summary>What a GitHub Release image request may hold and where a download may go (E105).</summary>
public sealed class ReleaseNamesTests
{
    [Theory]
    [InlineData("acme/shop", true)]
    [InlineData("Acme-Corp/my.site_2", true)]
    [InlineData("acme", false)]
    [InlineData("acme/shop/extra", false)]
    [InlineData("-acme/shop", false)]
    [InlineData("acme/..", false)]
    [InlineData("acme/shop ", false)]
    [InlineData(null, false)]
    public void Repositories_are_owner_and_name_as_github_allows_them(string? repository, bool valid) =>
        Assert.Equal(valid, ReleaseNames.IsRepository(repository));

    [Theory]
    [InlineData("https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sig=x", true)]
    [InlineData("https://objects.githubusercontent.com/github-production-release-asset-2e65be/1/2", true)]
    [InlineData("https://github-production-release-asset-2e65be.s3.amazonaws.com/1/2", true)]
    [InlineData("http://release-assets.githubusercontent.com/x", false)]
    [InlineData("https://release-assets.githubusercontent.com:8443/x", false)]
    [InlineData("https://user:pass@release-assets.githubusercontent.com/x", false)]
    [InlineData("https://release-assets.githubusercontent.com.evil.example.com/x", false)]
    [InlineData("https://evil-release-asset-1.s3.amazonaws.com/x", false)]
    [InlineData("https://api.github.com/repos/acme/shop/releases/assets/1", false)]
    public void Downloads_only_go_to_githubs_release_asset_hosts_over_https(string link, bool allowed) =>
        Assert.Equal(allowed, ReleaseNames.IsAssetHost(new Uri(link)));

    [Theory]
    [InlineData("acme/shop:1.4.0", "docker.io/acme/shop:1.4.0", true)]
    [InlineData("nginx", "docker.io/library/nginx:latest", true)]
    [InlineData("ghcr.io/acme/shop:1.4.0", "ghcr.io/acme/shop:1.4.0", true)]
    [InlineData("localhost:5000/shop", "localhost:5000/shop:latest", true)]
    [InlineData("acme/shop:1.4.0", "acme/shop:1.4.1", false)]
    [InlineData("ghcr.io/acme/shop:1.4.0", "acme/shop:1.4.0", false)]
    public void Image_names_match_as_docker_load_and_compose_write_them(string left, string right, bool same) =>
        Assert.Equal(same, ReleaseNames.SameImage(left, right));

    [Theory]
    [InlineData("github_pat_11ABC_def", true)]
    [InlineData("ghp_abcdef0123", true)]
    [InlineData("has space", false)]
    [InlineData("line\nbreak", false)]
    [InlineData("", false)]
    public void Tokens_are_one_printable_word(string token, bool valid) =>
        Assert.Equal(valid, ReleaseNames.IsToken(token));

    [Fact]
    public void Docker_load_names_come_from_its_loaded_image_lines()
    {
        Assert.Equal(
            ["acme/shop:1.4.0", "postgres:17"],
            DockerMapping.LoadedImages("Loaded image: acme/shop:1.4.0\nLoaded image ID: sha256:abc\n Loaded image: postgres:17 \n"));
        Assert.Empty(DockerMapping.LoadedImages(null));
    }

    [Fact]
    public void A_stored_token_maps_to_what_the_app_sees_without_the_token()
    {
        var id = Guid.NewGuid();
        var row = new ReleaseTokenRecord { Id = id, Repository = "acme/shop", SealedToken = "sealed", CreatedAt = 1, UpdatedAt = 2, CreatedBy = "maria", LastUsedAt = 3 };

        var info = ReleaseTokenMapper.ToInfo(row);

        Assert.Equal(new Contracts.ReleaseTokenInfo(id, "acme/shop", 1, 2, "maria", 3), info);
    }
}
