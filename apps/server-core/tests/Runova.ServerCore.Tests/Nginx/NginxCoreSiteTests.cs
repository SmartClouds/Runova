using Runova.ServerCore.CoreDomain;
using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Tests.Nginx;

/// <summary>
/// The core domain's site (E44) as nginx gets it: HTTPS only, a client certificate asked for and
/// passed on with the key, the file root-only, and none of the options that could rewrite what
/// reaches the core. Only the reserved site may point at the core at all.
/// </summary>
public sealed class NginxCoreSiteTests
{
    private static readonly NginxLayout _layout = NginxLayout.Debian;

    private static readonly string _key = CoreDomainSettings.NewKey();

    private static NginxSite CoreSite(bool certificate = true) => new()
    {
        Id = CoreDomainSettings.SiteId,
        Domains = ["core.example.com"],
        Upstream = new NginxCoreUpstream(41234),
        Websocket = true,
        Http2 = false,
        Certificate = certificate ? new NginxCertificate("/etc/nginx/runova/certs/runova-core/fullchain.pem", "/etc/nginx/runova/certs/runova-core/privkey.pem") : null,
    };

    private static NginxRelease Render(NginxSite site, string? key = null) =>
        NginxRenderer.Render(new NginxConfiguration([site], []) { CoreKey = key ?? _key }, _layout, UpstreamPolicy.Default, release: 3);

    private static NginxReleaseFile File(NginxRelease release) =>
        release.Files.Single(f => f.Path == $"sites/{CoreDomainSettings.SiteId}.conf");

    private static IReadOnlyList<NginxProblem> Refused(NginxSite site) =>
        Assert.Throws<NginxConfigurationException>(() => Render(site)).Problems;

    [Fact]
    public void Over_https_nginx_asks_for_the_device_certificate_and_passes_it_on_with_the_key()
    {
        var file = File(Render(CoreSite() with { IpRules = new NginxIpRules(["203.0.113.0/24"], []) }));
        var https = file.Content[file.Content.IndexOf("listen 443 ssl;", StringComparison.Ordinal)..];

        Assert.True(file.Private);
        Assert.Contains("ssl_verify_client optional_no_ca;", https, StringComparison.Ordinal);
        Assert.Contains("if ($ssl_client_escaped_cert = \"\")", https, StringComparison.Ordinal);
        Assert.Contains("proxy_pass http://127.0.0.1:41234;", https, StringComparison.Ordinal);
        Assert.Contains("proxy_set_header Host runova-core;", https, StringComparison.Ordinal);
        Assert.Contains($"proxy_set_header X-Runova-Proxy-Key \"{_key}\";", https, StringComparison.Ordinal);
        Assert.Contains("proxy_set_header X-Runova-Client-Certificate $ssl_client_escaped_cert;", https, StringComparison.Ordinal);
        Assert.Contains("proxy_set_header Upgrade $http_upgrade;", https, StringComparison.Ordinal);
        Assert.Contains("allow 203.0.113.0/24;", https, StringComparison.Ordinal);
        Assert.Contains("deny all;", https, StringComparison.Ordinal);
        Assert.DoesNotContain("http2 on;", file.Content, StringComparison.Ordinal);
    }

    [Fact]
    public void Through_cloudflare_no_certificate_is_asked_for_and_none_is_passed_on()
    {
        var release = NginxRenderer.Render(
            new NginxConfiguration([CoreSite()], []) { CoreKey = _key, CoreThroughCloudflare = true },
            _layout,
            UpstreamPolicy.Default,
            release: 3);
        var file = File(release).Content;

        Assert.DoesNotContain("ssl_verify_client", file, StringComparison.Ordinal);
        Assert.DoesNotContain("$ssl_client_escaped_cert", file, StringComparison.Ordinal);
        Assert.Contains("proxy_set_header X-Runova-Client-Certificate \"\";", file, StringComparison.Ordinal);
        Assert.Contains($"proxy_set_header X-Runova-Proxy-Key \"{_key}\";", file, StringComparison.Ordinal);
        Assert.Contains("add_header Cache-Control \"no-store\" always;", file, StringComparison.Ordinal);
        Assert.DoesNotContain("real-ip.conf", file, StringComparison.Ordinal);
    }

    [Fact]
    public void Through_cloudflare_with_the_origin_lock_the_site_restores_the_visitor_and_checks_origin_pulls()
    {
        var originLock = new NginxOriginLock(["173.245.48.0/20"], AuthenticatedOriginPulls: true);
        var release = NginxRenderer.Render(
            new NginxConfiguration([CoreSite() with { IpRules = new NginxIpRules(["203.0.113.0/24"], []) }], [], originLock) { CoreKey = _key, CoreThroughCloudflare = true },
            _layout,
            UpstreamPolicy.Default,
            release: 3);
        var file = File(release).Content;
        var https = file[file.IndexOf("listen 443 ssl;", StringComparison.Ordinal)..];

        Assert.Contains("cloudflare/real-ip.conf;", https, StringComparison.Ordinal);
        Assert.Contains("cloudflare/real-ip.conf;", file[..file.IndexOf("listen 443 ssl;", StringComparison.Ordinal)], StringComparison.Ordinal);
        Assert.Contains("ssl_verify_client on;", https, StringComparison.Ordinal);
        Assert.Contains("origin-pull-ca.pem;", https, StringComparison.Ordinal);
        Assert.Contains("allow 203.0.113.0/24;", https, StringComparison.Ordinal);
        Assert.Contains(release.Files, f => f.Path == NginxCloudflare.RealIpFile);
    }

    [Fact]
    public void Straight_to_the_server_the_origin_lock_leaves_the_core_site_alone()
    {
        var originLock = new NginxOriginLock(["173.245.48.0/20"], AuthenticatedOriginPulls: true);
        var file = File(NginxRenderer.Render(new NginxConfiguration([CoreSite()], [], originLock) { CoreKey = _key }, _layout, UpstreamPolicy.Default, release: 3)).Content;

        Assert.Contains("ssl_verify_client optional_no_ca;", file, StringComparison.Ordinal);
        Assert.DoesNotContain("ssl_verify_client on;", file, StringComparison.Ordinal);
        Assert.DoesNotContain("real-ip.conf", file, StringComparison.Ordinal);
        Assert.DoesNotContain("no-store", file, StringComparison.Ordinal);
    }

    [Fact]
    public void Plain_http_only_answers_acme_and_redirects_and_never_reaches_the_core()
    {
        var withCertificate = File(Render(CoreSite())).Content;
        var http = withCertificate[..withCertificate.IndexOf("listen 443 ssl;", StringComparison.Ordinal)];
        var withoutCertificate = File(Render(CoreSite(certificate: false))).Content;

        Assert.Contains("location ^~ /.well-known/acme-challenge/", http, StringComparison.Ordinal);
        Assert.Contains("return 301 https://$host$request_uri;", http, StringComparison.Ordinal);
        Assert.DoesNotContain("proxy_pass", http, StringComparison.Ordinal);
        Assert.Contains("return 404;", withoutCertificate, StringComparison.Ordinal);
        Assert.DoesNotContain("proxy_pass", withoutCertificate, StringComparison.Ordinal);
        Assert.DoesNotContain("listen 443", withoutCertificate, StringComparison.Ordinal);
    }

    [Fact]
    public void Other_sites_stay_world_readable()
    {
        var release = NginxRenderer.Render(
            new NginxConfiguration([CoreSite(), new NginxSite { Id = "blog", Domains = ["blog.example.com"], Upstream = new NginxServiceUpstream("web", 3000) }], []) { CoreKey = _key },
            _layout,
            UpstreamPolicy.Default,
            release: 3);

        Assert.False(release.Files.Single(f => f.Path == "sites/blog.conf").Private);
        Assert.True(File(release).Private);
    }

    [Fact]
    public void A_render_without_a_valid_key_is_refused()
    {
        var problem = Assert.Single(Assert.Throws<NginxConfigurationException>(() =>
            NginxRenderer.Render(new NginxConfiguration([CoreSite()], []), _layout, UpstreamPolicy.Default, release: 3)).Problems);
        var badKey = Assert.Throws<NginxConfigurationException>(() => Render(CoreSite(), "short\"; evil"));

        Assert.Contains("lost its key", problem.Message, StringComparison.Ordinal);
        Assert.NotEmpty(badKey.Problems);
    }

    [Fact]
    public void Only_the_reserved_site_may_point_at_the_core()
    {
        var problems = Refused(CoreSite() with { Id = "blog" });

        Assert.Contains(problems, problem => problem.Message.Contains("Only the server core's own domain", StringComparison.Ordinal));
    }

    [Fact]
    public void The_core_site_takes_one_plain_domain_and_no_option_that_could_rewrite_what_reaches_the_core()
    {
        Assert.NotEmpty(Refused(CoreSite() with { Domains = ["core.example.com", "other.example.com"] }));
        Assert.NotEmpty(Refused(CoreSite() with { Domains = ["*.example.com"] }));
        Assert.NotEmpty(Refused(CoreSite() with { LocationSnippet = "proxy_set_header X-Runova-Client-Certificate \"x\";" }));
        Assert.NotEmpty(Refused(CoreSite() with { ServerSnippet = "ssl_verify_client off;" }));
        Assert.NotEmpty(Refused(CoreSite() with { BasicAuth = new NginxBasicAuth([new NginxBasicAuthUser("a", "$6$x$y")]) }));
        Assert.NotEmpty(Refused(CoreSite() with { ProxyCache = new NginxProxyCache() }));
        Assert.NotEmpty(Refused(CoreSite() with { ResponseHeaders = [new NginxHeader("X-Test", "1")] }));
        Assert.NotEmpty(Refused(CoreSite() with { Upstream = new NginxCoreUpstream(0) }));
    }
}
