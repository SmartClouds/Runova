using System.Net;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Options;
using Runova.Website.Api.Dependencies;

namespace Runova.Website.IntegrationTests.Dependencies;

/// <summary>
/// What each registry's real answer means. Inventories come from clients, so these also pin that a
/// package name can never point a request somewhere other than the registry.
/// </summary>
public sealed class RegistryClientsTests
{
    private sealed class Stub(Func<Uri, HttpResponseMessage> answer) : HttpMessageHandler
    {
        public List<Uri> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(request.RequestUri!);
            return Task.FromResult(answer(request.RequestUri!));
        }
    }

    private static HttpResponseMessage Text(string body) => new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8) };

    private static HttpResponseMessage Status(HttpStatusCode code) => new(code);

    private static (HttpClient Http, Stub Stub) Client(string baseAddress, Func<Uri, HttpResponseMessage> answer)
    {
        var stub = new Stub(answer);
        return (new HttpClient(stub) { BaseAddress = new Uri(baseAddress) }, stub);
    }

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    [Fact]
    public async Task PyPI_gives_the_version_it_marks_as_current()
    {
        var (http, stub) = Client("https://pypi.org/", _ => Text("""{"info":{"version":"5.1.0"}}"""));

        var facts = await new PyPiRegistryClient(http).GetAsync("foo-bar", Cancel);

        Assert.Equal("5.1.0", facts!.LatestVersion);
        Assert.Equal("https://pypi.org/pypi/foo-bar/json", Assert.Single(stub.Requests).AbsoluteUri);
    }

    [Fact]
    public async Task PyPI_does_not_offer_the_prerelease_of_a_project_with_nothing_else()
    {
        var (http, _) = Client("https://pypi.org/", _ => Text("""{"info":{"version":"2.0.0rc1"}}"""));

        Assert.Null((await new PyPiRegistryClient(http).GetAsync("a", Cancel))!.LatestVersion);
    }

    [Fact]
    public async Task A_package_a_registry_does_not_have_is_null()
    {
        var (http, _) = Client("https://pypi.org/", _ => Status(HttpStatusCode.NotFound));

        Assert.Null(await new PyPiRegistryClient(http).GetAsync("nope", Cancel));
    }

    [Fact]
    public async Task A_registry_that_fails_says_so_instead_of_saying_there_is_no_package()
    {
        var (http, _) = Client("https://index.crates.io/", _ => Status(HttpStatusCode.BadGateway));

        await Assert.ThrowsAsync<RegistryException>(() => new CratesRegistryClient(http).GetAsync("serde", Cancel));
    }

    [Theory]
    [InlineData("a", "1/a")]
    [InlineData("ab", "2/ab")]
    [InlineData("abc", "3/a/abc")]
    [InlineData("Serde", "se/rd/serde")]
    public async Task A_crate_is_found_at_its_place_in_the_index(string name, string path)
    {
        var (http, stub) = Client("https://index.crates.io/", _ => Text("""{"vers":"1.0.0","yanked":false}"""));

        await new CratesRegistryClient(http).GetAsync(name, Cancel);

        Assert.Equal($"https://index.crates.io/{path}", Assert.Single(stub.Requests).AbsoluteUri);
    }

    [Fact]
    public async Task The_newest_crate_release_skips_yanked_and_prerelease_versions()
    {
        var body = string.Join('\n', """{"vers":"1.0.1","yanked":false}""", """{"vers":"1.0.9","yanked":true}""", """{"vers":"2.0.0-alpha.1","yanked":false}""");
        var (http, _) = Client("https://index.crates.io/", _ => Text(body));

        Assert.Equal("1.0.1", (await new CratesRegistryClient(http).GetAsync("serde", Cancel))!.LatestVersion);
    }

    [Theory]
    [InlineData("../evil")]
    [InlineData("a/b")]
    public async Task A_crate_name_that_is_not_one_is_not_asked_about(string name)
    {
        var (http, stub) = Client("https://index.crates.io/", _ => Text(""));

        Assert.Null(await new CratesRegistryClient(http).GetAsync(name, Cancel));
        Assert.Empty(stub.Requests);
    }

    private static MavenRegistryClient Maven(HttpClient http) => new(http, Options.Create(new PackageRegistryOptions()));

    private const string MavenMetadata = "<metadata><versioning><versions><version>32.0.0-jre</version><version>33.1.0-android</version><version>34.0.0-rc1</version></versions></versioning></metadata>";

    [Fact]
    public async Task Maven_goes_to_Central_for_most_groups_and_drops_the_flavor()
    {
        var stub = new Stub(_ => Text(MavenMetadata));

        var facts = await Maven(new HttpClient(stub)).GetAsync("com.google.guava:guava", Cancel);

        Assert.Equal("33.1.0", facts!.LatestVersion);
        Assert.Equal("https://repo1.maven.org/maven2/com/google/guava/guava/maven-metadata.xml", Assert.Single(stub.Requests).AbsoluteUri);
    }

    [Fact]
    public async Task Maven_goes_to_Google_first_for_androidx_and_falls_back()
    {
        var stub = new Stub(uri => uri.Host == "dl.google.com" ? Status(HttpStatusCode.NotFound) : Text(MavenMetadata));

        var facts = await Maven(new HttpClient(stub)).GetAsync("androidx.fork:thing", Cancel);

        Assert.Equal("33.1.0", facts!.LatestVersion);
        Assert.Equal(["dl.google.com", "repo1.maven.org"], stub.Requests.Select(r => r.Host));
    }

    [Theory]
    [InlineData("no-colon")]
    [InlineData("a:b:c")]
    [InlineData("..:evil")]
    [InlineData("a:../../evil")]
    public async Task A_Maven_name_that_is_not_one_is_not_asked_about(string name)
    {
        var stub = new Stub(_ => Text(MavenMetadata));

        Assert.Null(await Maven(new HttpClient(stub)).GetAsync(name, Cancel));
        Assert.Empty(stub.Requests);
    }

    private static string Refs(params string[] tags)
    {
        static string Line(string text) => $"{text.Length + 4:x4}{text}";
        var sha = new string('a', 40);
        return Line("# service=git-upload-pack\n") + "0000" + Line($"{sha} refs/heads/main\n")
            + string.Concat(tags.Select(tag => Line($"{sha} refs/tags/{tag}\n") + Line($"{sha} refs/tags/{tag}^{{}}\n"))) + "0000";
    }

    [Fact]
    public async Task A_Swift_package_gets_the_newest_semver_tag_of_its_GitHub_repository()
    {
        var (http, stub) = Client("https://github.com/", _ => Text(Refs("5.8.0", "v5.10.0", "6.0.0-beta.1", "not-a-version")));

        var facts = await new SwiftRegistryClient(http).GetAsync("github.com/Alamofire/Alamofire", Cancel);

        Assert.Equal("5.10.0", facts!.LatestVersion);
        Assert.Equal("https://github.com/Alamofire/Alamofire.git/info/refs?service=git-upload-pack", Assert.Single(stub.Requests).AbsoluteUri);
    }

    [Theory]
    [InlineData("169.254.169.254/latest/meta-data")]
    [InlineData("localhost/admin/secrets")]
    [InlineData("internal.example/a/b")]
    [InlineData("github.com.evil.example/a/b")]
    [InlineData("github.com/../../etc")]
    [InlineData("github.com/a/..")]
    [InlineData("github.com/a")]
    [InlineData("github.com/a/b/c")]
    public async Task A_Swift_package_never_sends_the_server_anywhere_but_GitHub(string name)
    {
        var (http, stub) = Client("https://github.com/", _ => Text(Refs("1.0.0")));

        Assert.Null(await new SwiftRegistryClient(http).GetAsync(name, Cancel));
        Assert.Empty(stub.Requests);
    }

    [Theory]
    [InlineData(HttpStatusCode.NotFound)]
    [InlineData(HttpStatusCode.Unauthorized)]
    public async Task A_private_or_missing_repository_is_a_package_with_no_public_answer(HttpStatusCode code)
    {
        var (http, _) = Client("https://github.com/", _ => Status(code));

        Assert.Null(await new SwiftRegistryClient(http).GetAsync("github.com/a/b", Cancel));
    }

    [Fact]
    public async Task A_pod_is_read_from_the_shard_its_name_hashes_to()
    {
#pragma warning disable CA5351 // The CDN's own file layout, not a security use.
        var hash = Convert.ToHexStringLower(MD5.HashData(Encoding.UTF8.GetBytes("Alamofire")));
#pragma warning restore CA5351
        var (http, stub) = Client("https://cdn.cocoapods.org/", _ => Text("AlamoOther/9.0.0\nAlamofire/5.6.4/5.9.1/6.0.0-beta.1\n"));

        var facts = await new CocoaPodsRegistryClient(http).GetAsync("Alamofire", Cancel);

        Assert.Equal("5.9.1", facts!.LatestVersion);
        Assert.Equal($"https://cdn.cocoapods.org/all_pods_versions_{hash[0]}_{hash[1]}_{hash[2]}.txt", Assert.Single(stub.Requests).AbsoluteUri);
    }

    [Fact]
    public async Task A_pod_missing_from_its_shard_is_null()
    {
        var (http, _) = Client("https://cdn.cocoapods.org/", _ => Text("Other/1.0.0\n"));

        Assert.Null(await new CocoaPodsRegistryClient(http).GetAsync("Alamofire", Cancel));
    }
}
