using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.CoreDomain;
using Runova.ServerCore.Data;
using Runova.ServerCore.Nginx;
using Runova.ServerCore.Security;
using Runova.ServerCore.Tests.Web;

namespace Runova.ServerCore.Tests.CoreDomainTests;

/// <summary>
/// The core domain (E44) through the hub: every role reads it, only an Owner who stepped up turns
/// it on, nginx has to be installed and running first, the reserved site only passes HTTPS with a
/// client certificate on to the core, the Websites calls cannot touch that site, and turning it
/// off takes the site out and closes the core's port for nginx.
/// </summary>
public sealed class HubCoreDomainTests
{
    private const string Domain = "core.example.com";

    private const string SiteFile = "/etc/nginx/runova/current/sites/runova-core.conf";

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static async Task<HubConnection> ConnectAsync(AuthHarness harness, bool stepUp)
    {
        var hub = await WebHubTests.ConnectAsync(harness);
        if (stepUp)
        {
            await hub.InvokeAsync<StepUpResponse>(nameof(ICoreHub.StepUp), new StepUpRequest(AuthHarness.Password), Cancel);
        }

        return hub;
    }

    private static Task<CoreDomainStatus> EnableAsync(HubConnection hub, string domain = Domain, string[]? sources = null, CoreDomainMode mode = CoreDomainMode.Direct) =>
        hub.InvokeAsync<CoreDomainStatus>(nameof(ICoreHub.EnableCoreDomain), new CoreDomainRequest(domain, sources, mode), Cancel);

    /// <summary>The origin lock as the core keeps it once on; the firewall side is the origin lock tests' business.</summary>
    private static async Task LockOriginAsync(AuthHarness harness, bool pulls = false)
    {
        await using var scope = harness.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
        var row = new OriginLockSetting { Enabled = true, AuthenticatedOriginPulls = pulls };
        Runova.ServerCore.Cloudflare.OriginLockRows.SetRanges(row, Runova.ServerCore.Cloudflare.CloudflareRangeList.Parse(["173.245.48.0/20"], ["2400:cb00::/32"], 0));
        db.OriginLock.Add(row);
        await db.SaveChangesAsync(Cancel);
    }

    private static async Task<List<string>> AuditAsync(AuthHarness harness)
    {
        await using var scope = harness.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<CoreDbContext>().AuditEvents
            .Where(e => e.Action.StartsWith("coreDomain."))
            .OrderBy(e => e.Id)
            .Select(e => e.Action + ":" + e.Result)
            .ToListAsync(Cancel);
    }

    [Fact]
    public async Task A_viewer_reads_it_but_cannot_turn_it_on_or_off()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Viewer, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: true);

        var status = await hub.InvokeAsync<CoreDomainStatus>(nameof(ICoreHub.GetCoreDomain), Cancel);
        var refused = await Assert.ThrowsAsync<HubException>(() => EnableAsync(hub));
        var refusedOff = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<CoreDomainStatus>(nameof(ICoreHub.DisableCoreDomain), Cancel));

        Assert.False(status.Enabled);
        Assert.False(status.Ready);
        Assert.Equal(CoreDomainSettings.SiteId, status.SiteId);
        Assert.Contains("unauthorized", refused.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("unauthorized", refusedOff.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task An_owner_needs_a_step_up_to_turn_it_on()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: false);
        await WebHubTests.SetUpNginxAsync(harness, hub);

        var refused = await Assert.ThrowsAsync<HubException>(() => EnableAsync(hub));

        Assert.Contains("unauthorized", refused.Message, StringComparison.OrdinalIgnoreCase);
        Assert.False((await hub.InvokeAsync<CoreDomainStatus>(nameof(ICoreHub.GetCoreDomain), Cancel)).Enabled);
    }

    [Fact]
    public async Task It_is_refused_until_nginx_is_installed()
    {
        await using var harness = await AuthHarness.CreateAsync(
            CoreRoles.Owner,
            fakeClock: false,
            services: (services, _) => services.AddSingleton(_ => new SimulatedNginxMachine(installed: false)));
        await using var hub = await ConnectAsync(harness, stepUp: true);

        var status = await hub.InvokeAsync<CoreDomainStatus>(nameof(ICoreHub.GetCoreDomain), Cancel);
        var refused = await Assert.ThrowsAsync<HubException>(() => EnableAsync(hub));

        Assert.False(status.NginxInstalled);
        Assert.False(status.NginxRunning);
        Assert.Contains("nginx is not installed", refused.Message, StringComparison.Ordinal);
        Assert.Equal(["coreDomain.enable:denied"], await AuditAsync(harness));
        Assert.Null(harness.Services.GetRequiredService<SimulatedNginxMachine>().Text(SiteFile));
    }

    [Fact]
    public async Task Plain_http_never_reaches_the_core_and_https_needs_a_device_certificate()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: true);
        await WebHubTests.SetUpNginxAsync(harness, hub);
        var nginx = harness.Services.GetRequiredService<SimulatedNginxMachine>();

        var status = await EnableAsync(hub, "Core.Example.com", ["203.0.113.0/24"]);
        var port = harness.Services.GetRequiredService<CoreDomainStore>().Read().Port;
        var key = harness.Services.GetRequiredService<CoreDomainStore>().Read().Key!;
        var httpOnly = nginx.Text(SiteFile)!;

        Assert.True(status.Enabled, status.Error);
        Assert.True(status.Listening);
        Assert.True(status.SiteApplied);
        Assert.False(status.Ready);
        Assert.Null(status.Certificate);
        Assert.Equal(Domain, status.Domain);
        Assert.Equal(["203.0.113.0/24"], status.Sources);
        Assert.Contains("return 404;", httpOnly, StringComparison.Ordinal);
        Assert.DoesNotContain("proxy_pass", httpOnly, StringComparison.Ordinal);
        Assert.DoesNotContain("listen 443", httpOnly, StringComparison.Ordinal);

        var (chain, privateKey) = WebHubTests.SelfSigned(Domain);
        var uploaded = await hub.InvokeAsync<CertificateUploadResult>(nameof(ICoreHub.UploadCertificate), new CertificateUploadRequest(CoreDomainSettings.SiteId, chain, privateKey), Cancel);
        var ready = await hub.InvokeAsync<CoreDomainStatus>(nameof(ICoreHub.GetCoreDomain), Cancel);
        var served = nginx.Text(SiteFile)!;

        Assert.Empty(uploaded.Problems);
        Assert.True(uploaded.Apply!.Applied, uploaded.Apply.Error);
        Assert.True(ready.Ready);
        Assert.NotNull(ready.Certificate);
        Assert.Contains("return 301 https://$host$request_uri;", served, StringComparison.Ordinal);
        Assert.Contains("ssl_verify_client optional_no_ca;", served, StringComparison.Ordinal);
        Assert.Contains($"proxy_pass http://127.0.0.1:{port};", served, StringComparison.Ordinal);
        Assert.Contains($"proxy_set_header X-Runova-Proxy-Key \"{key}\";", served, StringComparison.Ordinal);
        Assert.Contains("proxy_set_header X-Runova-Client-Certificate $ssl_client_escaped_cert;", served, StringComparison.Ordinal);
        Assert.Contains("allow 203.0.113.0/24;", served, StringComparison.Ordinal);
        Assert.Contains("deny all;", served, StringComparison.Ordinal);
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, nginx.ModeOf(SiteFile));
        Assert.Equal(["coreDomain.enable:success"], await AuditAsync(harness));
    }

    [Fact]
    public async Task The_websites_calls_leave_the_core_site_alone()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: true);
        await WebHubTests.SetUpNginxAsync(harness, hub);
        await EnableAsync(hub);

        var listed = await hub.InvokeAsync<SiteInfo[]>(nameof(ICoreHub.ListSites), Cancel);
        var overwrite = await hub.InvokeAsync<SiteSaveResult>(nameof(ICoreHub.SaveSite), WebHubTests.Blog() with { Id = CoreDomainSettings.SiteId }, Cancel);
        var pointAtCore = await hub.InvokeAsync<SiteSaveResult>(nameof(ICoreHub.SaveSite), WebHubTests.Blog() with { Upstream = new UpstreamTarget(UpstreamKind.RunovaCore, Port: 1234) }, Cancel);
        var snippets = await hub.InvokeAsync<SiteSaveResult>(nameof(ICoreHub.SetSiteSnippets), new SiteSnippets(CoreDomainSettings.SiteId, "add_header X-Test 1;"), Cancel);
        var delete = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync(nameof(ICoreHub.DeleteSite), CoreDomainSettings.SiteId, Cancel));

        Assert.Empty(listed);
        Assert.Contains("Security, Connection", Assert.Single(overwrite.Problems).Message, StringComparison.Ordinal);
        Assert.Contains("Only the server core's own domain", Assert.Single(pointAtCore.Problems).Message, StringComparison.Ordinal);
        Assert.Contains("Security, Connection", Assert.Single(snippets.Problems).Message, StringComparison.Ordinal);
        Assert.Contains("no such site", delete.Message, StringComparison.Ordinal);
        Assert.True((await hub.InvokeAsync<CoreDomainStatus>(nameof(ICoreHub.GetCoreDomain), Cancel)).SiteApplied);
    }

    [Fact]
    public async Task A_domain_another_site_holds_is_refused_and_nothing_changes()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: true);
        await WebHubTests.SetUpNginxAsync(harness, hub);
        Assert.Empty((await hub.InvokeAsync<SiteSaveResult>(nameof(ICoreHub.SaveSite), WebHubTests.Blog(Domain), Cancel)).Problems);

        var refused = await Assert.ThrowsAsync<HubException>(() => EnableAsync(hub));
        var wildcard = await Assert.ThrowsAsync<HubException>(() => EnableAsync(hub, "*.example.com"));

        Assert.Contains("already belongs to the site blog", refused.Message, StringComparison.Ordinal);
        Assert.Contains("not a wildcard", wildcard.Message, StringComparison.Ordinal);
        Assert.False((await hub.InvokeAsync<CoreDomainStatus>(nameof(ICoreHub.GetCoreDomain), Cancel)).Enabled);
        Assert.False(harness.Services.GetRequiredService<CoreDomainStore>().Read().Enabled);
    }

    [Fact]
    public async Task The_cloudflare_origin_lock_keeps_it_off()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: true);
        await WebHubTests.SetUpNginxAsync(harness, hub);
        await using (var scope = harness.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
            db.OriginLock.Add(new OriginLockSetting { Enabled = true });
            await db.SaveChangesAsync(Cancel);
        }

        var refused = await Assert.ThrowsAsync<HubException>(() => EnableAsync(hub));

        Assert.Contains("origin lock", refused.Message, StringComparison.Ordinal);
        Assert.True((await hub.InvokeAsync<CoreDomainStatus>(nameof(ICoreHub.GetCoreDomain), Cancel)).OriginLocked);
    }

    [Fact]
    public async Task Through_cloudflare_it_works_with_the_origin_lock_on_and_an_origin_certificate()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: true);
        await WebHubTests.SetUpNginxAsync(harness, hub);
        await LockOriginAsync(harness, pulls: true);
        var nginx = harness.Services.GetRequiredService<SimulatedNginxMachine>();

        var status = await EnableAsync(hub, sources: ["203.0.113.0/24"], mode: CoreDomainMode.Cloudflare);
        var request = await hub.InvokeAsync<OriginCertificateRequestInfo>(nameof(ICoreHub.CreateOriginCertificateRequest), CoreDomainSettings.SiteId, Cancel);
        var installed = await hub.InvokeAsync<CertificateUploadResult>(
            nameof(ICoreHub.InstallOriginCertificate), new OriginCertificateInstall(CoreDomainSettings.SiteId, Cloudflare.HubOriginCertificateTests.Sign(request.CsrPem)), Cancel);
        var ready = await hub.InvokeAsync<CoreDomainStatus>(nameof(ICoreHub.GetCoreDomain), Cancel);
        var served = nginx.Text(SiteFile)!;

        Assert.True(status.Enabled, status.Error);
        Assert.Equal(CoreDomainMode.Cloudflare, status.Mode);
        Assert.True(status.OriginLocked);
        Assert.Empty(installed.Problems);
        Assert.True(ready.Ready, ready.Error);
        Assert.Equal(CertificateSource.CloudflareOrigin, ready.Certificate!.Source);
        Assert.Contains("cloudflare/real-ip.conf;", served, StringComparison.Ordinal);
        Assert.Contains("ssl_verify_client on;", served, StringComparison.Ordinal);
        Assert.DoesNotContain("optional_no_ca", served, StringComparison.Ordinal);
        Assert.Contains("proxy_set_header X-Runova-Client-Certificate \"\";", served, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Straight_to_the_server_an_origin_certificate_does_not_make_it_ready()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: true);
        await WebHubTests.SetUpNginxAsync(harness, hub);
        await EnableAsync(hub);

        var request = await hub.InvokeAsync<OriginCertificateRequestInfo>(nameof(ICoreHub.CreateOriginCertificateRequest), CoreDomainSettings.SiteId, Cancel);
        await hub.InvokeAsync<CertificateUploadResult>(
            nameof(ICoreHub.InstallOriginCertificate), new OriginCertificateInstall(CoreDomainSettings.SiteId, Cloudflare.HubOriginCertificateTests.Sign(request.CsrPem)), Cancel);
        var direct = await hub.InvokeAsync<CoreDomainStatus>(nameof(ICoreHub.GetCoreDomain), Cancel);
        var proxied = await EnableAsync(hub, mode: CoreDomainMode.Cloudflare);

        Assert.False(direct.Ready);
        Assert.True(proxied.Ready, proxied.Error);
    }

    [Fact]
    public async Task Through_cloudflare_sources_need_the_origin_lock()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: true);
        await WebHubTests.SetUpNginxAsync(harness, hub);

        var refused = await Assert.ThrowsAsync<HubException>(() => EnableAsync(hub, sources: ["203.0.113.0/24"], mode: CoreDomainMode.Cloudflare));
        var open = await EnableAsync(hub, mode: CoreDomainMode.Cloudflare);

        Assert.Contains("origin lock", refused.Message, StringComparison.Ordinal);
        Assert.True(open.Enabled, open.Error);
        Assert.False(open.OriginLocked);
    }

    [Fact]
    public async Task Switching_modes_keeps_the_port_and_the_key_and_rewrites_the_site()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: true);
        await WebHubTests.SetUpNginxAsync(harness, hub);
        var store = harness.Services.GetRequiredService<CoreDomainStore>();
        var nginx = harness.Services.GetRequiredService<SimulatedNginxMachine>();
        await EnableAsync(hub);
        var (chain, privateKey) = WebHubTests.SelfSigned(Domain);
        await hub.InvokeAsync<CertificateUploadResult>(nameof(ICoreHub.UploadCertificate), new CertificateUploadRequest(CoreDomainSettings.SiteId, chain, privateKey), Cancel);
        var before = store.Read();
        Assert.Contains("optional_no_ca", nginx.Text(SiteFile), StringComparison.Ordinal);

        var proxied = await EnableAsync(hub, mode: CoreDomainMode.Cloudflare);
        var proxiedFile = nginx.Text(SiteFile)!;
        var back = await EnableAsync(hub);

        Assert.True(proxied.SiteApplied);
        Assert.Equal(CoreDomainMode.Cloudflare, proxied.Mode);
        Assert.Equal((before.Port, before.Key), (store.Read().Port, store.Read().Key));
        Assert.DoesNotContain("optional_no_ca", proxiedFile, StringComparison.Ordinal);
        Assert.Equal(CoreDomainMode.Direct, back.Mode);
        Assert.Contains("optional_no_ca", nginx.Text(SiteFile), StringComparison.Ordinal);
        Assert.True(back.SiteApplied);
    }

    [Fact]
    public async Task Turning_it_off_takes_the_site_out_and_closes_the_port()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: true);
        await WebHubTests.SetUpNginxAsync(harness, hub);
        await EnableAsync(hub);
        var store = harness.Services.GetRequiredService<CoreDomainStore>();
        var port = store.Read().Port;

        var status = await hub.InvokeAsync<CoreDomainStatus>(nameof(ICoreHub.DisableCoreDomain), Cancel);

        Assert.False(status.Enabled);
        Assert.False(status.Listening);
        Assert.Null(status.Error);
        Assert.Equal(Domain, status.Domain);
        Assert.Null(store.Read().Key);
        Assert.False(harness.Services.GetRequiredService<ICoreDomainBinding>().IsListening(port));
        Assert.Null(harness.Services.GetRequiredService<SimulatedNginxMachine>().Text(SiteFile));
        Assert.Equal(["coreDomain.enable:success", "coreDomain.disable:success"], await AuditAsync(harness));
    }
}
