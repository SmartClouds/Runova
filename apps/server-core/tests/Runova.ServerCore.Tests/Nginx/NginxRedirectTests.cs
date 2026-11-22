using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Tests.Nginx;

/// <summary>
/// Redirects: a site that sends every visitor to another address instead of proxying, and the
/// extra names of a proxied site that send visitors on to its first domain (www to the bare
/// domain, typically). Both keep answering ACME challenges so their names can get a certificate.
/// </summary>
public sealed class NginxRedirectTests
{
    private static readonly NginxLayout _layout = NginxLayout.Debian;

    private static readonly NginxCertificate _certificate = new("/etc/runova/certs/app/fullchain.pem", "/etc/runova/certs/app/privkey.pem");

    private static NginxSite Proxied(string id = "app", params string[] domains) => new()
    {
        Id = id,
        Domains = domains.Length == 0 ? ["runovahq.com"] : domains,
        Upstream = new NginxServiceUpstream("web", 3000),
    };

    private static NginxSite Redirect(string to, bool permanent = true, bool keepPath = true, params string[] domains) => new()
    {
        Id = "moved",
        Domains = domains.Length == 0 ? ["old.example.com"] : domains,
        Upstream = new NginxRedirectUpstream(to, permanent, keepPath),
    };

    private static string SiteFile(NginxConfiguration configuration, string id)
    {
        var release = NginxRenderer.Render(configuration, _layout, UpstreamPolicy.Default, release: 7);
        return release.Files.Single(f => f.Path == $"sites/{id}.conf").Content;
    }

    private static string SiteFile(NginxSite site) => SiteFile(new NginxConfiguration([site], []), site.Id);

    private static IReadOnlyList<NginxProblem> Refused(params NginxSite[] sites)
    {
        var error = Assert.Throws<NginxConfigurationException>(
            () => NginxRenderer.Render(new NginxConfiguration(sites, []), _layout, UpstreamPolicy.Default, release: 7));
        return error.Problems;
    }

    private static int CountOf(string text, string part) => text.Split('\n').Count(line => line.Trim() == part);

    [Fact]
    public void A_redirect_site_sends_every_request_on_with_its_path_and_query()
    {
        var content = SiteFile(Redirect("https://runovahq.com"));

        Assert.Contains("server_name old.example.com;", content, StringComparison.Ordinal);
        Assert.Contains("location ^~ /.well-known/acme-challenge/ {", content, StringComparison.Ordinal);
        Assert.Equal(1, CountOf(content, "return 301 https://runovahq.com$request_uri;"));
        Assert.DoesNotContain("proxy_pass", content, StringComparison.Ordinal);
    }

    [Fact]
    public void A_trailing_slash_on_the_destination_does_not_double_the_slash()
    {
        var content = SiteFile(Redirect("https://runovahq.com/blog/"));

        Assert.Contains("return 301 https://runovahq.com/blog$request_uri;", content, StringComparison.Ordinal);
    }

    [Fact]
    public void A_temporary_redirect_to_a_fixed_page_drops_the_path()
    {
        var content = SiteFile(Redirect("https://runovahq.com/landing?from=old", permanent: false, keepPath: false));

        Assert.Contains("return 302 https://runovahq.com/landing?from=old;", content, StringComparison.Ordinal);
        Assert.DoesNotContain("$request_uri", content, StringComparison.Ordinal);
    }

    [Fact]
    public void With_a_certificate_both_schemes_go_straight_to_the_destination_in_one_hop()
    {
        var content = SiteFile(Redirect("https://runovahq.com") with { Certificate = _certificate, Hsts = new NginxHsts() });

        Assert.Equal(2, CountOf(content, "return 301 https://runovahq.com$request_uri;"));
        Assert.DoesNotContain("return 301 https://$host$request_uri;", content, StringComparison.Ordinal);
        Assert.Contains("listen 443 ssl;", content, StringComparison.Ordinal);
        Assert.Contains("add_header Strict-Transport-Security \"max-age=31536000\" always;", content, StringComparison.Ordinal);
    }

    [Fact]
    public void Proxy_only_options_on_a_redirect_site_render_nothing()
    {
        var content = SiteFile(Redirect("https://runovahq.com") with
        {
            Websocket = true,
            ProxyCache = new NginxProxyCache(),
            Timeouts = new NginxTimeouts(ConnectSeconds: 5),
        });

        Assert.DoesNotContain("proxy_", content, StringComparison.Ordinal);
        Assert.DoesNotContain("Upgrade", content, StringComparison.Ordinal);
    }

    [Fact]
    public void Ip_rules_and_basic_auth_still_guard_a_redirect_site()
    {
        var content = SiteFile(Redirect("https://runovahq.com") with
        {
            IpRules = new NginxIpRules(["10.0.0.0/8"], []),
        });

        Assert.Contains("allow 10.0.0.0/8;", content, StringComparison.Ordinal);
        Assert.Contains("deny all;", content, StringComparison.Ordinal);
    }

    [Fact]
    public void Through_the_tunnel_a_redirect_site_also_goes_straight_to_the_destination()
    {
        var site = Redirect("https://runovahq.com") with { Certificate = _certificate };
        var content = SiteFile(new NginxConfiguration([site], []) { Tunnel = new NginxTunnel(18080) }, site.Id);

        Assert.Equal(3, CountOf(content, "return 301 https://runovahq.com$request_uri;"));
        Assert.DoesNotContain("https://$host$request_uri", content, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("runovahq.com")]
    [InlineData("ftp://runovahq.com")]
    [InlineData("https://")]
    [InlineData("https://runovahq.com/a b")]
    [InlineData("https://runovahq.com/$host")]
    [InlineData("https://runovahq.com/;return")]
    [InlineData("https://runovahq.com/\"x\"")]
    [InlineData("https://runovahq.com/{x}")]
    [InlineData("https://runovahq.com/a\\b")]
    [InlineData("https://user:secret@runovahq.com")]
    [InlineData("https://bad_host.com")]
    [InlineData("https://runovahq.com?x=1")]
    [InlineData("https://runovahq.com/#top")]
    [InlineData("https://runovahq.com/docs#start")]
    [InlineData("")]
    public void A_destination_that_is_not_a_plain_web_address_is_refused(string to)
    {
        var problem = Assert.Single(Refused(Redirect(to)));

        Assert.Equal("sites[moved].upstream", problem.Field);
    }

    [Theory]
    [InlineData("https://runovahq.com", true)]
    [InlineData("http://10.0.0.5:8080/app/", true)]
    [InlineData("https://[2001:db8::1]/", true)]
    [InlineData("https://runovahq.com/landing?ref=old&x=1", false)]
    [InlineData("https://xn--bcher-kva.example/%C3%A4", true)]
    public void Plain_web_addresses_are_accepted(string to, bool keepPath)
    {
        var content = SiteFile(Redirect(to, keepPath: keepPath));

        Assert.Contains("return 301 ", content, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("https://old.example.com")]
    [InlineData("http://OLD.example.com/x")]
    [InlineData("https://a.old.example.com")]
    public void A_redirect_back_to_one_of_the_sites_own_names_is_refused_since_it_would_loop(string to)
    {
        var problem = Assert.Single(Refused(Redirect(to, true, true, "old.example.com", "*.old.example.com")));

        Assert.Equal("sites[moved].upstream", problem.Field);
        Assert.Contains("loop", problem.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Redirected_names_send_visitors_to_the_first_domain_over_plain_http_until_there_is_a_certificate()
    {
        var content = SiteFile(Proxied() with { RedirectDomains = ["www.runovahq.com"] });

        Assert.Contains("server_name runovahq.com;", content, StringComparison.Ordinal);
        Assert.Contains("server_name www.runovahq.com;", content, StringComparison.Ordinal);
        Assert.Contains("return 301 http://runovahq.com$request_uri;", content, StringComparison.Ordinal);
        Assert.Equal(2, CountOf(content, "location ^~ /.well-known/acme-challenge/ {"));
        Assert.DoesNotContain("443", content, StringComparison.Ordinal);
    }

    [Fact]
    public void With_a_certificate_redirected_names_go_to_https_on_both_schemes_with_hsts()
    {
        var content = SiteFile(Proxied() with
        {
            RedirectDomains = ["www.runovahq.com"],
            Certificate = _certificate,
            Hsts = new NginxHsts(),
        });

        Assert.Equal(2, CountOf(content, "server_name www.runovahq.com;"));
        Assert.Equal(2, CountOf(content, "return 301 https://runovahq.com$request_uri;"));
        Assert.Equal(2, CountOf(content, "ssl_certificate /etc/runova/certs/app/fullchain.pem;"));
        Assert.Equal(2, CountOf(content, "add_header Strict-Transport-Security \"max-age=31536000\" always;"));
        Assert.Equal(1, CountOf(content, "proxy_pass http://127.0.0.1:3000;"));
    }

    [Fact]
    public void Through_the_tunnel_redirected_names_keep_the_visitors_scheme()
    {
        var site = Proxied() with { RedirectDomains = ["www.runovahq.com"] };
        var content = SiteFile(new NginxConfiguration([site], []) { Tunnel = new NginxTunnel(18080) }, site.Id);

        Assert.Equal(2, CountOf(content, "server_name www.runovahq.com;"));
        Assert.Contains("return 301 $runova_tunnel_scheme://runovahq.com$request_uri;", content, StringComparison.Ordinal);
    }

    [Fact]
    public void A_redirected_name_the_site_already_serves_is_refused()
    {
        var problem = Assert.Single(Refused(Proxied("app", "runovahq.com", "www.runovahq.com") with { RedirectDomains = ["WWW.runovahq.com"] }));

        Assert.Equal("sites[app].redirectDomains[0]", problem.Field);
    }

    [Fact]
    public void A_redirected_name_another_site_serves_is_refused()
    {
        var problem = Assert.Single(Refused(
            Proxied("www", "www.runovahq.com"),
            Proxied("app") with { RedirectDomains = ["www.runovahq.com"] }));

        Assert.Equal("sites[app].redirectDomains[0]", problem.Field);
    }

    [Theory]
    [InlineData("www.runovahq.com;")]
    [InlineData("10.0.0.5")]
    [InlineData("")]
    public void Redirected_names_are_checked_like_domains(string name)
    {
        var problem = Assert.Single(Refused(Proxied() with { RedirectDomains = [name] }));

        Assert.Equal("sites[app].redirectDomains[0]", problem.Field);
    }

    [Fact]
    public void Redirected_names_need_a_plain_first_domain_to_send_visitors_to()
    {
        var problem = Assert.Single(Refused(Proxied("app", "*.runovahq.com") with { RedirectDomains = ["runovahq.com"] }));

        Assert.Equal("sites[app].redirectDomains", problem.Field);
    }

    [Fact]
    public void A_site_has_at_most_a_hundred_names_counting_redirected_ones()
    {
        var domains = Enumerable.Range(0, 60).Select(i => $"a{i}.example.com").ToArray();
        var redirected = Enumerable.Range(0, 41).Select(i => $"b{i}.example.com").ToArray();

        var problem = Assert.Single(Refused(Proxied("app", domains) with { RedirectDomains = redirected }));

        Assert.Equal("sites[app].redirectDomains", problem.Field);
    }

    [Fact]
    public void A_redirect_site_takes_no_redirected_names_since_all_of_its_names_redirect()
    {
        var problem = Assert.Single(Refused(Redirect("https://runovahq.com") with { RedirectDomains = ["www.old.example.com"] }));

        Assert.Equal("sites[moved].redirectDomains", problem.Field);
    }
}
