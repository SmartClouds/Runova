using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Traffic;

/// <summary>An address an attack came from, which auto-block may block.</summary>
internal sealed record AutoBlockCandidate(IpKey Address, AttackKind Kind, string SiteId, string SiteName);

/// <summary>
/// Addresses nginx refuses on every site (E110), kept in the database and written to blocked.conf
/// through <see cref="BlockList"/> after each change. A change nginx refuses is not kept. Loopback,
/// networks nearly as wide as the internet, and the address the person is connected from cannot be
/// blocked, so nobody shuts themselves out. Expired blocks stop counting at once and are deleted by
/// <see cref="PruneExpiredAsync"/>.
/// </summary>
internal sealed partial class AddressBlocks(IDbContextFactory<CoreDbContext> contexts, BlockList nginx, TimeProvider time, ILogger<AddressBlocks> logger) : IDisposable
{
    public const int MaxBlocks = 100_000;

    public const int MaxReasonLength = 200;

    /// <summary>The widest networks that can be blocked: anything wider is most of the internet.</summary>
    public const int MinIpv4Prefix = 8;

    public const int MinIpv6Prefix = 16;

    private readonly SemaphoreSlim _gate = new(1, 1);

    private long Now => time.GetUtcNow().ToUnixTimeMilliseconds();

    public void Dispose() => _gate.Dispose();

    /// <summary>Blocks in force, newest first.</summary>
    public async Task<BlockedAddressInfo[]> ListAsync(CancellationToken cancellationToken)
    {
        var now = Now;
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        return [.. (await db.BlockedAddresses.AsNoTracking()
            .Where(b => b.ExpiresAt == null || b.ExpiresAt > now)
            .OrderByDescending(b => b.CreatedAt)
            .ThenByDescending(b => b.Id)
            .ToListAsync(cancellationToken))
            .Select(TrafficMapper.ToInfo)];
    }

    /// <param name="caller">The address the person asking is connected from, when the core can tell.</param>
    public async Task<BlockAddressResult> BlockAsync(BlockAddressRequest request, string by, IpKey? caller, CancellationToken cancellationToken)
    {
        if (request is null || string.IsNullOrWhiteSpace(request.Network))
        {
            return Refused("Enter an address or a network like 203.0.113.0/24.");
        }

        var text = request.Network.Trim();
        if (!NginxAddresses.TryParseNetwork(text, out var canonical, out var problem))
        {
            return Refused(problem);
        }

        if (Refusal(canonical, caller) is { } refusal)
        {
            return Refused(refusal);
        }

        if (request.Minutes is < 0 or > TrafficManager.MaxBlockMinutes)
        {
            return Refused($"A block lasts 1 to {TrafficManager.MaxBlockMinutes} minutes, or 0 for good.");
        }

        var reason = string.IsNullOrWhiteSpace(request.Reason) ? $"Blocked by {by}" : request.Reason.Trim();
        reason = reason.Length > MaxReasonLength ? reason[..MaxReasonLength] : reason;
        var site = request.SiteId is { Length: > 0 } id && NginxValidator.IsId(id) ? id : null;
        var now = Now;
        long? expires = request.Minutes is > 0 ? now + (request.Minutes.Value * 60_000L) : null;

        await _gate.WaitAsync(cancellationToken);
        try
        {
            await using var db = await contexts.CreateDbContextAsync(cancellationToken);
            var row = await db.BlockedAddresses.FirstOrDefaultAsync(b => b.Network == canonical, cancellationToken);
            if (row is null)
            {
                if (await db.BlockedAddresses.CountAsync(cancellationToken) >= MaxBlocks)
                {
                    return Refused($"A server can block at most {MaxBlocks} addresses. Unblock some first.");
                }

                row = new BlockedAddress { Network = canonical, Reason = reason };
                db.BlockedAddresses.Add(row);
            }

            row.Reason = reason;
            row.Automatic = false;
            row.CreatedAt = now;
            row.CreatedBy = by;
            row.SiteId = site;
            row.ExpiresAt = expires;

            // nginx first: the block is saved only once nginx refuses the address.
            var outcome = await nginx.ApplyAsync([.. await ActiveAsync(db, except: canonical, cancellationToken), canonical], cancellationToken);
            if (!outcome.Applied)
            {
                return Refused($"nginx refused the block, so nothing changed: {outcome.Error}");
            }

            await db.SaveChangesAsync(cancellationToken);
            await db.AttackEvents.Where(e => e.Address == canonical).ExecuteUpdateAsync(update => update.SetProperty(e => e.Blocked, true), cancellationToken);
            return new BlockAddressResult([], TrafficMapper.ToInfo(row));
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>The network let back, or null when there is no such block. Throws when nginx refuses the list without it, which then stays as it was.</summary>
    public async Task<string?> UnblockAsync(long id, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await using var db = await contexts.CreateDbContextAsync(cancellationToken);
            var row = await db.BlockedAddresses.FirstOrDefaultAsync(b => b.Id == id, cancellationToken);
            if (row is null)
            {
                return null;
            }

            var outcome = await nginx.ApplyAsync(await ActiveAsync(db, except: row.Network, cancellationToken), cancellationToken);
            if (!outcome.Applied)
            {
                throw new InvalidOperationException($"nginx refused the list without this address, so it stays blocked: {outcome.Error}");
            }

            db.BlockedAddresses.Remove(row);
            await db.SaveChangesAsync(cancellationToken);
            await db.AttackEvents.Where(e => e.Address == row.Network).ExecuteUpdateAsync(update => update.SetProperty(e => e.Blocked, false), cancellationToken);
            return row.Network;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Blocks the attacking addresses auto-block allows: not already blocked, not an address an app
    /// is connected from, and only while fewer than the cap are blocked. Returns the ones it blocked.
    /// </summary>
    public async Task<IReadOnlyList<IpKey>> AutoBlockAsync(IReadOnlyList<AutoBlockCandidate> candidates, AutoBlockSettings settings, IReadOnlyCollection<IpKey> appAddresses, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(candidates);
        ArgumentNullException.ThrowIfNull(settings);
        ArgumentNullException.ThrowIfNull(appAddresses);
        if (!settings.Enabled || candidates.Count == 0)
        {
            return [];
        }

        await _gate.WaitAsync(cancellationToken);
        try
        {
            var now = Now;
            await using var db = await contexts.CreateDbContextAsync(cancellationToken);
            var active = await db.BlockedAddresses.Where(b => b.ExpiresAt == null || b.ExpiresAt > now).Select(b => b.Network).ToListAsync(cancellationToken);
            var networks = active.Select(text => IpNetwork.TryParse(text, out var network) ? network : (IpNetwork?)null).OfType<IpNetwork>().ToList();
            var added = new List<BlockedAddress>();
            var blocked = new List<IpKey>();
            foreach (var candidate in candidates)
            {
                if (active.Count + added.Count >= settings.MaxBlocked)
                {
                    break;
                }

                var address = candidate.Address;
                if (!settings.Kinds.Contains(candidate.Kind) || address.IsLocal || appAddresses.Contains(address)
                    || blocked.Contains(address) || networks.Any(network => network.Contains(address)))
                {
                    continue;
                }

                var reason = $"{KindName(candidate.Kind)} on {candidate.SiteName}";
                var row = new BlockedAddress
                {
                    Network = address.ToString(),
                    Reason = reason.Length > MaxReasonLength ? reason[..MaxReasonLength] : reason,
                    Automatic = true,
                    CreatedAt = now,
                    SiteId = candidate.SiteId,
                    ExpiresAt = settings.Minutes > 0 ? now + (settings.Minutes * 60_000L) : null,
                };
                added.Add(row);
                blocked.Add(address);
            }

            if (added.Count == 0)
            {
                return [];
            }

            var outcome = await nginx.ApplyAsync([.. active, .. added.Select(row => row.Network)], cancellationToken);
            if (!outcome.Applied)
            {
                LogAutoBlockRefused(logger, outcome.Error);
                return [];
            }

            db.BlockedAddresses.AddRange(added);
            await db.SaveChangesAsync(cancellationToken);

            var texts = added.Select(row => row.Network).ToList();
            await db.AttackEvents.Where(e => texts.Contains(e.Address)).ExecuteUpdateAsync(update => update.SetProperty(e => e.Blocked, true), cancellationToken);
            LogAutoBlocked(logger, added.Count);
            return blocked;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Deletes the blocks that have expired and lets nginx know. Returns how many went.</summary>
    public async Task<int> PruneExpiredAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var now = Now;
            await using var db = await contexts.CreateDbContextAsync(cancellationToken);
            var expired = await db.BlockedAddresses.Where(b => b.ExpiresAt != null && b.ExpiresAt <= now).ToListAsync(cancellationToken);
            if (expired.Count == 0)
            {
                return 0;
            }

            var outcome = await nginx.ApplyAsync(await ActiveAsync(db, except: null, cancellationToken), cancellationToken);
            db.BlockedAddresses.RemoveRange(expired);
            await db.SaveChangesAsync(cancellationToken);
            if (!outcome.Applied)
            {
                LogPruneRefused(logger, outcome.Error);
            }

            var texts = expired.Select(row => row.Network).ToList();
            await db.AttackEvents.Where(e => texts.Contains(e.Address)).ExecuteUpdateAsync(update => update.SetProperty(e => e.Blocked, false), cancellationToken);
            return expired.Count;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Writes blocked.conf from the database, as on start, so the two never drift apart.</summary>
    public async Task<BlockListOutcome> SyncAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await using var db = await contexts.CreateDbContextAsync(cancellationToken);
            return await nginx.ApplyAsync(await ActiveAsync(db, except: null, cancellationToken), cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Why the network cannot be blocked, or null.</summary>
    public static string? Refusal(string canonical, IpKey? caller)
    {
        if (!IpNetwork.TryParse(canonical, out var network))
        {
            return $"'{canonical}' is not an IP address or a network like 203.0.113.0/24.";
        }

        var v4 = network.Base.IsV4;
        if (network.Prefix < (v4 ? MinIpv4Prefix : MinIpv6Prefix))
        {
            return $"{canonical} would block every address, or nearly. Block a /{(v4 ? MinIpv4Prefix : MinIpv6Prefix)} or narrower.";
        }

        var loopback = v4 ? new IpKey(0x7F000001, true) : new IpKey(UInt128.One, false);
        if (network.Contains(loopback) || network.Base.Value == UInt128.Zero)
        {
            return $"{canonical} is this server itself, which must always reach its own sites.";
        }

        if (caller is { } own && network.Contains(own))
        {
            return $"{canonical} holds the address you are connected from ({own}); blocking it could shut you out.";
        }

        return null;
    }

    private static string KindName(AttackKind kind) => kind switch
    {
        AttackKind.BruteForce => "Brute force",
        AttackKind.Flood => "Flood",
        AttackKind.Injection => "Injection",
        _ => "Scan",
    };

    /// <summary>The networks blocked now, as saved, but for one.</summary>
    private async Task<List<string>> ActiveAsync(CoreDbContext db, string? except, CancellationToken cancellationToken)
    {
        var now = Now;
        return await db.BlockedAddresses.AsNoTracking()
            .Where(b => (b.ExpiresAt == null || b.ExpiresAt > now) && b.Network != except)
            .Select(b => b.Network)
            .ToListAsync(cancellationToken);
    }

    private static BlockAddressResult Refused(string problem) => new([problem]);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Auto-blocked {Count} attacking addresses.")]
    private static partial void LogAutoBlocked(ILogger logger, int count);

    [LoggerMessage(Level = LogLevel.Warning, Message = "nginx refused auto-blocked addresses, so they were not blocked: {Error}")]
    private static partial void LogAutoBlockRefused(ILogger logger, string? error);

    [LoggerMessage(Level = LogLevel.Warning, Message = "nginx refused the list without the expired blocks: {Error}")]
    private static partial void LogPruneRefused(ILogger logger, string? error);
}
