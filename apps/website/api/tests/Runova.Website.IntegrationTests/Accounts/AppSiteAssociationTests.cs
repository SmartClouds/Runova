using System.Net;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Accounts;

/// <summary>
/// The files Android and iOS read before they let the phone app use the site's passkeys (E115):
/// Digital Asset Links and the Apple app site association.
/// </summary>
public sealed class AppSiteAssociationTests(PostgresFixture postgres)
{
    private const string Fingerprint = "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";

    private WebsiteApiFactory Configured() => new(postgres.ConnectionString, settings: new Dictionary<string, string>
    {
        ["Website:Passkeys:AndroidCertFingerprints"] = Fingerprint.ToLowerInvariant(),
        ["Website:Passkeys:AppleAppIds"] = "ABCDE12345.com.runovahq.app",
    });

    [Fact]
    public async Task Asset_links_let_the_android_app_use_the_site_s_sign_in_credentials()
    {
        using var factory = Configured();

        var response = await factory.CreateApiClient().GetAsync("/.well-known/assetlinks.json");

        var links = await ApiClient.ReadJsonAsync(response, HttpStatusCode.OK);
        Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);
        var link = Assert.Single(links.EnumerateArray());
        Assert.Equal(["delegate_permission/common.get_login_creds"], link.GetProperty("relation").EnumerateArray().Select(r => r.GetString()));
        var target = link.GetProperty("target");
        Assert.Equal("android_app", target.GetProperty("namespace").GetString());
        Assert.Equal("com.runovahq.app", target.GetProperty("package_name").GetString());
        Assert.Equal([Fingerprint], target.GetProperty("sha256_cert_fingerprints").EnumerateArray().Select(f => f.GetString()));
    }

    [Fact]
    public async Task The_apple_association_names_the_ios_app_for_web_credentials()
    {
        using var factory = Configured();

        var response = await factory.CreateApiClient().GetAsync("/.well-known/apple-app-site-association");

        var association = await ApiClient.ReadJsonAsync(response, HttpStatusCode.OK);
        Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal(["ABCDE12345.com.runovahq.app"], association.GetProperty("webcredentials").GetProperty("apps").EnumerateArray().Select(a => a.GetString()));
    }

    [Theory]
    [InlineData("/.well-known/assetlinks.json")]
    [InlineData("/.well-known/apple-app-site-association")]
    public async Task With_nothing_configured_there_is_no_file(string path)
    {
        using var factory = new WebsiteApiFactory(postgres.ConnectionString);

        var response = await factory.CreateApiClient().GetAsync(path);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }
}
