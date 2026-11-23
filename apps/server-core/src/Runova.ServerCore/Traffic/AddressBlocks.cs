using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Traffic;

/// <summary>A visitor an attack came from (<see cref="IpKey.Visitor"/>), which auto-block may block.</summary>
internal sealed record AutoBlockCandidate(IpKey Address, AttackKind Kind, string SiteId, string SiteName);

/// <summary>A candidate that a block now covers, and when that block ends (null: never).</summary>
internal sealed record AutoBlocked(IpKey Address, long? ExpiresAt);

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

    /// <summary>How often a full auto-block list is logged while candidates keep coming.</summary>
    private const long CapWarningEveryMs = 10 * 60_000;

    private readonly SemaphoreSlim _gate = new(1, 1);

    private long _nextCapWarning;

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
    /// Blocks the attacking visitors auto-block allows (the address for IPv4, the /64 for IPv6): not
    /// holding an address an app is connected from, and only while fewer than the cap are blocked.
    /// Returns every candidate a block covers now, the ones it blocked and the ones blocked already,
    /// with when that block ends. The rest are left for the caller to offer again.
    /// </summary>
    public async Task<IReadOnlyList<AutoBlocked>> AutoBlockAsync(IReadOnlyList<AutoBlockCandidate> candidates, AutoBlockSettings settings, IReadOnlyCollection<IpKey> appAddresses, CancellationToken cancellationToken)
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
            var rows = await db.BlockedAddresses.Where(b => b.ExpiresAt == null || b.ExpiresAt > now).Select(b => new { b.Network, b.ExpiresAt }).ToListAsync(cancellationToken);
            var active = rows.Select(row => row.Network).ToList();
            var networks = new List<(IpNetwork Network, long? ExpiresAt)>();
            foreach (var row in rows)
            {
                if (IpNetwork.TryParse(row.Network, out var network))
                {
                    networks.Add((network, row.ExpiresAt));
                }
            }

            var added = new List<BlockedAddress>();
            var already = new List<AutoBlocked>();
            var blocked = new List<IpKey>();
            var overCap = 0;
            foreach (var candidate in candidates)
            {
                var address = candidate.Address;
                var visitor = address.Visitor;
                if (!settings.Kinds.Contains(candidate.Kind) || visitor.Base.IsLocal || appAddresses.Any(visitor.Contains)
                    || blocked.Contains(address) || already.Any(a => a.Address == address))
                {
                    continue;
                }

                if (networks.Where(n => n.Network.Covers(visitor)).Select(n => (long?)(n.ExpiresAt ?? long.MaxValue)).Max() is { } until)
                {
                    already.Add(new AutoBlocked(address, until == long.MaxValue ? null : until));
                    continue;
                }

                if (active.Count + added.Count >= settings.MaxBlocked)
                {
                    overCap++;
                    continue;
                }

                var reason = $"{KindName(candidate.Kind)} on {candidate.SiteName}";
                var row = new BlockedAddress
                {
                    Network = visitor.Text,
                    Reason = reason.Length > MaxReasonLength ? reason[..MaxReasonLength] : reason,
                    Automatic = true,
                    CreatedAt = now,
                    SiteId = candidate.SiteId,
                    ExpiresAt = settings.Minutes > 0 ? now + (settings.Minutes * 60_000L) : null,
                };
                added.Add(row);
                blocked.Add(address);
            }

            if (overCap > 0 && now >= _nextCapWarning)
            {
                // The caller offers them again on later reads, so this would repeat every few seconds.
                _nextCapWarning = now + CapWarningEveryMs;
                LogAutoBlockCapReached(logger, settings.MaxBlocked, overCap);
            }

            if (added.Count == 0)
            {
                return already;
            }

            var outcome = await nginx.ApplyAsync([.. active, .. added.Select(row => row.Network)], cancellationToken);
            if (!outcome.Applied)
            {
                LogAutoBlockRefused(logger, outcome.Error);
                return already;
            }

            // A block of the same network that ran out may not be pruned yet; the new one takes its place.
            var texts = added.Select(row => row.Network).ToList();
            await db.BlockedAddresses.Where(b => texts.Contains(b.Network) && b.ExpiresAt != null && b.ExpiresAt <= now).ExecuteDeleteAsync(cancellationToken);
            db.BlockedAddresses.AddRange(added);
            await db.SaveChangesAsync(cancellationToken);

            await db.AttackEvents.Where(e => texts.Contains(e.Address)).ExecuteUpdateAsync(update => update.SetProperty(e => e.Blocked, true), cancellationToken);
            LogAutoBlocked(logger, added.Count);
            return [.. already, .. blocked.Select(address => new AutoBlocked(address, settings.Minutes > 0 ? now + (settings.Minutes * 60_000L) : null))];
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

    [LoggerMessage(Level = LogLevel.Warning, Message = "Auto-block has reached its cap of {MaxBlocked} blocked addresses, so {Count} attacking addresses were not blocked. Raise the cap or unblock some.")]
    private static partial void LogAutoBlockCapReached(ILogger logger, int maxBlocked, int count);

    [LoggerMessage(Level = LogLevel.Warning, Message = "nginx refused auto-blocked addresses, so they were not blocked: {Error}")]
    private static partial void LogAutoBlockRefused(ILogger logger, string? error);

    [LoggerMessage(Level = LogLevel.Warning, Message = "nginx refused the list without the expired blocks: {Error}")]
    private static partial void LogPruneRefused(ILogger logger, string? error);
}
