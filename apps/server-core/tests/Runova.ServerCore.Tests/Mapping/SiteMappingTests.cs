using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Nginx;
using Runova.ServerCore.Web;

namespace Runova.ServerCore.Tests.Mapping;

/// <summary>The wire shapes of sites and stream proxies, the nginx model they become, and what the app reads back.</summary>
public sealed class SiteMappingTests
{
    [Fact]
    public void Every_site_setting_reaches_the_model()
    {
        var settings = new SiteSettings(
            "shop",
            ["shop.example.com"],
            new UpstreamTarget(UpstreamKind.Url, Address: "https://10.0.0.5:8443", VerifyCertificate: false, SendUpstreamHost: true),
            Websocket: true,
            Gzip: true,
            ProxyCache: new SiteProxyCache(60, 256, ["session"]),
            Http2: false,
            RedirectToHttps: false,
            Hsts: new SiteHsts(600, true, true),
            SecurityHeaders: new SiteSecurityHeaders(false, SiteFrameOptions.Deny, SiteReferrerPolicy.NoReferrer),
            ResponseHeaders: [new SiteHeader("X-Shop", "1")],
            IpRules: new SiteIpRules(["10.0.0.0/8"], ["10.0.0.1"]),
            BasicAuth: new SiteBasicAuth([new SiteBasicAuthUser("ann"), new SiteBasicAuthUser("ben")], "Shop"),
            RateLimit: new SiteRateLimit(10, SiteRatePeriod.Second, 5, false),
            ClientMaxBodySizeMegabytes: 20,
            Timeouts: new SiteTimeouts(1, 2, 3));
        var certificate = new NginxCertificate("/etc/cert.pem", "/etc/key.pem");

        var site = SiteMapping.ToModel(settings, new Dictionary<string, string> { ["ann"] = "$6$hash" }, "server;", "location;", certificate);

        Assert.Equal("shop", site.Id);
        Assert.Equal(["shop.example.com"], site.Domains);
        Assert.Equal(new NginxUrlUpstream("https://10.0.0.5:8443", false, true), site.Upstream);
        Assert.Same(certificate, site.Certificate);
        Assert.False(site.RedirectToHttps);
        Assert.False(site.Http2);
        Assert.False(site.OcspStapling);
        Assert.True(site.Websocket);
        Assert.Equal(60, site.ProxyCache!.TtlSeconds);
        Assert.Equal(256, site.ProxyCache.MaxSizeMegabytes);
        Assert.Equal(["session"], site.ProxyCache.BypassCookies);
        Assert.True(site.Gzip);
        Assert.Equal(new NginxSecurityHeaders(false, NginxFrameOptions.Deny, NginxReferrerPolicy.NoReferrer), site.SecurityHeaders);
        Assert.Equal(new NginxHsts(600, true, true), site.Hsts);
        Assert.Equal([new NginxHeader("X-Shop", "1")], site.ResponseHeaders);
        Assert.Equal(["10.0.0.0/8"], site.IpRules!.Allow);
        Assert.Equal(["10.0.0.1"], site.IpRules.Deny);
        Assert.Equal("Shop", site.BasicAuth!.Realm);
        Assert.Equal([new NginxBasicAuthUser("ann", "$6$hash"), new NginxBasicAuthUser("ben", string.Empty)], site.BasicAuth.Users);
        Assert.Equal(new NginxRateLimit(10, NginxRatePeriod.Second, 5, false), site.RateLimit);
        Assert.Equal(20, site.ClientMaxBodySizeMegabytes);
        Assert.Equal(new NginxTimeouts(1, 2, 3), site.Timeouts);
        Assert.Equal("server;", site.ServerSnippet);
        Assert.Equal("location;", site.LocationSnippet);
    }

    [Fact]
    public void What_the_wire_leaves_out_reads_as_empty_or_the_defaults()
    {
        var settings = new SiteSettings(null!, null!, new UpstreamTarget(UpstreamKind.ServicePort, Port: 3000), ResponseHeaders: [null!], IpRules: new SiteIpRules(null!, null!));

        var site = SiteMapping.ToModel(settings, new Dictionary<string, string>(), null, null, null);

        Assert.Equal(string.Empty, site.Id);
        Assert.Empty(site.Domains);
        Assert.Equal(new NginxServiceUpstream("local", 3000), site.Upstream);
        Assert.Equal(NginxSecurityHeaders.Recommended, site.SecurityHeaders);
        Assert.Equal([new NginxHeader(string.Empty, string.Empty)], site.ResponseHeaders);
        Assert.Empty(site.IpRules!.Allow);
        Assert.Empty(site.IpRules.Deny);
        Assert.Null(site.ProxyCache);
        Assert.Null(site.Hsts);
        Assert.Null(site.BasicAuth);
        Assert.Null(site.RateLimit);
        Assert.Null(site.Timeouts);
        Assert.Equal(NginxRatePeriod.Minute, SiteMapping.ToModel(settings with { RateLimit = new SiteRateLimit(1, SiteRatePeriod.Minute) }, new Dictionary<string, string>(), null, null, null).RateLimit!.Per);
    }

    [Fact]
    public void A_stream_proxy_reaches_the_model()
    {
        var proxy = SiteMapping.ToModel(new StreamProxySettings("dns", StreamProxyProtocol.Udp, 53, new UpstreamTarget(UpstreamKind.Endpoint, Address: "10.0.0.2:53"), ["10.0.0.0/8"], 5, 60));

        Assert.Equal("dns", proxy.Id);
        Assert.Equal(NginxStreamProtocol.Udp, proxy.Protocol);
        Assert.Equal(53, proxy.ListenPort);
        Assert.Equal(new NginxEndpointUpstream("10.0.0.2:53"), proxy.Upstream);
        Assert.Equal(["10.0.0.0/8"], proxy.AllowFrom);
        Assert.Equal(5, proxy.ConnectTimeoutSeconds);
        Assert.Equal(60, proxy.IdleTimeoutSeconds);

        var tcp = SiteMapping.ToModel(new StreamProxySettings("db", StreamProxyProtocol.Tcp, 5432, new UpstreamTarget(UpstreamKind.ServicePort, Port: 5432, Service: "db")));
        Assert.Equal(NginxStreamProtocol.Tcp, tcp.Protocol);
        Assert.Equal(new NginxServiceUpstream("db", 5432), tcp.Upstream);
        Assert.Empty(tcp.AllowFrom);
    }

    [Fact]
    public void A_problem_names_the_site_it_is_about()
    {
        Assert.Equal(new NginxProblemInfo("sites[shop].domains[0]", "Bad name.", 3, "shop"), SiteMapping.ToInfo(new NginxProblem("sites[shop].domains[0]", "Bad name.", 3)));
        Assert.Null(SiteMapping.ToInfo(new NginxProblem("nginx", "Not installed.")).SiteId);
    }

    [Fact]
    public void A_stored_site_and_proxy_read_back_with_whether_they_are_applied()
    {
        var settings = new SiteSettings("shop", ["shop.example.com"], new UpstreamTarget(UpstreamKind.ServicePort, Port: 3000));
        var site = new Site { Id = "shop", Settings = SiteMapping.Serialize(settings), ServerSnippet = "s;", LocationSnippet = "l;", CreatedAt = 1, UpdatedAt = 2 };
        var certificate = new CertificateInfo("shop", CertificateSource.Acme, CertificateState.Valid, ["shop.example.com"], "R11", 1, 2, true);

        var info = SiteMapping.ToInfo(site, true, certificate);

        Assert.Equal(settings.Id, info.Settings.Id);
        Assert.Equal(settings.Domains, info.Settings.Domains);
        Assert.Equal(settings.Upstream, info.Settings.Upstream);
        Assert.True(info.Applied);
        Assert.Equal(1, info.CreatedAtUnixMs);
        Assert.Equal(2, info.UpdatedAtUnixMs);
        Assert.Equal("s;", info.ServerSnippet);
        Assert.Equal("l;", info.LocationSnippet);
        Assert.Same(certificate, info.Certificate);

        var json = SiteMapping.Serialize(new StreamProxySettings("dns", StreamProxyProtocol.Udp, 53, new UpstreamTarget(UpstreamKind.Endpoint, Address: "10.0.0.2:53")));
        var row = new StreamProxy { Id = "dns", Settings = json, UpdatedAt = 7, AppliedFingerprint = SiteMapping.Fingerprint(json) };
        var proxy = SiteMapping.ToInfo(row);
        Assert.Equal("dns", proxy.Settings.Id);
        Assert.True(proxy.Applied);
        Assert.Equal(7, proxy.UpdatedAtUnixMs);
        row.AppliedFingerprint = null;
        Assert.False(SiteMapping.ToInfo(row).Applied);
    }

    [Fact]
    public async Task Site_snippets_are_read_in_the_query()
    {
        await using var database = await TestDatabase.CreateAsync();
        await using var db = await database.Contexts.CreateDbContextAsync(TestContext.Current.CancellationToken);

        var sql = SiteMapping.ToSnippetRows(db.Sites).ToQueryString();
        Assert.Contains("\"ServerSnippet\"", sql, StringComparison.Ordinal);
        Assert.Contains("\"LocationSnippet\"", sql, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Settings\"", sql, StringComparison.Ordinal);

        Site[] sites = [new() { Id = "shop", Settings = "{}", ServerSnippet = "s;", LocationSnippet = null }];
        Assert.Equal([new SiteSnippetRow("shop", "s;", null)], SiteMapping.ToSnippetRows(sites.AsQueryable()));
    }
}
