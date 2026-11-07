using System.Security.Cryptography;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Data;
using Runova.Website.Data.Monitoring;

namespace Runova.Website.Api.CloudMonitoring;

/// <summary>Seals a monitor's access key. Only a node about to check it ever sees it opened.</summary>
internal sealed class CloudMonitorSecrets(IDataProtectionProvider provider)
{
    public const string Purpose = "Runova.CloudMonitorSecret.v1";

    private readonly IDataProtector _protector = provider.CreateProtector(Purpose);

    public string Seal(string secret) => _protector.Protect(secret);

    /// <summary>The key, or null when there is none or it can not be opened (the key ring lost it).</summary>
    public string? Open(string? sealedSecret)
    {
        if (string.IsNullOrEmpty(sealedSecret))
        {
            return null;
        }

        try
        {
            return _protector.Unprotect(sealedSecret);
        }
        catch (CryptographicException)
        {
            return null;
        }
    }
}

/// <summary>Reads monitors the way the pages show them: with their status, open incident and uptime.</summary>
internal sealed class CloudMonitorViews(AppDbContext db, TimeProvider time)
{
    public async Task<IReadOnlyList<CloudMonitorDto>> ListAsync(
        IQueryable<CloudMonitor> monitors, long userId, IReadOnlyDictionary<long, bool> canWrite, CancellationToken ct = default)
    {
        var rows = await monitors.AsNoTracking().OrderBy(m => m.ProjectName).ThenBy(m => m.EnvironmentName).ThenBy(m => m.Name).ThenBy(m => m.Id).ToListAsync(ct);
        if (rows.Count == 0)
        {
            return [];
        }

        var ids = rows.Select(m => m.Id).ToList();
        var statuses = await db.CloudMonitorStatuses.AsNoTracking().Where(s => ids.Contains(s.MonitorId)).ToDictionaryAsync(s => s.MonitorId, ct);
        var incidentIds = statuses.Values.Where(s => s.OpenIncidentId != null).Select(s => s.OpenIncidentId!.Value).ToList();
        var incidents = await IncidentsAsync(db.CloudMonitorIncidents.Where(i => incidentIds.Contains(i.Id)), ct);
        var since = time.GetUtcNow().AddHours(-24);
        var uptime = await db.CloudMonitorHours.AsNoTracking()
            .Where(h => ids.Contains(h.MonitorId) && h.Hour >= since.AddHours(-1))
            .GroupBy(h => h.MonitorId)
            .Select(g => new { g.Key, Checks = g.Sum(h => h.Checks), Failures = g.Sum(h => h.Failures) })
            .ToDictionaryAsync(x => x.Key, x => x.Checks == 0 ? (double?)null : 1.0 - ((double)x.Failures / x.Checks), ct);
        var muted = (await db.CloudMonitorMutes.AsNoTracking().Where(m => m.UserId == userId && ids.Contains(m.MonitorId)).Select(m => m.MonitorId).ToListAsync(ct)).ToHashSet();

        return [.. rows.Select(m =>
        {
            var status = statuses.GetValueOrDefault(m.Id);
            var open = status?.OpenIncidentId is { } openId ? incidents.FirstOrDefault(i => i.Id == openId) : null;
            return CloudMonitorMapper.ToDto(m, Status(m, status, open, uptime.GetValueOrDefault(m.Id)), muted.Contains(m.Id), canWrite.GetValueOrDefault(m.ScopeId));
        })];
    }

    public async Task<CloudMonitorDto> OneAsync(long id, long userId, bool canWrite, CancellationToken ct = default) =>
        (await ListAsync(db.CloudMonitors.Where(m => m.Id == id), userId, new Dictionary<long, bool> { [await db.CloudMonitors.Where(m => m.Id == id).Select(m => m.ScopeId).SingleAsync(ct)] = canWrite }, ct)).Single();

    /// <summary>What the hub pushes after a result.</summary>
    public async Task<IReadOnlyList<CloudMonitorLiveDto>> LiveAsync(IReadOnlyCollection<long> ids, CancellationToken ct = default)
    {
        var all = await ListAsync(db.CloudMonitors.Where(m => ids.Contains(m.Id)), 0, new Dictionary<long, bool>(), ct);
        return [.. all.Select(CloudMonitorMapper.ToLiveDto)];
    }

    /// <summary>Incidents with the regions of the nodes that saw and confirmed them.</summary>
    public async Task<List<CloudMonitorIncidentDto>> IncidentsAsync(IQueryable<CloudMonitorIncident> incidents, CancellationToken ct = default) =>
        await (from i in incidents.AsNoTracking()
               join seen in db.MonitoringNodes on i.NodeId equals seen.Id into seenBy
               from seen in seenBy.DefaultIfEmpty()
               join confirmed in db.MonitoringNodes on i.ConfirmedByNodeId equals confirmed.Id into confirmedBy
               from confirmed in confirmedBy.DefaultIfEmpty()
               select new CloudMonitorIncidentRow { Incident = i, SeenBy = seen, ConfirmedBy = confirmed }).ProjectToDto().ToListAsync(ct);

    public static CloudMonitorStatusDto Status(CloudMonitor monitor, CloudMonitorStatus? status, CloudMonitorIncidentDto? open, double? uptime)
    {
        var verdict = monitor.Paused ? "paused"
            : open is not null ? "down"
            : status?.State == "warn" ? "degraded"
            : status?.Confirmed == "ok" ? "up"
            : "unknown";
        return new CloudMonitorStatusDto(
            verdict,
            status?.State,
            status?.LastCheckedAt,
            status?.LatencyMs,
            status?.HttpStatus,
            status?.Problem,
            status?.LastRegion,
            status is not null && !monitor.Paused && (status.Pending || status.ConfirmId is not null),
            open,
            uptime is { } u ? Math.Round(u, 4) : null);
    }
}
