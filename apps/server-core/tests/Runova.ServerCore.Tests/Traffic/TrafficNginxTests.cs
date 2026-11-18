using Microsoft.Extensions.Logging.Abstractions;
using Runova.ServerCore.Nginx;
using Runova.ServerCore.Tests.Nginx;
using Runova.ServerCore.Traffic;

namespace Runova.ServerCore.Tests.Traffic;

/// <summary>
/// What nginx needs for traffic statistics (E109 T1) and blocking (E110 T3): every site logs in the
/// runova_main format, a geo map at the http level reads blocked.conf, and every server block of a
/// site refuses a blocked address. Blocking rewrites only blocked.conf, checked and reloaded, and
/// puts the old file back when nginx refuses it.
/// </summary>
public sealed class TrafficNginxTests
{
    private static readonly NginxLayout _layout = NginxLayout.Debian;

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static NginxSite Site(string id = "app") => new()
    {
        Id = id,
        Domains = [id + ".example.com"],
        Upstream = new NginxServiceUpstream("web", 3000),
    };

    private static NginxRelease Render(NginxConfiguration configuration) =>
        NginxRenderer.Render(configuration, _layout, UpstreamPolicy.Default, release: 3);

    private static string File(NginxRelease release, string path) => release.Files.Single(f => f.Path == path).Content;

    private static int CountOf(string text, string line) => text.Split('\n').Count(l => l.Trim() == line);

    [Fact]
    public void The_http_level_defines_the_runova_main_format_with_the_combined_fields_first()
    {
        var http = File(Render(new NginxConfiguration([Site()], [])), NginxRenderer.HttpFile);

        var start = http.IndexOf("log_format runova_main ", StringComparison.Ordinal);
        Assert.True(start >= 0, http);
        var end = http.IndexOf(';', start);
        var format = string.Concat(http[start..end].Split('\'').Where((_, i) => i % 2 == 1));
        Assert.Equal(
            "$remote_addr - $remote_user [$time_local] \"$request\" $status $body_bytes_sent \"$http_referer\" \"$http_user_agent\""
            + " \"$host\" $request_time \"$sent_http_content_type\" $scheme $realip_remote_addr"
            + " \"$http_cf_ipcountry\" \"$http_cf_ipcity\" \"$http_cf_region\"",
            format);
        Assert.True(start < http.IndexOf("include /etc/nginx/runova/releases/3/sites/app.conf;", StringComparison.Ordinal));
        Assert.Equal("runova_main", TrafficLogFormat.Name(_layout));
    }

    [Fact]
    public void Every_access_log_uses_the_format()
    {
        var release = Render(new NginxConfiguration([Site() with { Certificate = new NginxCertificate("/c.pem", "/k.pem") }], []) { Tunnel = new NginxTunnel(8089) });
        var site = File(release, "sites/app.conf");

        Assert.Equal(3, CountOf(site, "access_log /var/log/nginx/runova-app.access.log runova_main;"));
        Assert.DoesNotContain(site.Split('\n'), line => line.Trim().StartsWith("access_log", StringComparison.Ordinal) && !line.Contains("runova_main", StringComparison.Ordinal));
    }

    [Fact]
    public void A_geo_map_reads_the_blocked_addresses_from_outside_the_releases()
    {
        var http = File(Render(NginxConfiguration.Empty), NginxRenderer.HttpFile);

        Assert.Equal("/etc/nginx/runova/blocked.conf", _layout.BlockListFile);
        Assert.Contains("geo $runova_blocked {\n    default 0;\n    include /etc/nginx/runova/blocked.conf;\n}\n", http, StringComparison.Ordinal);
    }

    [Fact]
    public void Every_server_block_of_a_site_refuses_a_blocked_address()
    {
        var release = Render(new NginxConfiguration([Site() with { Certificate = new NginxCertificate("/c.pem", "/k.pem") }], []) { Tunnel = new NginxTunnel(8089) });
        var site = File(release, "sites/app.conf");

        // Port 80 (the redirect), 443 and the tunnel's listener.
        Assert.Equal(3, CountOf(site, "if ($runova_blocked) {"));
        Assert.Equal(3, site.Split("if ($runova_blocked) {\n        return 444;\n    }", StringSplitOptions.None).Length - 1);
        var acme = site.IndexOf("acme-challenge", StringComparison.Ordinal);
        Assert.True(site.IndexOf("if ($runova_blocked)", StringComparison.Ordinal) < acme);
    }

    [Fact]
    public void The_blocked_file_lists_each_network_once_in_order()
    {
        var text = BlockList.Render(["198.51.100.0/24", "203.0.113.7", "2001:db8::/32", "203.0.113.7"]);

        Assert.StartsWith("# Managed by Runova", text, StringComparison.Ordinal);
        Assert.EndsWith("198.51.100.0/24 1;\n2001:db8::/32 1;\n203.0.113.7 1;\n", text, StringComparison.Ordinal);
        Assert.Equal("# Managed by Runova. Addresses blocked under Traffic, one per line; nginx answers them with nothing.\n", BlockList.Render([]));
    }

    [Fact]
    public async Task Setting_up_nginx_leaves_an_empty_blocked_file_so_nginx_can_load()
    {
        using var kit = new NginxKit();

        await kit.SetUpAsync();

        Assert.Equal(BlockList.Render([]), kit.Machine.Text(kit.Layout.BlockListFile));
    }

    [Fact]
    public async Task An_apply_puts_the_blocked_file_in_place_before_nginx_checks_it_and_never_replaces_one()
    {
        using var kit = new NginxKit();
        await kit.SetUpAsync();
        kit.Machine.Remove(kit.Layout.BlockListFile);

        var first = await kit.ApplyAsync(new NginxConfiguration([Site()], []));
        kit.Machine.WriteText(kit.Layout.BlockListFile, "203.0.113.7 1;\n");
        var second = await kit.ApplyAsync(new NginxConfiguration([Site(), Site("blog")], []));

        Assert.True(first.Applied, first.Error + string.Join("; ", first.Problems));
        Assert.True(second.Applied, second.Error + string.Join("; ", second.Problems));
        Assert.Equal("203.0.113.7 1;\n", kit.Machine.Text(kit.Layout.BlockListFile));
    }

    [Fact]
    public async Task The_simulated_nginx_opens_each_sites_logs_as_nginx_does_when_it_loads_them()
    {
        using var kit = new NginxKit();
        await kit.SetUpAsync();

        await kit.ApplyAsync(new NginxConfiguration([Site(), Site("blog")], []));

        Assert.Equal(string.Empty, kit.Machine.Text("/var/log/nginx/runova-app.access.log"));
        Assert.Equal(string.Empty, kit.Machine.Text("/var/log/nginx/runova-blog.error.log"));
        kit.Machine.AppendText("/var/log/nginx/runova-app.access.log", "kept\n");
        await kit.ApplyAsync(new NginxConfiguration([Site(), Site("blog"), Site("shop")], []));
        Assert.Equal("kept\n", kit.Machine.Text("/var/log/nginx/runova-app.access.log"));
    }

    [Fact]
    public async Task Nginx_refuses_a_configuration_whose_blocked_file_is_missing()
    {
        using var kit = new NginxKit();
        await kit.SetUpAsync();
        kit.Machine.Remove(kit.Layout.BlockListFile);

        var test = await kit.Control.TestAsync(Cancel);

        Assert.False(test.Succeeded);
        Assert.Contains("blocked.conf", test.StandardError, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Blocking_rewrites_only_the_blocked_file_checks_it_and_reloads()
    {
        using var kit = new NginxKit();
        await kit.SetUpAsync();
        var release = await kit.Machine.ReadLinkAsync(kit.Layout.CurrentLink, Cancel);
        var reloads = kit.Machine.Reloads;
        var blocks = new BlockList(kit.Control, kit.Applier, NginxKit.Ubuntu, NullLogger<BlockList>.Instance);

        var outcome = await blocks.ApplyAsync(["203.0.113.7", "198.51.100.0/24"], Cancel);

        Assert.True(outcome.Applied, outcome.Error);
        Assert.Equal(BlockList.Render(["203.0.113.7", "198.51.100.0/24"]), kit.Machine.Text(kit.Layout.BlockListFile));
        Assert.Equal(release, await kit.Machine.ReadLinkAsync(kit.Layout.CurrentLink, Cancel));
        Assert.Equal(reloads + 1, kit.Machine.Reloads);
        Assert.Contains("nginx -t", kit.Machine.Commands);
    }

    [Fact]
    public async Task A_blocked_file_nginx_refuses_is_taken_back_and_nothing_reloads()
    {
        using var kit = new NginxKit();
        await kit.SetUpAsync();
        var blocks = new BlockList(kit.Control, kit.Applier, NginxKit.Ubuntu, NullLogger<BlockList>.Instance);
        await blocks.ApplyAsync(["203.0.113.7"], Cancel);
        var before = kit.Machine.Text(kit.Layout.BlockListFile);
        var reloads = kit.Machine.Reloads;
        kit.Machine.TestFailure = machine => machine.Text(kit.Layout.BlockListFile)!.Contains("198.51.100.9", StringComparison.Ordinal)
            ? "nginx: [emerg] invalid network \"198.51.100.9\" in /etc/nginx/runova/blocked.conf:3"
            : null;

        var outcome = await blocks.ApplyAsync(["203.0.113.7", "198.51.100.9"], Cancel);

        Assert.False(outcome.Applied);
        Assert.Contains("invalid network", outcome.Error, StringComparison.Ordinal);
        Assert.Equal(before, kit.Machine.Text(kit.Layout.BlockListFile));
        Assert.Equal(reloads, kit.Machine.Reloads);
    }

    [Fact]
    public async Task A_reload_nginx_refuses_puts_the_old_file_back()
    {
        using var kit = new NginxKit();
        await kit.SetUpAsync();
        var blocks = new BlockList(kit.Control, kit.Applier, NginxKit.Ubuntu, NullLogger<BlockList>.Instance);
        kit.Machine.ReloadFailure = _ => "2026/10/01 12:00:00 [emerg] 4100#4100: something went wrong";

        var outcome = await blocks.ApplyAsync(["203.0.113.7"], Cancel);

        Assert.False(outcome.Applied);
        Assert.Equal(BlockList.Render([]), kit.Machine.Text(kit.Layout.BlockListFile));
    }

    [Fact]
    public async Task Blocking_before_nginx_is_set_up_only_writes_the_file()
    {
        using var kit = new NginxKit(installed: false);
        var blocks = new BlockList(kit.Control, kit.Applier, NginxKit.Ubuntu, NullLogger<BlockList>.Instance);

        var outcome = await blocks.ApplyAsync(["203.0.113.7"], Cancel);

        Assert.True(outcome.Applied, outcome.Error);
        Assert.Equal(BlockList.Render(["203.0.113.7"]), kit.Machine.Text(kit.Layout.BlockListFile));
        Assert.DoesNotContain("nginx -s reload", kit.Machine.Commands);
    }
}
