using System.Text.Json;
using Hangfire;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Runova.Website.Core.Dependencies;
using Runova.Website.Data;
using Runova.Website.Data.Dependencies;

namespace Runova.Website.Api.Dependencies;

/// <summary>
/// The daily check (E51). Every quarter of an hour it takes the inventories whose time has come,
/// asks the registries and OSV about their packages (once per package for all of them, through a
/// cache of a few hours), keeps what holds now as the inventory's findings, and hands the new ones
/// to <see cref="AlertNotifier"/>. Each inventory's next check lands about a day later, a few hours
/// either way, so it is checked at a different time each day.
/// </summary>
internal sealed partial class DependencyCheckJob(
    AppDbContext db,
    IEnumerable<IPackageRegistry> registries,
    OsvClient osv,
    AlertNotifier notifier,
    CheckSchedule schedule,
    TimeProvider time,
    IOptions<PackageRegistryOptions> options,
    ILogger<DependencyCheckJob> logger)
{
    public const int Batch = 25;
    public const int MaxBatchesPerRun = 20;

    private static readonly JsonSerializerOptions _json = new(JsonSerializerDefaults.Web);

    [DisableConcurrentExecution(timeoutInSeconds: 600)]
    public async Task RunAsync(CancellationToken cancellationToken)
    {
        for (var i = 0; i < MaxBatchesPerRun; i++)
        {
            var now = time.GetUtcNow();
            var due = await db.PackageInventories
                .Where(inventory => inventory.NextCheckAt <= now)
                .OrderBy(inventory => inventory.NextCheckAt).ThenBy(inventory => inventory.Id)
                .Take(Batch)
                .ToListAsync(cancellationToken);
            if (due.Count == 0)
            {
                return;
            }

            await CheckAsync(due, cancellationToken);
        }
    }

    private async Task CheckAsync(IReadOnlyList<PackageInventory> inventories, CancellationToken cancellationToken)
    {
        var ids = inventories.Select(i => i.Id).ToList();
        var packages = (await db.InventoryPackages.AsNoTracking().Where(p => ids.Contains(p.InventoryId)).ToListAsync(cancellationToken))
            .ToLookup(p => p.InventoryId);
        var all = packages.SelectMany(g => g).ToList();
        var facts = await FactsAsync(all, cancellationToken);
        var advisories = await AdvisoriesAsync(all, cancellationToken);

        foreach (var inventory in inventories)
        {
            var findings = packages[inventory.Id]
                .SelectMany(p => FindingRules.For(
                    DependencyMapper.ToItem(p),
                    facts.GetValueOrDefault((p.Ecosystem, Key(p.Ecosystem, p.Name))),
                    advisories.GetValueOrDefault((p.Ecosystem, Key(p.Ecosystem, p.Name), p.Version)) ?? []))
                .GroupBy(f => AlertPolicy.DedupeKey(inventory.Id, f))
                .Select(g => (Key: g.Key, Finding: g.First()))
                .ToList();
            var current = await SaveFindingsAsync(inventory, findings, cancellationToken);
            await notifier.ChecksFoundAsync(inventory, current, cancellationToken);
        }
    }

    /// <summary>Replaces the inventory's findings with what holds now, keeping when each was first seen.</summary>
    private async Task<IReadOnlyList<DependencyFinding>> SaveFindingsAsync(
        PackageInventory inventory, IReadOnlyList<(string Key, Finding Finding)> findings, CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var stored = await db.DependencyFindings.Where(f => f.InventoryId == inventory.Id).ToListAsync(cancellationToken);
        var keys = findings.Select(f => f.Key).ToHashSet(StringComparer.Ordinal);
        db.DependencyFindings.RemoveRange(stored.Where(f => !keys.Contains(f.Key)));
        var kept = stored.Where(f => keys.Contains(f.Key)).ToDictionary(f => f.Key, StringComparer.Ordinal);
        foreach (var (key, finding) in findings)
        {
            if (kept.ContainsKey(key))
            {
                continue;
            }

            var row = new DependencyFinding
            {
                InventoryId = inventory.Id,
                Ecosystem = finding.Ecosystem,
                Name = finding.Name,
                Kind = finding.Kind,
                CurrentVersion = Clip(finding.CurrentVersion, 100)!,
                TargetVersion = Clip(finding.TargetVersion, 100),
                AdvisoryId = Clip(finding.AdvisoryId, 64),
                Severity = finding.Severity,
                Summary = Clip(finding.Summary, 500),
                Key = Clip(key, 400)!,
                FirstSeenAt = now,
            };
            db.DependencyFindings.Add(row);
            kept[key] = row;
        }

        inventory.LastCheckedAt = now;
        inventory.NextCheckAt = schedule.AfterCheck();
        await db.SaveChangesAsync(cancellationToken);
        return [.. kept.Values];
    }

    internal static string Key(string ecosystem, string name) => Ecosystems.PackageKey(ecosystem, name);

    private async Task<Dictionary<(string, string), PackageFactsView?>> FactsAsync(IReadOnlyList<InventoryPackage> packages, CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var fresh = now - options.Value.CacheFor;
        var wanted = packages.Select(p => (p.Ecosystem, Name: Key(p.Ecosystem, p.Name))).Distinct().ToList();
        var names = wanted.Select(w => w.Name).Distinct().ToList();
        var cached = (await db.PackageFacts.Where(f => names.Contains(f.Name)).ToListAsync(cancellationToken))
            .ToDictionary(f => (f.Ecosystem, f.Name));
        var result = new Dictionary<(string, string), PackageFactsView?>();
        var byEcosystem = registries.ToDictionary(r => r.Ecosystem);

        foreach (var (ecosystem, name) in wanted)
        {
            cached.TryGetValue((ecosystem, name), out var row);
            if (row is null || row.CheckedAt < fresh)
            {
                try
                {
                    var answer = await byEcosystem[ecosystem].GetAsync(name, cancellationToken);
                    if (row is null)
                    {
                        row = new PackageFacts { Ecosystem = ecosystem, Name = name };
                        db.PackageFacts.Add(row);
                    }

                    row.Found = answer is not null;
                    row.LatestVersion = Clip(answer?.LatestVersion, 100);
                    row.Deprecated = Clip(answer?.Deprecated, 500);
                    row.CheckedAt = now;
                }
                catch (Exception e) when (e is HttpRequestException or RegistryException or TaskCanceledException && !cancellationToken.IsCancellationRequested)
                {
                    // What it said last time, if anything, stands until it answers again.
                    LogRegistryFailed(logger, ecosystem, name, e.Message);
                }
            }

            result[(ecosystem, name)] = row is { Found: true } ? DependencyMapper.ToView(row) : null;
        }

        await db.SaveChangesAsync(cancellationToken);
        return result;
    }

    internal sealed record StoredAdvisory(string Id, string Severity, string Summary, string? FixedVersion);

    private async Task<Dictionary<(string, string, string), IReadOnlyList<AdvisoryView>>> AdvisoriesAsync(IReadOnlyList<InventoryPackage> packages, CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var fresh = now - options.Value.CacheFor;
        var wanted = packages
            .Where(p => Ecosystems.HasAdvisories(p.Ecosystem))
            .Select(p => (p.Ecosystem, Name: Key(p.Ecosystem, p.Name), p.Version))
            .Distinct()
            .ToList();
        var names = wanted.Select(w => w.Name).Distinct().ToList();
        var cached = (await db.AdvisoryLookups.Where(l => names.Contains(l.Name)).ToListAsync(cancellationToken))
            .ToDictionary(l => (l.Ecosystem, l.Name, l.Version));
        var stale = wanted.Where(w => !cached.TryGetValue(w, out var row) || row.CheckedAt < fresh).ToList();

        if (stale.Count > 0)
        {
            try
            {
                var ids = await osv.QueryAsync([.. stale.Select(s => new OsvClient.Query(s.Ecosystem, s.Name, s.Version))], cancellationToken);
                var details = new Dictionary<string, OsvClient.Advisory?>(StringComparer.Ordinal);
                foreach (var id in ids.SelectMany(i => i).Distinct(StringComparer.Ordinal))
                {
                    details[id] = await osv.GetAsync(id, cancellationToken);
                }

                for (var i = 0; i < stale.Count; i++)
                {
                    var (ecosystem, name, version) = stale[i];
                    var found = ids[i]
                        .Select(id => details.GetValueOrDefault(id))
                        .OfType<OsvClient.Advisory>()
                        .Select(a => DependencyMapper.ToStored(
                            a,
                            FindingRules.FirstFixAfter(version, a.Fixes
                                .Where(f => string.Equals(f.Name, name, StringComparison.OrdinalIgnoreCase))
                                .Select(f => f.Fixed))))
                        .ToList();
                    if (!cached.TryGetValue((ecosystem, name, version), out var row))
                    {
                        row = new AdvisoryLookup { Ecosystem = ecosystem, Name = name, Version = Clip(version, 100)! };
                        db.AdvisoryLookups.Add(row);
                        cached[(ecosystem, name, version)] = row;
                    }

                    row.Advisories = JsonSerializer.Serialize(found, _json);
                    row.CheckedAt = now;
                }

                await db.SaveChangesAsync(cancellationToken);
            }
            catch (Exception e) when (e is HttpRequestException or RegistryException or TaskCanceledException && !cancellationToken.IsCancellationRequested)
            {
                LogOsvFailed(logger, stale.Count, e.Message);
            }
        }

        var result = new Dictionary<(string, string, string), IReadOnlyList<AdvisoryView>>();
        foreach (var (key, row) in cached)
        {
            var stored = JsonSerializer.Deserialize<List<StoredAdvisory>>(row.Advisories, _json) ?? [];
            result[key] = [.. stored.Select(DependencyMapper.ToView)];
        }

        return result;
    }

    private static string? Clip(string? text, int length) => text is null || text.Length <= length ? text : text[..length];

    [LoggerMessage(Level = LogLevel.Warning, Message = "The {Ecosystem} registry did not answer for {Package}: {Reason}")]
    private static partial void LogRegistryFailed(ILogger logger, string ecosystem, string package, string reason);

    [LoggerMessage(Level = LogLevel.Warning, Message = "OSV did not answer for {Count} package versions: {Reason}")]
    private static partial void LogOsvFailed(ILogger logger, int count, string reason);
}
