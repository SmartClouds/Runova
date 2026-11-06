using Google.Protobuf;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Runova.Monitoring.Contracts.Grpc;

namespace Runova.Monitoring.Node;

/// <summary>
/// Results wait here until the gateway acks the batch that carried them (E54). A batch with no ack
/// in time, or one in flight when the stream broke, is sent again; the API keeps each result id once.
/// </summary>
public sealed class ResultOutbox(IDbContextFactory<NodeDb> factory, IOptions<NodeOptions> options, TimeProvider time) : IDisposable
{
    // SQLite takes one writer at a time; a lock keeps the scheduler and the sender from colliding.
    private readonly SemaphoreSlim _lock = new(1, 1);

    public async Task AddAsync(CheckResult result, CancellationToken ct = default)
    {
        await _lock.WaitAsync(ct);
        try
        {
            await using var db = await factory.CreateDbContextAsync(ct);
            db.Outbox.Add(new OutboxResult
            {
                Id = Guid.Parse(result.Id),
                MonitorId = result.MonitorId,
                Payload = result.ToByteArray(),
                CreatedAt = time.GetUtcNow(),
            });
            await db.SaveChangesAsync(ct);

            // Past the cap the oldest go: the newest say most about how a monitor is now.
            var over = await db.Outbox.CountAsync(ct) - options.Value.MaxOutbox;
            if (over > 0)
            {
                var oldest = await db.Outbox.OrderBy(r => r.CreatedAt).Take(over).Select(r => r.Id).ToListAsync(ct);
                await db.Outbox.Where(r => oldest.Contains(r.Id)).ExecuteDeleteAsync(ct);
            }
        }
        finally
        {
            _lock.Release();
        }
    }

    /// <summary>The next results to send, marked as in flight under a new batch id; null when there are none.</summary>
    public async Task<ResultBatch?> TakeBatchAsync(int max, CancellationToken ct = default)
    {
        await _lock.WaitAsync(ct);
        try
        {
            await using var db = await factory.CreateDbContextAsync(ct);
            var now = time.GetUtcNow();
            var stale = now - options.Value.AckTimeout;
            var rows = await db.Outbox
                .Where(r => r.BatchId == null || r.SentAt < stale)
                .OrderBy(r => r.CreatedAt)
                .Take(max)
                .ToListAsync(ct);
            if (rows.Count == 0)
            {
                return null;
            }

            var batch = new ResultBatch { BatchId = Guid.NewGuid().ToString() };
            foreach (var row in rows)
            {
                row.BatchId = batch.BatchId;
                row.SentAt = now;
                batch.Results.Add(CheckResult.Parser.ParseFrom(row.Payload));
            }

            await db.SaveChangesAsync(ct);
            return batch;
        }
        finally
        {
            _lock.Release();
        }
    }

    public async Task AckAsync(string batchId, CancellationToken ct = default)
    {
        await _lock.WaitAsync(ct);
        try
        {
            await using var db = await factory.CreateDbContextAsync(ct);
            await db.Outbox.Where(r => r.BatchId == batchId).ExecuteDeleteAsync(ct);
        }
        finally
        {
            _lock.Release();
        }
    }

    /// <summary>After a reconnect nothing is in flight any more: everything is sent again.</summary>
    public async Task ResetInFlightAsync(CancellationToken ct = default)
    {
        await _lock.WaitAsync(ct);
        try
        {
            await using var db = await factory.CreateDbContextAsync(ct);
            await db.Outbox.Where(r => r.BatchId != null)
                .ExecuteUpdateAsync(u => u.SetProperty(r => r.BatchId, (string?)null).SetProperty(r => r.SentAt, (DateTimeOffset?)null), ct);
        }
        finally
        {
            _lock.Release();
        }
    }

    public void Dispose() => _lock.Dispose();

    public async Task<int> CountAsync(CancellationToken ct = default)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        return await db.Outbox.CountAsync(ct);
    }
}
