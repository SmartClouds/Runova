using System.Globalization;
using System.Text;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Docker;

namespace Runova.ServerCore.Stacks;

/// <summary>
/// Resource caps on an app's services (the app reads them the same way, in
/// packages/core/src/deploy/limits/limits.ts): the checks on their shape, the checks against what
/// the server has, and the lines they become in the override file. CPU and memory are written in
/// both Compose forms (`cpus`/`mem_limit` and `deploy.resources.limits`) with the same values:
/// Compose refuses only different values, so either form in the app's own file is overridden.
/// </summary>
internal static class ResourceLimits
{
    public const int MinCpuPercent = 5;

    public const int MaxCpuPercent = 100;

    /// <summary>Docker refuses a memory limit under 6 MB.</summary>
    public const int MinMemoryMb = 6;

    public const int MinDiskGb = 1;

    /// <summary>A sanity bound on the shape; the server's own count is checked at validation.</summary>
    public const int MaxCpuCores = 1024;

    public const int MaxMemoryMb = 64 * 1024 * 1024;

    public const int MaxDiskGb = 1024 * 1024;

    public sealed record DiskCapSupport(bool Supported, string? Note);

    /// <summary>
    /// Whether Docker can cap a container's writable layer (storage_opt size): overlay2 on xfs
    /// (mounted with pquota, which `docker info` does not show, so a missing pquota is Docker's
    /// own error at deploy), btrfs and zfs.
    /// </summary>
    public static DiskCapSupport DiskSupport(EngineInfo? info)
    {
        var driver = info?.StorageDriver;
        if (driver is "btrfs" or "zfs")
        {
            return new(true, null);
        }

        if (driver == "overlay2" && string.Equals(info?.BackingFilesystem, "xfs", StringComparison.OrdinalIgnoreCase))
        {
            return new(true, null);
        }

        var on = info?.BackingFilesystem is { Length: > 0 } backing ? $"{driver} on {backing}" : driver ?? "This storage driver";
        return new(false, $"{on} can't cap a container's disk. Docker needs overlay2 on xfs with pquota, btrfs or zfs for that.");
    }

    /// <summary>The shape alone, before anything is written: an empty string when it is fine.</summary>
    public static string CheckShape(StackServiceLimits[]? limits)
    {
        if (limits is null)
        {
            return string.Empty;
        }

        if (limits.Length > StackRules.MaxServices)
        {
            return $"Cap at most {StackRules.MaxServices} services.";
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var limit in limits)
        {
            if (limit is null || !StackRules.IsServiceName(limit.Service))
            {
                return "The caps name a service that is not a service name.";
            }

            if (!seen.Add(limit.Service))
            {
                return $"{limit.Service} has caps listed twice.";
            }

            if (limit.CpuCores is { } cores && (cores < 1 || cores > MaxCpuCores))
            {
                return "The core count has to be a whole number, 1 or more.";
            }

            if (limit.CpuPercent is { } percent && (percent < MinCpuPercent || percent > MaxCpuPercent))
            {
                return $"The CPU share has to be a whole percent from {MinCpuPercent} to {MaxCpuPercent}.";
            }

            if (limit.MemoryMb is { } memory && (memory < MinMemoryMb || memory > MaxMemoryMb))
            {
                return $"The memory cap has to be a whole number of MB, {MinMemoryMb} or more.";
            }

            if (limit.DiskGb is { } disk && (disk < MinDiskGb || disk > MaxDiskGb))
            {
                return $"The disk cap has to be a whole number of GB, {MinDiskGb} or more.";
            }
        }

        return string.Empty;
    }

    /// <summary>Only the services with a cap set, so what a revision keeps lists only what is capped.</summary>
    public static StackServiceLimits[] Kept(StackServiceLimits[]? limits) =>
        [.. (limits ?? []).Where(l => l.CpuCores is not null || l.CpuPercent is not null || l.MemoryMb is not null || l.DiskGb is not null)];

    /// <summary>Against the app's services and the server. Throws with the words to show.</summary>
    public static void Check(IReadOnlyCollection<StackServiceLimits> limits, IReadOnlyCollection<string> services, EngineInfo? info)
    {
        foreach (var limit in limits)
        {
            if (!services.Contains(limit.Service))
            {
                throw new ComposeConfigException($"There is no service called {limit.Service} in the compose file, so it cannot be capped.");
            }

            if (limit.CpuCores is { } cores && info?.Cpus is { } available && cores > available)
            {
                throw new ComposeConfigException($"The server has {available} {(available == 1 ? "core" : "cores")}, so {limit.Service} cannot get {cores}.");
            }

            if (limit.MemoryMb is { } memory && info?.MemoryBytes is { } total && memory * 1024L * 1024 > total)
            {
                throw new ComposeConfigException($"The server has {total / (1024 * 1024)} MB of memory, so {limit.Service} cannot get {memory} MB.");
            }

            if (limit.DiskGb is not null && DiskSupport(info) is { Supported: false } disk)
            {
                throw new ComposeConfigException($"{limit.Service} has a disk cap, but {char.ToLowerInvariant(disk.Note![0])}{disk.Note[1..]}");
            }
        }
    }

    /// <summary>Docker's `cpus`: cores times the share, to two decimals, or null without a CPU cap.</summary>
    public static double? Cpus(StackServiceLimits limit)
    {
        if (limit.CpuCores is null && limit.CpuPercent is null)
        {
            return null;
        }

        return Math.Round((limit.CpuCores ?? 1) * (limit.CpuPercent ?? 100) / 100.0, 2);
    }

    /// <summary>The service's caps as override lines, indented under its name.</summary>
    public static void Append(StringBuilder text, StackServiceLimits limit)
    {
        ArgumentNullException.ThrowIfNull(text);
        ArgumentNullException.ThrowIfNull(limit);
        var cpus = Cpus(limit)?.ToString("0.##", CultureInfo.InvariantCulture);
        var memory = limit.MemoryMb is { } mb ? $"{mb.ToString(CultureInfo.InvariantCulture)}m" : null;
        if (cpus is not null)
        {
            text.Append("    cpus: ").Append(cpus).Append('\n');
        }

        if (memory is not null)
        {
            text.Append("    mem_limit: \"").Append(memory).Append("\"\n");
            text.Append("    memswap_limit: \"").Append(memory).Append("\"\n");
        }

        if (cpus is not null || memory is not null)
        {
            text.Append("    deploy:\n      resources:\n        limits:\n");
            if (cpus is not null)
            {
                text.Append("          cpus: \"").Append(cpus).Append("\"\n");
            }

            if (memory is not null)
            {
                text.Append("          memory: \"").Append(memory).Append("\"\n");
            }
        }

        if (limit.DiskGb is { } disk)
        {
            text.Append("    storage_opt:\n      size: \"").Append(disk.ToString(CultureInfo.InvariantCulture)).Append("G\"\n");
        }
    }
}
