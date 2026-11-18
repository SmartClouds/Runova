using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Nginx;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests.Traffic;

/// <summary>
/// E109 T7 and E110 T5 through the hub: every role reads, Admins change statistics and detection
/// and block, deleting statistics needs a step-up, auto-block is an Owner's call with a step-up,
/// nobody can block the address they are connected from, and every change is audited.
/// </summary>
public sealed class HubTrafficTests
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static TrafficSettings On => new(true, true, [], 90, 730, "UTC");

    private static async Task<HubConnection> ConnectAsync(AuthHarness harness, bool stepUp)
    {
        var signedIn = await harness.SignInAsync();
        var hub = harness.Hub(signedIn.AccessToken);
        await hub.StartAsync(Cancel);
        if (stepUp)
        {
            await hub.InvokeAsync<StepUpResponse>(nameof(ICoreHub.StepUp), new StepUpRequest(AuthHarness.Password), Cancel);
        }

        return hub;
    }

    private static async Task<List<string>> AuditAsync(AuthHarness harness)
    {
        await using var scope = harness.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<CoreDbContext>().AuditEvents
            .Where(e => e.Action.StartsWith("traffic.") || e.Action.StartsWith("attacks.") || e.Action.StartsWith("autoblock.") || e.Action.StartsWith("address."))
            .OrderBy(e => e.Id)
            .Select(e => e.Action + ":" + e.Result)
            .ToListAsync(Cancel);
    }

    private static TrafficReportRequest Today => new(null, DateTimeOffset.UtcNow.AddDays(-1).ToUnixTimeMilliseconds(), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), TrafficGranularity.Day);

    [Fact]
    public async Task A_viewer_reads_everything_and_changes_nothing()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Viewer, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: true);

        var status = await hub.InvokeAsync<TrafficStatus>(nameof(ICoreHub.GetTrafficStatus), Cancel);
        var report = await hub.InvokeAsync<TrafficReport>(nameof(ICoreHub.GetTrafficReport), Today, Cancel);
        var page = await hub.InvokeAsync<TrafficDimensionPage>(nameof(ICoreHub.GetTrafficDimension), new TrafficDimensionRequest(null, Today.FromUnixMs, Today.ToUnixMs, TrafficDimension.Page), Cancel);
        var attacks = await hub.InvokeAsync<AttackSummary>(nameof(ICoreHub.ListAttacks), new AttackQuery(null), Cancel);
        var blocked = await hub.InvokeAsync<BlockedAddressInfo[]>(nameof(ICoreHub.ListBlockedAddresses), Cancel);
        var refusals = new[]
        {
            await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<TrafficSaveResult>(nameof(ICoreHub.SaveTrafficSettings), On, Cancel)),
            await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<TrafficSaveResult>(nameof(ICoreHub.SaveAttackSettings), status.Attacks, Cancel)),
            await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<TrafficSaveResult>(nameof(ICoreHub.SaveAutoBlock), status.AutoBlock, Cancel)),
            await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<TrafficStatus>(nameof(ICoreHub.DeleteTrafficData), null, Cancel)),
            await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<BlockAddressResult>(nameof(ICoreHub.BlockAddress), new BlockAddressRequest("198.51.100.7"), Cancel)),
            await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync(nameof(ICoreHub.UnblockAddress), 1L, Cancel)),
        };

        Assert.False(status.Settings.Enabled);
        Assert.Equal(168, report.HourOfWeek.Length);
        Assert.Empty(page.Items);
        Assert.Empty(attacks.Events);
        Assert.Empty(blocked);
        Assert.All(refusals, refused => Assert.Contains("unauthorized", refused.Message, StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task An_admin_turns_statistics_on_and_detection_with_them_and_it_is_audited()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: false);

        var refused = await hub.InvokeAsync<TrafficSaveResult>(nameof(ICoreHub.SaveTrafficSettings), On with { HourlyRetentionDays = 1 }, Cancel);
        var saved = await hub.InvokeAsync<TrafficSaveResult>(nameof(ICoreHub.SaveTrafficSettings), On, Cancel);
        var attacks = await hub.InvokeAsync<TrafficSaveResult>(nameof(ICoreHub.SaveAttackSettings), saved.Status!.Attacks with { Allowlist = ["203.0.113.0/24"] }, Cancel);
        var noAutoBlock = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<TrafficSaveResult>(nameof(ICoreHub.SaveAutoBlock), saved.Status.AutoBlock with { Enabled = true }, Cancel));
        var noDelete = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<TrafficStatus>(nameof(ICoreHub.DeleteTrafficData), null, Cancel));

        Assert.NotEmpty(refused.Problems);
        Assert.True(saved.Status.Settings.Enabled);
        Assert.True(saved.Status.Attacks.Enabled);
        Assert.Equal(["203.0.113.0/24"], attacks.Status!.Attacks.Allowlist);
        Assert.Contains("unauthorized", noAutoBlock.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("unauthorized", noDelete.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(["traffic.save:denied", "traffic.save:success", "attacks.save:success"], await AuditAsync(harness));
    }

    [Fact]
    public async Task An_owner_turns_auto_block_on_after_a_step_up_and_deletes_statistics()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: true);

        var saved = await hub.InvokeAsync<TrafficSaveResult>(nameof(ICoreHub.SaveAutoBlock), new AutoBlockSettings(true, [AttackKind.Scan], 30, 100), Cancel);
        var deleted = await hub.InvokeAsync<TrafficStatus>(nameof(ICoreHub.DeleteTrafficData), "app", Cancel);

        Assert.Empty(saved.Problems);
        Assert.True(saved.Status!.AutoBlock.Enabled);
        Assert.NotNull(deleted);
        Assert.Equal(["autoblock.save:success", "traffic.delete:success"], await AuditAsync(harness));
    }

    [Fact]
    public async Task Blocking_refuses_the_callers_own_address_blocks_another_and_lets_it_back()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: false);
        var machine = harness.Services.GetRequiredService<SimulatedNginxMachine>();

        var own = await hub.InvokeAsync<BlockAddressResult>(nameof(ICoreHub.BlockAddress), new BlockAddressRequest(FirewallTestData.App.ToString()), Cancel);
        var other = await hub.InvokeAsync<BlockAddressResult>(nameof(ICoreHub.BlockAddress), new BlockAddressRequest("198.51.100.7", "Scanning", 60), Cancel);
        var listed = await hub.InvokeAsync<BlockedAddressInfo[]>(nameof(ICoreHub.ListBlockedAddresses), Cancel);
        await hub.InvokeAsync(nameof(ICoreHub.UnblockAddress), other.Blocked!.Id, Cancel);
        var missing = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync(nameof(ICoreHub.UnblockAddress), other.Blocked.Id, Cancel));

        Assert.Contains("you are connected from", Assert.Single(own.Problems), StringComparison.Ordinal);
        Assert.Equal("198.51.100.7", Assert.Single(listed).Network);
        Assert.DoesNotContain("198.51.100.7", machine.Text(NginxLayout.Debian.BlockListFile), StringComparison.Ordinal);
        Assert.Contains("no such block", missing.Message, StringComparison.Ordinal);
        Assert.Equal(["address.block:denied", "address.block:success", "address.unblock:success", "address.unblock:failed"], await AuditAsync(harness));
    }

    [Fact]
    public async Task A_report_the_core_cannot_make_says_why()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Viewer, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: false);

        var backwards = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<TrafficReport>(nameof(ICoreHub.GetTrafficReport), Today with { FromUnixMs = Today.ToUnixMs + 1 }, Cancel));
        var badSite = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<TrafficReport>(nameof(ICoreHub.GetTrafficReport), Today with { SiteId = "../etc" }, Cancel));

        Assert.Contains("range", backwards.Message, StringComparison.Ordinal);
        Assert.Contains("no such site", badSite.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_live_view_streams()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Viewer, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: false);

        await foreach (var live in hub.StreamAsync<TrafficLive>(nameof(ICoreHub.StreamTrafficLive), new TrafficLiveRequest("app"), Cancel))
        {
            Assert.Equal(0, live.VisitorsNow);
            Assert.Empty(live.PagesNow);
            break;
        }
    }
}
