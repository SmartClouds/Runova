using System.Net;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Cloudflare;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Firewall;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Nginx;
using Runova.ServerCore.Security;
using Runova.ServerCore.Tests.Web;
using static Runova.ServerCore.Tests.FirewallTestData;

namespace Runova.ServerCore.Tests.Cloudflare;

/// <summary>
/// E95 through the hub. Setting the tunnel up installs and connects cloudflared without touching
/// the firewall; closing the web ports is a change set refused until the tunnel is connected and
/// kept only once confirmed; SSH is limited over the way in that remains, so the lockout guard
/// checks exactly that; turning off opens everything again and stops cloudflared once confirmed;
/// and the token never comes back from the core, in a status, a job or the audit trail.
/// </summary>
public sealed class HubCloudflareTunnelTests
{
    private static readonly Guid _tunnel = Guid.Parse("c1744f8b-faa1-48a4-9e5c-02ac921467fa");

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static async Task<(AuthHarness Harness, HubConnection Hub)> StartAsync(string role = CoreRoles.Owner)
    {
        var harness = await AuthHarness.CreateAsync(role);
        harness.Services.GetRequiredService<FakeFirewallBackend>().State = Ufw(rules: [Allow(22), Allow(80), Allow(443)]);
        var hub = await WebHubTests.ConnectAsync(harness);
        await WebHubTests.SetUpNginxAsync(harness, hub);
        Assert.Empty((await hub.InvokeAsync<SiteSaveResult>(nameof(ICoreHub.SaveSite), WebHubTests.Blog(), Cancel)).Problems);
        return (harness, hub);
    }

    private static CloudflareTunnelSetup Setup(string? sshHostname = "ssh.example.com") =>
        new(_tunnel.ToString(), "runova-devhost", CloudflaredSetupTests.Token(_tunnel), sshHostname);

    private static async Task<JobInfo> SetUpAsync(AuthHarness harness, HubConnection hub, CloudflareTunnelSetup? setup = null)
    {
        var job = await hub.InvokeAsync<JobInfo>(nameof(ICoreHub.StartCloudflareTunnel), setup ?? Setup(), Cancel);
        return await harness.Services.GetRequiredService<JobEngine>().WhenFinishedAsync(job.Id, Cancel).WaitAsync(TimeSpan.FromSeconds(30), Cancel);
    }

    private static Task<CloudflareTunnelStatus> StatusAsync(HubConnection hub) =>
        hub.InvokeAsync<CloudflareTunnelStatus>(nameof(ICoreHub.GetCloudflareTunnel), Cancel);

    /// <summary>Confirms over a new connection, as the app does over a new SSH login.</summary>
    private static async Task ConfirmAsync(AuthHarness harness, Guid changeSetId)
    {
        await using var fresh = await WebHubTests.ConnectAsync(harness);
        var confirmed = await fresh.InvokeAsync<FirewallChangeSetInfo>(nameof(ICoreHub.ConfirmFirewallChanges), changeSetId, Cancel);
        Assert.Equal(FirewallChangeState.Confirmed, confirmed.State);
    }

    private static async Task CloseWebAsync(AuthHarness harness, HubConnection hub)
    {
        var closed = await hub.InvokeAsync<CloudflareTunnelResult>(nameof(ICoreHub.CloseCloudflareTunnelPorts), new CloudflareTunnelFirewallRequest(), Cancel);
        await ConfirmAsync(harness, closed.ChangeSet!.Id);
    }

    private static bool Reaches(AuthHarness harness, IPAddress address, int port) =>
        FirewallEvaluation.Evaluate(harness.Services.GetRequiredService<FakeFirewallBackend>().State, new Probe(address, port, FirewallProtocol.Tcp)).Allowed;

    private static bool Reaches(AuthHarness harness, string address, int port) => Reaches(harness, IPAddress.Parse(address), port);

    private static string Nginx(AuthHarness harness, string path) =>
        harness.Services.GetRequiredService<SimulatedNginxMachine>().Text($"/etc/nginx/runova/current/{path}") ?? string.Empty;

    [Fact]
    public async Task Setting_up_connects_cloudflared_and_adds_the_listener_without_touching_the_firewall()
    {
        var (harness, hub) = await StartAsync();
        await using var _ = harness;
        await using var __ = hub;
        var before = harness.Services.GetRequiredService<FakeFirewallBackend>().State;

        var job = await SetUpAsync(harness, hub);
        var status = await StatusAsync(hub);

        Assert.Equal(JobState.Succeeded, job.State);
        Assert.Equal(CloudflareTunnelState.PortsOpen, status.State);
        Assert.Equal(4, status.Connections);
        Assert.Equal(_tunnel.ToString(), status.TunnelId);
        Assert.Equal("ssh.example.com", status.SshHostname);
        Assert.Equal(CloudflaredSetupTests.Token(_tunnel), harness.Services.GetRequiredService<FakeCloudflared>().Token);
        Assert.Same(before, harness.Services.GetRequiredService<FakeFirewallBackend>().State);
        Assert.Contains($"listen 127.0.0.2:{status.TunnelPort};", Nginx(harness, "sites/blog.conf"), StringComparison.Ordinal);
        Assert.Contains("set_real_ip_from 127.0.0.0/8;", Nginx(harness, NginxCloudflare.TunnelRealIpFile), StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_token_never_comes_back_or_reaches_the_audit_trail()
    {
        var (harness, hub) = await StartAsync();
        await using var _ = harness;
        await using var __ = hub;
        var token = CloudflaredSetupTests.Token(_tunnel);

        await SetUpAsync(harness, hub);
        var status = await StatusAsync(hub);

        Assert.DoesNotContain(token, System.Text.Json.JsonSerializer.Serialize(status), StringComparison.Ordinal);
        await using var scope = harness.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
        var audit = await db.AuditEvents.Where(e => e.Action.StartsWith("cloudflare.tunnel")).ToListAsync(Cancel);
        Assert.NotEmpty(audit);
        Assert.DoesNotContain(audit, e => System.Text.Json.JsonSerializer.Serialize(e).Contains(token, StringComparison.Ordinal));
        var row = await db.CloudflareTunnel.SingleAsync(Cancel);
        Assert.NotEqual(token, row.ProtectedToken);
    }

    [Fact]
    public async Task An_nginx_that_is_not_set_up_for_runova_is_refused_before_anything_is_saved()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner);
        await using var hub = await WebHubTests.ConnectAsync(harness);

        var refused = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<JobInfo>(nameof(ICoreHub.StartCloudflareTunnel), Setup(), Cancel));

        Assert.Contains("not set up for Runova", refused.Message, StringComparison.Ordinal);
        Assert.Equal(CloudflareTunnelState.Off, (await StatusAsync(hub)).State);
        Assert.Null(harness.Services.GetRequiredService<FakeCloudflared>().Token);
    }

    [Fact]
    public async Task A_token_for_another_tunnel_is_refused_and_nothing_is_saved()
    {
        var (harness, hub) = await StartAsync();
        await using var _ = harness;
        await using var __ = hub;

        var refused = await Assert.ThrowsAsync<HubException>(() =>
            hub.InvokeAsync<JobInfo>(nameof(ICoreHub.StartCloudflareTunnel), Setup() with { Token = CloudflaredSetupTests.Token(Guid.NewGuid()) }, Cancel));

        Assert.Contains("another tunnel", refused.Message, StringComparison.Ordinal);
        Assert.Equal(CloudflareTunnelState.Off, (await StatusAsync(hub)).State);
    }

    [Fact]
    public async Task A_tunnel_that_does_not_connect_fails_the_job_and_keeps_the_ports_open()
    {
        var (harness, hub) = await StartAsync();
        await using var _ = harness;
        await using var __ = hub;
        harness.Services.GetRequiredService<FakeCloudflared>().Connected = false;

        var job = await hub.InvokeAsync<JobInfo>(nameof(ICoreHub.StartCloudflareTunnel), Setup(), Cancel);
        var engine = harness.Services.GetRequiredService<JobEngine>();
        var finishing = engine.WhenFinishedAsync(job.Id, Cancel);
        while (!finishing.IsCompleted)
        {
            harness.Clock!.Advance(TimeSpan.FromSeconds(5));
            await Task.Delay(20, Cancel);
        }

        var finished = await finishing;
        var refused = await Assert.ThrowsAsync<HubException>(() =>
            hub.InvokeAsync<CloudflareTunnelResult>(nameof(ICoreHub.CloseCloudflareTunnelPorts), new CloudflareTunnelFirewallRequest(), Cancel));
        var status = await StatusAsync(hub);

        Assert.Equal(JobState.Failed, finished.State);
        Assert.Contains("did not connect", finished.Error, StringComparison.Ordinal);
        Assert.Equal(CloudflareTunnelState.Failed, status.State);
        Assert.Contains("not connected", refused.Message, StringComparison.Ordinal);
        Assert.True(Reaches(harness, "198.51.100.7", 443));
    }

    [Fact]
    public async Task Closing_the_web_ports_waits_for_confirmation_then_nothing_outside_reaches_them()
    {
        var (harness, hub) = await StartAsync();
        await using var _ = harness;
        await using var __ = hub;
        await SetUpAsync(harness, hub);
        await using (var scope = harness.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
            db.OriginLock.Add(new OriginLockSetting { Enabled = true });
            await db.SaveChangesAsync(Cancel);
        }

        var preview = await hub.InvokeAsync<CloudflareTunnelPreview>(nameof(ICoreHub.PreviewCloudflareTunnelPorts), new CloudflareTunnelFirewallRequest(), Cancel);
        var closed = await hub.InvokeAsync<CloudflareTunnelResult>(nameof(ICoreHub.CloseCloudflareTunnelPorts), new CloudflareTunnelFirewallRequest(), Cancel);

        Assert.Equal(2, preview.Changes.Length);
        Assert.False(preview.Firewall!.Guard.Blocked);
        Assert.Equal(CloudflareTunnelState.Pending, closed.Status.State);

        await ConfirmAsync(harness, closed.ChangeSet!.Id);
        var status = await StatusAsync(hub);

        Assert.Equal(CloudflareTunnelState.Connected, status.State);
        Assert.Empty(status.OpenRules);
        Assert.False(Reaches(harness, "198.51.100.7", 80));
        Assert.False(Reaches(harness, "198.51.100.7", 443));
        Assert.False(Reaches(harness, App, 443));
        Assert.True(Reaches(harness, App, 22));
        Assert.False((await hub.InvokeAsync<OriginLockStatus>(nameof(ICoreHub.GetOriginLock), Cancel)).Enabled);
    }

    [Fact]
    public async Task Cloudflare_only_ssh_from_this_computers_own_address_is_stopped_by_the_lockout_guard()
    {
        var (harness, hub) = await StartAsync();
        await using var _ = harness;
        await using var __ = hub;
        await SetUpAsync(harness, hub);
        await CloseWebAsync(harness, hub);

        var refused = await Assert.ThrowsAsync<HubException>(() =>
            hub.InvokeAsync<CloudflareTunnelResult>(nameof(ICoreHub.ApplyTunnelSsh), new TunnelSshRequest(TunnelSshMode.Cloudflare), Cancel));

        Assert.Contains("cut this computer off from SSH", refused.Message, StringComparison.Ordinal);
        Assert.True(Reaches(harness, App, 22));
    }

    [Fact]
    public async Task Cloudflare_only_ssh_applied_through_the_tunnel_leaves_ssh_to_loopback_alone()
    {
        var (harness, hub) = await StartAsync();
        await using var _ = harness;
        await using var __ = hub;
        await SetUpAsync(harness, hub);
        await CloseWebAsync(harness, hub);
        harness.Services.GetRequiredService<FakeCallerConnections>().Client = IPAddress.Loopback;
        await using var tunneled = await WebHubTests.ConnectAsync(harness);

        var applied = await tunneled.InvokeAsync<CloudflareTunnelResult>(nameof(ICoreHub.ApplyTunnelSsh), new TunnelSshRequest(TunnelSshMode.Cloudflare), Cancel);
        await ConfirmAsync(harness, applied.ChangeSet!.Id);
        var status = await StatusAsync(hub);

        Assert.Equal(TunnelSshMode.Cloudflare, status.SshMode);
        Assert.Equal(CloudflareTunnelState.Connected, status.State);
        Assert.False(Reaches(harness, App, 22));
        Assert.True(Reaches(harness, IPAddress.Loopback, 22));
    }

    [Fact]
    public async Task Closing_ssh_is_for_an_owner_and_only_over_the_core_domain()
    {
        var (admin, adminHub) = await StartAsync(CoreRoles.Admin);
        await using var _ = admin;
        await using var __ = adminHub;
        await SetUpAsync(admin, adminHub);
        await CloseWebAsync(admin, adminHub);

        var notOwner = await Assert.ThrowsAsync<HubException>(() =>
            adminHub.InvokeAsync<CloudflareTunnelResult>(nameof(ICoreHub.ApplyTunnelSsh), new TunnelSshRequest(TunnelSshMode.Closed), Cancel));

        var (owner, ownerHub) = await StartAsync();
        await using var ___ = owner;
        await using var ____ = ownerHub;
        await SetUpAsync(owner, ownerHub);
        await CloseWebAsync(owner, ownerHub);
        var overSsh = await Assert.ThrowsAsync<HubException>(() =>
            ownerHub.InvokeAsync<CloudflareTunnelResult>(nameof(ICoreHub.ApplyTunnelSsh), new TunnelSshRequest(TunnelSshMode.Closed), Cancel));

        Assert.Contains("Only an Owner", notOwner.Message, StringComparison.Ordinal);
        Assert.Contains("core domain", overSsh.Message, StringComparison.Ordinal);
        Assert.True(Reaches(owner, App, 22));
    }

    [Fact]
    public async Task Mesh_ssh_needs_the_server_on_the_mesh_first()
    {
        var (harness, hub) = await StartAsync();
        await using var _ = harness;
        await using var __ = hub;
        await SetUpAsync(harness, hub);
        await CloseWebAsync(harness, hub);

        var refused = await Assert.ThrowsAsync<HubException>(() =>
            hub.InvokeAsync<CloudflareTunnelPreview>(nameof(ICoreHub.PreviewTunnelSsh), new TunnelSshRequest(TunnelSshMode.Mesh), Cancel));

        Assert.Contains("Mesh node", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Mesh_ssh_applied_over_mesh_lets_only_the_mesh_in()
    {
        var (harness, hub) = await StartAsync();
        await using var _ = harness;
        await using var __ = hub;
        await SetUpAsync(harness, hub);
        await CloseWebAsync(harness, hub);
        var node = Guid.NewGuid();

        var join = await hub.InvokeAsync<JobInfo>(nameof(ICoreHub.JoinCloudflareMesh), new CloudflareMeshJoin(node.ToString(), CloudflaredSetupTests.Token(node)), Cancel);
        var joined = await harness.Services.GetRequiredService<JobEngine>().WhenFinishedAsync(join.Id, Cancel).WaitAsync(TimeSpan.FromSeconds(30), Cancel);
        harness.Services.GetRequiredService<FakeCallerConnections>().Client = IPAddress.Parse("100.96.0.40");
        await using var overMesh = await WebHubTests.ConnectAsync(harness);
        var applied = await overMesh.InvokeAsync<CloudflareTunnelResult>(nameof(ICoreHub.ApplyTunnelSsh), new TunnelSshRequest(TunnelSshMode.Mesh), Cancel);
        await ConfirmAsync(harness, applied.ChangeSet!.Id);
        var status = await StatusAsync(hub);

        Assert.Equal(JobState.Succeeded, joined.State);
        Assert.Equal("100.96.0.12", status.MeshAddress);
        Assert.Equal(TunnelSshMode.Mesh, status.SshMode);
        Assert.Equal(CloudflareTunnelState.Connected, status.State);
        Assert.True(Reaches(harness, "100.96.0.40", 22));
        Assert.False(Reaches(harness, App, 22));
    }

    [Fact]
    public async Task Turning_off_opens_everything_again_and_stops_cloudflared_once_confirmed()
    {
        var (harness, hub) = await StartAsync();
        await using var _ = harness;
        await using var __ = hub;
        await SetUpAsync(harness, hub);
        await CloseWebAsync(harness, hub);
        var cloudflared = harness.Services.GetRequiredService<FakeCloudflared>();

        var off = await hub.InvokeAsync<CloudflareTunnelResult>(nameof(ICoreHub.TurnOffCloudflareTunnel), new CloudflareTunnelOffRequest(), Cancel);

        Assert.True(cloudflared.Running);
        Assert.Equal(CloudflareTunnelState.Pending, off.Status.State);

        await ConfirmAsync(harness, off.ChangeSet!.Id);
        var status = await StatusAsync(hub);

        Assert.Equal(CloudflareTunnelState.Off, status.State);
        Assert.False(cloudflared.Running);
        Assert.Null(cloudflared.Token);
        Assert.True(Reaches(harness, "198.51.100.7", 80));
        Assert.True(Reaches(harness, "198.51.100.7", 443));
        Assert.True(Reaches(harness, App, 22));
        Assert.DoesNotContain("127.0.0.2", Nginx(harness, "sites/blog.conf"), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Break_glass_is_the_owners_and_stays_off_until_turned_on()
    {
        var (admin, adminHub) = await StartAsync(CoreRoles.Admin);
        await using var _ = admin;
        await using var __ = adminHub;

        await Assert.ThrowsAnyAsync<HubException>(() =>
            adminHub.InvokeAsync<CloudflareTunnelStatus>(nameof(ICoreHub.SetTunnelBreakGlass), new TunnelBreakGlassRequest(true, 30), Cancel));
        var status = await StatusAsync(adminHub);

        Assert.False(status.BreakGlassEnabled);
        Assert.Equal(30, status.BreakGlassDelayMinutes);
    }

    [Fact]
    public async Task With_break_glass_on_a_tunnel_down_past_the_delay_opens_ssh_and_its_return_closes_it()
    {
        var (harness, hub) = await StartAsync();
        await using var _ = harness;
        await using var __ = hub;
        await SetUpAsync(harness, hub);
        await CloseWebAsync(harness, hub);
        harness.Services.GetRequiredService<FakeCallerConnections>().Client = IPAddress.Loopback;
        await using (var tunneled = await WebHubTests.ConnectAsync(harness))
        {
            var applied = await tunneled.InvokeAsync<CloudflareTunnelResult>(nameof(ICoreHub.ApplyTunnelSsh), new TunnelSshRequest(TunnelSshMode.Cloudflare), Cancel);
            await ConfirmAsync(harness, applied.ChangeSet!.Id);
        }

        await hub.InvokeAsync<CloudflareTunnelStatus>(nameof(ICoreHub.SetTunnelBreakGlass), new TunnelBreakGlassRequest(true, 10), Cancel);
        var service = harness.Services.GetRequiredService<CloudflareTunnelService>();
        var cloudflared = harness.Services.GetRequiredService<FakeCloudflared>();
        var clock = harness.Clock!;

        cloudflared.Connected = false;
        await service.TickAsync(Cancel);
        clock.Advance(TimeSpan.FromMinutes(9));
        await service.TickAsync(Cancel);
        var stillClosed = Reaches(harness, App, 22);
        var down = await StatusAsync(hub);
        clock.Advance(TimeSpan.FromMinutes(2));
        await service.TickAsync(Cancel);
        var opened = Reaches(harness, App, 22);

        cloudflared.Connected = true;
        await service.TickAsync(Cancel);
        clock.Advance(TimeSpan.FromMinutes(6));
        await service.TickAsync(Cancel);
        var status = await StatusAsync(hub);

        Assert.False(stillClosed);
        Assert.Equal(CloudflareTunnelState.Down, down.State);
        Assert.True(opened);
        Assert.False(Reaches(harness, App, 22));
        Assert.False(status.BreakGlassOpen);
        Assert.Equal(CloudflareTunnelState.Connected, status.State);
    }
}
