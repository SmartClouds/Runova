using System.Globalization;
using System.Runtime.CompilerServices;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Nginx;
using Runova.ServerCore.Security;
using Runova.ServerCore.Traffic;

namespace Runova.ServerCore.Hubs;

/// <summary>
/// Website traffic (E109) and attacks (E110). Every role reads reports and attacks. Admins change
/// statistics and detection, block and unblock. Auto-block lets the core cut visitors off by itself,
/// so it is an Owner's call with a step-up. Every change is audited with what was set; nothing here
/// is a secret.
/// </summary>
internal sealed partial class CoreHub
{
    /// <summary>How often the live view goes out.</summary>
    public static readonly TimeSpan TrafficLiveEvery = TimeSpan.FromSeconds(5);

    [Authorize(Policy = CorePolicies.Viewer)]
    public Task<TrafficStatus> GetTrafficStatus() => traffic.Manager.StatusAsync(Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Viewer)]
    public async Task<TrafficReport> GetTrafficReport(TrafficReportRequest request)
    {
        if (request is null || (request.SiteId is not null && !NginxValidator.IsId(request.SiteId)))
        {
            throw new HubException("There is no such site.");
        }

        await traffic.Manager.EnsureLoadedAsync(Context.ConnectionAborted);
        var config = traffic.Manager.Current;
        try
        {
            return await traffic.Store.ReportAsync(request, config.Zone, config.Statistics.Enabled, config.EnabledAt, Context.ConnectionAborted);
        }
        catch (ArgumentException refused)
        {
            throw new HubException(refused.Message);
        }
    }

    [Authorize(Policy = CorePolicies.Viewer)]
    public async Task<TrafficDimensionPage> GetTrafficDimension(TrafficDimensionRequest request)
    {
        if (request is null || (request.SiteId is not null && !NginxValidator.IsId(request.SiteId)))
        {
            throw new HubException("There is no such site.");
        }

        await traffic.Manager.EnsureLoadedAsync(Context.ConnectionAborted);
        try
        {
            return await traffic.Store.DimensionAsync(request, traffic.Manager.Current.Zone, Context.ConnectionAborted);
        }
        catch (ArgumentException refused)
        {
            throw new HubException(refused.Message);
        }
    }

    [Authorize(Policy = CorePolicies.Viewer)]
    public async IAsyncEnumerable<TrafficLive> StreamTrafficLive(
        TrafficLiveRequest request,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        using var lease = traffic.Streams.Open(Context.ConnectionId, StreamLimits.TrafficLive);
        if (request is null || (request.SiteId is not null && !NginxValidator.IsId(request.SiteId)))
        {
            throw new HubException("There is no such site.");
        }

        while (!cancellationToken.IsCancellationRequested)
        {
            yield return traffic.Live.Snapshot(request.SiteId);
            await Task.Delay(TrafficLiveEvery, time, cancellationToken);
        }
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<TrafficSaveResult> SaveTrafficSettings(TrafficSettings settings)
    {
        var result = await traffic.Manager.SaveTrafficAsync(settings, Caller.UserName, Context.ConnectionAborted);
        var parameters = new Dictionary<string, string?>
        {
            ["enabled"] = settings?.Enabled.ToString(),
            ["countries"] = settings?.Countries.ToString(),
            ["excludedSites"] = settings?.ExcludedSites is { } excluded ? string.Join(',', excluded) : null,
            ["hourlyRetentionDays"] = settings?.HourlyRetentionDays.ToString(CultureInfo.InvariantCulture),
            ["dailyRetentionDays"] = settings?.DailyRetentionDays.ToString(CultureInfo.InvariantCulture),
            ["timeZone"] = settings?.TimeZone,
            ["readExistingLogs"] = settings?.ReadExistingLogs.ToString(),
        };
        await AuditTrafficAsync("traffic.save", result.Problems, null, parameters);
        return result;
    }

    [Authorize(Policy = CorePolicies.Admin)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<TrafficStatus> DeleteTrafficData(string? siteId)
    {
        if (siteId is not null && !NginxValidator.IsId(siteId))
        {
            throw new HubException("There is no such site.");
        }

        var status = await traffic.Manager.DeleteAsync(siteId, Context.ConnectionAborted);
        await AuditAsync("traffic.delete", AuditResult.Success, siteId ?? "all");
        return status;
    }

    [Authorize(Policy = CorePolicies.Viewer)]
    public async Task<AttackSummary> ListAttacks(AttackQuery query)
    {
        if (query is null || (query.SiteId is not null && !NginxValidator.IsId(query.SiteId)))
        {
            throw new HubException("There is no such site.");
        }

        await traffic.Manager.EnsureLoadedAsync(Context.ConnectionAborted);
        try
        {
            return await traffic.Attacks.ListAsync(query, traffic.Manager.Current.Zone, Context.ConnectionAborted);
        }
        catch (ArgumentException refused)
        {
            throw new HubException(refused.Message);
        }
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<TrafficSaveResult> SaveAttackSettings(AttackSettings settings)
    {
        var result = await traffic.Manager.SaveAttacksAsync(settings, Caller.UserName, Context.ConnectionAborted);
        var thresholds = settings?.Thresholds;
        var parameters = new Dictionary<string, string?>
        {
            ["enabled"] = settings?.Enabled.ToString(),
            ["thresholds"] = thresholds is null
                ? null
                : string.Create(CultureInfo.InvariantCulture, $"scan {thresholds.ScanProbes}/{thresholds.ScanNotFound} in {thresholds.ScanWindowMinutes}m, brute force {thresholds.BruteForceAttempts} in {thresholds.BruteForceWindowMinutes}m, flood {thresholds.FloodRequestsPerMinute}/m, injection {thresholds.InjectionHits} in {thresholds.InjectionWindowMinutes}m"),
            ["allowlist"] = settings?.Allowlist is { } allowlist ? string.Join(',', allowlist) : null,
            ["eventRetentionDays"] = settings?.EventRetentionDays.ToString(CultureInfo.InvariantCulture),
        };
        await AuditTrafficAsync("attacks.save", result.Problems, null, parameters);
        return result;
    }

    [Authorize(Policy = CorePolicies.Owner)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<TrafficSaveResult> SaveAutoBlock(AutoBlockSettings settings)
    {
        var result = await traffic.Manager.SaveAutoBlockAsync(settings, Caller.UserName, Context.ConnectionAborted);
        var parameters = new Dictionary<string, string?>
        {
            ["enabled"] = settings?.Enabled.ToString(),
            ["kinds"] = settings?.Kinds is { } kinds ? string.Join(',', kinds) : null,
            ["minutes"] = settings?.Minutes.ToString(CultureInfo.InvariantCulture),
            ["maxBlocked"] = settings?.MaxBlocked.ToString(CultureInfo.InvariantCulture),
        };
        await AuditTrafficAsync("autoblock.save", result.Problems, null, parameters);
        return result;
    }

    [Authorize(Policy = CorePolicies.Viewer)]
    public Task<BlockedAddressInfo[]> ListBlockedAddresses() => traffic.Blocks.ListAsync(Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<BlockAddressResult> BlockAddress(BlockAddressRequest request)
    {
        var caller = await traffic.App.OfAsync(Context, Context.ConnectionAborted);
        var result = await traffic.Blocks.BlockAsync(request, Caller.UserName, caller, Context.ConnectionAborted);
        var parameters = new Dictionary<string, string?>
        {
            ["reason"] = request?.Reason,
            ["minutes"] = request?.Minutes?.ToString(CultureInfo.InvariantCulture),
            ["siteId"] = request?.SiteId,
        };
        await AuditTrafficAsync("address.block", result.Problems, result.Blocked?.Network ?? request?.Network, parameters);
        return result;
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task UnblockAddress(long blockId)
    {
        string? network;
        try
        {
            network = await traffic.Blocks.UnblockAsync(blockId, Context.ConnectionAborted);
        }
        catch (InvalidOperationException refused)
        {
            await AuditAsync("address.unblock", AuditResult.Failed, blockId.ToString(CultureInfo.InvariantCulture), new() { ["reason"] = refused.Message });
            throw new HubException(refused.Message);
        }

        if (network is null)
        {
            await AuditAsync("address.unblock", AuditResult.Failed, blockId.ToString(CultureInfo.InvariantCulture), new() { ["reason"] = "There is no such block." });
            throw new HubException("There is no such block.");
        }

        await AuditAsync("address.unblock", AuditResult.Success, network);
    }

    private Task AuditTrafficAsync(string action, string[] problems, string? target, Dictionary<string, string?> parameters)
    {
        if (problems.Length > 0)
        {
            parameters["reason"] = string.Join(' ', problems);
        }

        return AuditAsync(action, problems.Length == 0 ? AuditResult.Success : AuditResult.Denied, target, parameters);
    }
}
