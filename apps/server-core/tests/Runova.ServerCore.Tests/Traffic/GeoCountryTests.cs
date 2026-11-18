using System.Net;
using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Traffic;

namespace Runova.ServerCore.Tests.Traffic;

/// <summary>
/// E109 T3 and AC4: a visitor's country from Cloudflare's CF-IPCountry header, trusted only when the
/// request really came from Cloudflare's networks or the tunnel's listener on loopback; otherwise
/// from DB-IP's country file, read through MaxMind's reader with an LRU in front. The file is
/// downloaded once a month, swapped in whole, and the month before is used until the new one is out.
/// </summary>
public sealed class GeoCountryTests : IDisposable
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private readonly string _folder = TestFolders.Create("geo");

    public GeoCountryTests() => Directory.CreateDirectory(_folder);

    public void Dispose() => TestFolders.Delete(_folder);

    private static string Line(string address, string connecting, string country, string city = "-", string region = "-") =>
        $"{address} - - [18/Nov/2026:10:15:32 +0000] \"GET / HTTP/1.1\" 200 10 \"-\" \"Firefox\" \"a.test\" 0.001 \"text/html\" https {connecting} \"{country}\" \"{city}\" \"{region}\"";

    private GeoCountry WithDatabase()
    {
        var path = Path.Combine(_folder, "countries.mmdb");
        File.WriteAllBytes(path, TestMmdb.Sample());
        var geo = new GeoCountry();
        geo.UseDatabase(MmdbCountryDatabase.Open(path));
        return geo;
    }

    private static GeoResult Locate(GeoCountry geo, string text)
    {
        Assert.True(AccessLogParser.TryParse(Encoding.UTF8.GetBytes(text), out var line));
        Assert.True(IpKey.TryParse(line.RemoteAddress, out var visitor));
        return geo.Locate(line, visitor);
    }

    [Theory]
    [InlineData("81.2.69.160", "GB")]
    [InlineData("89.160.20.1", "SE")]
    [InlineData("2001:db8:1::5", "JP")]
    [InlineData("::ffff:81.2.69.7", "GB")]
    public void The_country_file_places_an_address(string address, string country)
    {
        using var database = MmdbCountryDatabase.Open(WriteSample());

        Assert.True(IpKey.TryParse(Encoding.ASCII.GetBytes(address), out var key));
        Assert.Equal(country, database.Country(key));
    }

    [Fact]
    public void An_address_the_file_does_not_have_has_no_country()
    {
        using var database = MmdbCountryDatabase.Open(WriteSample());

        Assert.True(IpKey.TryParse("192.0.2.1"u8, out var key));
        Assert.Null(database.Country(key));
        Assert.True(IpKey.TryParse("2001:db8:2::1"u8, out var v6));
        Assert.Null(database.Country(v6));
    }

    [Fact]
    public void Cloudflares_header_counts_when_the_request_came_from_cloudflare()
    {
        var geo = WithDatabase();

        var result = Locate(geo, Line("81.2.69.160", "172.70.1.2", "DE", "Berlin", "Land Berlin"));

        Assert.Equal(new GeoResult("DE", CountrySource.Cloudflare, "Berlin", "Land Berlin"), result);
    }

    [Fact]
    public void Through_the_tunnel_the_header_counts_too()
    {
        var geo = WithDatabase();

        Assert.Equal(CountrySource.Cloudflare, Locate(geo, Line("81.2.69.160", "127.0.0.1", "FR")).Source);
        Assert.Equal(CountrySource.Cloudflare, Locate(geo, Line("81.2.69.160", "::1", "FR")).Source);
    }

    [Fact]
    public void A_header_sent_straight_to_the_server_is_ignored_and_db_ip_places_the_visitor()
    {
        var geo = WithDatabase();

        var result = Locate(geo, Line("81.2.69.160", "81.2.69.160", "US", "Faketown"));

        Assert.Equal(new GeoResult("GB", CountrySource.DbIp, null, null), result);
    }

    [Fact]
    public void Unknown_and_tor_keep_cloudflares_codes()
    {
        var geo = WithDatabase();

        Assert.Equal(new GeoResult("T1", CountrySource.Cloudflare, null, null), Locate(geo, Line("192.0.2.1", "172.70.1.2", "T1")));
        // XX is Cloudflare not knowing: DB-IP gets a try, and failing that the visitor is unknown.
        Assert.Equal(new GeoResult("GB", CountrySource.DbIp, null, null), Locate(geo, Line("81.2.69.160", "172.70.1.2", "XX")));
        Assert.Equal(new GeoResult(GeoCountry.Unknown, CountrySource.None, null, null), Locate(geo, Line("192.0.2.1", "172.70.1.2", "XX")));
    }

    [Fact]
    public void Without_the_file_a_visitor_away_from_cloudflare_is_unknown()
    {
        var geo = new GeoCountry();

        Assert.Equal(new GeoResult(GeoCountry.Unknown, CountrySource.None, null, null), Locate(geo, Line("81.2.69.160", "81.2.69.160", "-")));
        Assert.False(geo.Ready);
    }

    [Fact]
    public void Cloudflares_networks_can_be_replaced_with_the_ones_the_core_fetched()
    {
        var geo = WithDatabase();
        geo.TrustCloudflare(["198.51.100.0/24"]);

        Assert.Equal(CountrySource.Cloudflare, Locate(geo, Line("81.2.69.160", "198.51.100.9", "DE")).Source);
        Assert.Equal(CountrySource.DbIp, Locate(geo, Line("81.2.69.160", "172.70.1.2", "DE")).Source);
        Assert.Contains("173.245.48.0/20", GeoCountry.CloudflareDefaults);
    }

    [Theory]
    [InlineData("10.1.2.3", true)]
    [InlineData("172.16.0.1", true)]
    [InlineData("192.168.1.1", true)]
    [InlineData("127.0.0.1", true)]
    [InlineData("169.254.169.254", true)]
    [InlineData("100.64.0.1", true)]
    [InlineData("::1", true)]
    [InlineData("fe80::1", true)]
    [InlineData("fd00::1", true)]
    [InlineData("::ffff:10.0.0.1", true)]
    [InlineData("203.0.113.7", false)]
    [InlineData("2001:db8::1", false)]
    public void Private_loopback_and_link_local_addresses_are_known(string address, bool local)
    {
        Assert.True(IpKey.TryParse(Encoding.ASCII.GetBytes(address), out var key));

        Assert.Equal(local, key.IsLocal);
    }

    [Theory]
    [InlineData("203.0.113.7", "203.0.113.0/24", true)]
    [InlineData("203.0.114.7", "203.0.113.0/24", false)]
    [InlineData("2001:db8::1", "2001:db8::/32", true)]
    [InlineData("2001:db9::1", "2001:db8::/32", false)]
    [InlineData("203.0.113.7", "203.0.113.7", true)]
    [InlineData("203.0.113.7", "2001:db8::/32", false)]
    [InlineData("203.0.113.7", "0.0.0.0/0", true)]
    public void A_network_holds_its_addresses(string address, string network, bool inside)
    {
        Assert.True(IpKey.TryParse(Encoding.ASCII.GetBytes(address), out var key));
        Assert.True(IpNetwork.TryParse(network, out var parsed));

        Assert.Equal(inside, parsed.Contains(key));
        Assert.Equal(address, key.ToString());
    }

    [Theory]
    [InlineData("")]
    [InlineData("1.2.3")]
    [InlineData("1.2.3.256")]
    [InlineData("01.2.3.4")]
    [InlineData("example.com")]
    [InlineData("fe80::1%eth0")]
    public void Something_that_is_not_an_address_is_refused(string text)
    {
        Assert.False(IpKey.TryParse(Encoding.ASCII.GetBytes(text), out _));
    }

    [Fact]
    public async Task The_monthly_file_is_downloaded_checked_and_swapped_in()
    {
        var http = new FakeGeoHttp { ["2026-11"] = TestMmdb.Gzip(TestMmdb.Sample()) };
        var geo = new GeoCountry();
        var updater = Updater(http, geo, new DateTimeOffset(2026, 11, 18, 12, 0, 0, TimeSpan.Zero));

        var state = await updater.UpdateAsync(Cancel);

        Assert.True(state.Ready);
        Assert.Null(state.Problem);
        Assert.Equal(["https://download.db-ip.com/free/dbip-country-lite-2026-11.mmdb.gz"], http.Asked);
        Assert.True(geo.Ready);
        Assert.True(File.Exists(Path.Combine(_folder, GeoDatabaseUpdater.FileName)));
        Assert.Equal("2026-11", updater.Month);
    }

    [Fact]
    public async Task Before_the_new_month_is_out_the_one_before_is_used()
    {
        var http = new FakeGeoHttp { ["2026-10"] = TestMmdb.Gzip(TestMmdb.Sample()) };
        var updater = Updater(http, new GeoCountry(), new DateTimeOffset(2026, 11, 1, 0, 30, 0, TimeSpan.Zero));

        var state = await updater.UpdateAsync(Cancel);

        Assert.True(state.Ready);
        Assert.Equal("2026-10", updater.Month);
        Assert.Equal(2, http.Asked.Count);
    }

    [Fact]
    public async Task A_file_for_the_month_is_not_fetched_again_and_is_loaded_on_start()
    {
        var http = new FakeGeoHttp { ["2026-11"] = TestMmdb.Gzip(TestMmdb.Sample()) };
        var at = new DateTimeOffset(2026, 11, 18, 12, 0, 0, TimeSpan.Zero);
        await Updater(http, new GeoCountry(), at).UpdateAsync(Cancel);
        var geo = new GeoCountry();
        var restarted = Updater(http, geo, at);

        restarted.LoadExisting();
        var state = await restarted.UpdateAsync(Cancel);

        Assert.True(geo.Ready);
        Assert.True(state.Ready);
        Assert.Single(http.Asked);
    }

    [Fact]
    public async Task A_download_that_is_not_a_country_file_changes_nothing_and_says_why()
    {
        var http = new FakeGeoHttp { ["2026-10"] = TestMmdb.Gzip(TestMmdb.Sample()) };
        var geo = new GeoCountry();
        await Updater(http, geo, new DateTimeOffset(2026, 10, 18, 12, 0, 0, TimeSpan.Zero)).UpdateAsync(Cancel);
        http["2026-11"] = TestMmdb.Gzip("this is not a database"u8.ToArray());
        var updater = Updater(http, geo, new DateTimeOffset(2026, 11, 18, 12, 0, 0, TimeSpan.Zero));
        updater.LoadExisting();

        var state = await updater.UpdateAsync(Cancel);

        Assert.True(state.Ready);
        Assert.NotNull(state.Problem);
        Assert.Equal("2026-10", updater.Month);
        Assert.True(IpKey.TryParse("81.2.69.1"u8, out var key));
        Assert.Equal("GB", geo.Database!.Country(key));
    }

    [Fact]
    public async Task Without_any_file_the_problem_is_said_in_words()
    {
        var updater = Updater(new FakeGeoHttp(), new GeoCountry(), new DateTimeOffset(2026, 11, 18, 12, 0, 0, TimeSpan.Zero));

        var state = await updater.UpdateAsync(Cancel);

        Assert.False(state.Ready);
        Assert.Contains("DB-IP", state.Problem, StringComparison.Ordinal);
    }

    private GeoDatabaseUpdater Updater(FakeGeoHttp http, GeoCountry geo, DateTimeOffset now) =>
        new(http, _folder, geo, new FakeTimeProvider(now), NullLogger<GeoDatabaseUpdater>.Instance);

    private string WriteSample()
    {
        var path = Path.Combine(_folder, Guid.NewGuid().ToString("N") + ".mmdb");
        File.WriteAllBytes(path, TestMmdb.Sample());
        return path;
    }
}

/// <summary>DB-IP's download site, with a file per month; anything else is 404.</summary>
internal sealed class FakeGeoHttp : HttpMessageHandler
{
    private readonly Dictionary<string, byte[]> _months = new(StringComparer.Ordinal);

    public List<string> Asked { get; } = [];

    public byte[] this[string month]
    {
        get => _months[month];
        set => _months[month] = value;
    }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var url = request.RequestUri!.ToString();
        Asked.Add(url);
        var month = url.Replace("https://download.db-ip.com/free/dbip-country-lite-", string.Empty, StringComparison.Ordinal).Replace(".mmdb.gz", string.Empty, StringComparison.Ordinal);
        return Task.FromResult(_months.TryGetValue(month, out var bytes)
            ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) }
            : new HttpResponseMessage(HttpStatusCode.NotFound));
    }
}
