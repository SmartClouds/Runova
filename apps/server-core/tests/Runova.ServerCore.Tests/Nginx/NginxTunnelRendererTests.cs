using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Tests.Nginx;

/// <summary>
/// E95 in nginx: with the Cloudflare Tunnel on, every site (and the core domain) also answers on a
/// plain-HTTP listener on 127.0.0.2 that only cloudflared on this machine reaches. That listener,
/// and only it, takes the visitor's address from CF-Connecting-IP and the scheme from
/// X-Forwarded-Proto, still answers ACME challenges, and answers no name it does not know.
/// </summary>
public sealed class NginxTunnelRendererTests
{
    private const string Listener = "listen 127.0.0.2:18080;";

    private static readonly NginxLayout _layout = NginxLayout.Debian;

    private static NginxSite Site(bool tls = true, bool redirect = true) => new()
    {
        Id = "app",
        Domains = ["app.example.com", "www.example.com"],
        Upstream = new NginxServiceUpstream("web", 3000),
        Certificate = tls ? new NginxCertificate("/etc/ssl/a.pem", "/etc/ssl/a.key") : null,
        RedirectToHttps = redirect,
    };

    private static NginxSite CoreSite(bool tls) => new()
    {
        Id = "runova-core",
        Domains = ["core.example.com"],
        Upstream = new NginxCoreUpstream(41234),
        Certificate = tls ? new NginxCertificate("/etc/ssl/c.pem", "/etc/ssl/c.key") : null,
    };

    private static NginxRelease Render(NginxTunnel? tunnel, params NginxSite[] sites) =>
        NginxRenderer.Render(
            new NginxConfiguration(sites.Length == 0 ? [Site()] : sites, []) { Tunnel = tunnel, CoreKey = new string('k', 43), CoreThroughCloudflare = true },
            _layout,
            UpstreamPolicy.Default,
            release: 7);

    private static string File(NginxRelease release, string path) => release.Files.Single(f => f.Path == path).Content;

    /// <summary>The server block that listens on the tunnel's address.</summary>
    private static string TunnelBlock(string site)
    {
        var start = site.IndexOf(Listener, StringComparison.Ordinal);
        Assert.True(start >= 0, "no tunnel listener in:\n" + site);
        var open = site.LastIndexOf("server {", start, StringComparison.Ordinal);
        var depth = 0;
        for (var i = open; i < site.Length; i++)
        {
            depth += site[i] == '{' ? 1 : site[i] == '}' ? -1 : 0;
            if (depth == 0 && site[i] == '}')
            {
                return site[open..(i + 1)];
            }
        }

        return site[open..];
    }

    [Fact]
    public void Each_site_answers_on_the_loopback_listener_with_the_visitor_s_address_and_scheme_from_cloudflare()
    {
        var release = Render(new NginxTunnel(18080));

        var block = TunnelBlock(File(release, "sites/app.conf"));
        Assert.Contains("server_name app.example.com www.example.com;", block, StringComparison.Ordinal);
        Assert.Contains($"include /etc/nginx/runova/releases/7/{NginxCloudflare.TunnelRealIpFile};", block, StringComparison.Ordinal);
        Assert.Contains("location ^~ /.well-known/acme-challenge/", block, StringComparison.Ordinal);
        Assert.Contains("proxy_pass http://127.0.0.1:3000;", block, StringComparison.Ordinal);
        Assert.Contains("proxy_set_header X-Forwarded-Proto $runova_tunnel_scheme;", block, StringComparison.Ordinal);
        Assert.Contains("proxy_set_header X-Forwarded-Port $runova_tunnel_port;", block, StringComparison.Ordinal);
        Assert.Contains("return 301 https://$host$request_uri;", block, StringComparison.Ordinal);
        Assert.DoesNotContain("ssl_", block, StringComparison.Ordinal);

        var realIp = File(release, NginxCloudflare.TunnelRealIpFile);
        Assert.Contains("set_real_ip_from 127.0.0.0/8;", realIp, StringComparison.Ordinal);
        Assert.Contains("real_ip_header CF-Connecting-IP;", realIp, StringComparison.Ordinal);
    }

    [Fact]
    public void The_public_blocks_never_trust_cloudflare_s_header()
    {
        var site = File(Render(new NginxTunnel(18080)), "sites/app.conf");
        var tunnel = TunnelBlock(site);
        var rest = site.Replace(tunnel, string.Empty, StringComparison.Ordinal);

        Assert.DoesNotContain("real-ip", rest, StringComparison.Ordinal);
        Assert.DoesNotContain("$runova_tunnel_scheme", rest, StringComparison.Ordinal);
        Assert.Contains("listen 443 ssl;", rest, StringComparison.Ordinal);
    }

    [Fact]
    public void A_site_without_redirect_or_certificate_still_answers_through_the_tunnel()
    {
        var block = TunnelBlock(File(Render(new NginxTunnel(18080), Site(tls: false, redirect: false)), "sites/app.conf"));

        Assert.DoesNotContain("return 301", block, StringComparison.Ordinal);
        Assert.Contains("proxy_pass http://127.0.0.1:3000;", block, StringComparison.Ordinal);
    }

    [Fact]
    public void Unknown_names_on_the_listener_get_no_answer_and_the_scheme_map_defaults_to_https()
    {
        var http = File(Render(new NginxTunnel(18080)), NginxRenderer.HttpFile);

        Assert.Contains("listen 127.0.0.2:18080 default_server;", http, StringComparison.Ordinal);
        Assert.Contains("map $http_x_forwarded_proto $runova_tunnel_scheme {", http, StringComparison.Ordinal);
        Assert.Contains("default https;", http, StringComparison.Ordinal);
        Assert.Contains("http http;", http, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void The_core_domain_answers_through_the_tunnel_with_its_key_and_never_a_certificate_header(bool tls)
    {
        var release = Render(new NginxTunnel(18080), CoreSite(tls));

        var block = TunnelBlock(File(release, "sites/runova-core.conf"));
        Assert.Contains("proxy_pass http://127.0.0.1:41234;", block, StringComparison.Ordinal);
        Assert.Contains("proxy_set_header X-Runova-Proxy-Key", block, StringComparison.Ordinal);
        Assert.Contains("proxy_set_header X-Runova-Client-Certificate \"\";", block, StringComparison.Ordinal);
        Assert.Contains("add_header Cache-Control \"no-store\" always;", block, StringComparison.Ordinal);
        Assert.Contains($"include /etc/nginx/runova/releases/7/{NginxCloudflare.TunnelRealIpFile};", block, StringComparison.Ordinal);
        Assert.True(release.Files.Single(f => f.Path == "sites/runova-core.conf").Private);
    }

    [Fact]
    public void Without_the_tunnel_nothing_listens_on_its_address()
    {
        var release = Render(null);

        Assert.DoesNotContain("127.0.0.2", string.Concat(release.Files.Select(f => f.Content)), StringComparison.Ordinal);
        Assert.DoesNotContain(release.Files, f => f.Path == NginxCloudflare.TunnelRealIpFile);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(80)]
    [InlineData(443)]
    [InlineData(70000)]
    public void A_listener_port_that_clashes_or_does_not_exist_is_refused(int port)
    {
        var refusal = Assert.Throws<NginxConfigurationException>(() => Render(new NginxTunnel(port)));

        Assert.Contains(refusal.Problems, problem => problem.Field == "tunnel.port");
    }
}
