using System.Collections.Concurrent;
using Google.Protobuf.WellKnownTypes;
using Microsoft.Extensions.Options;
using Runova.Monitoring.Contracts.Grpc;
using Runova.Monitoring.Core.Health;
using Runova.Monitoring.Core.Net;

namespace Runova.Monitoring.Node;

/// <summary>Runs one check. The real one is <see cref="HealthProber"/> behind the public address guard.</summary>
public interface IMonitorProbe
{
    Task<HealthReport> ProbeAsync(MonitorDefinition monitor, CancellationToken ct);
}

internal sealed class SafeMonitorProbe(HealthProber prober, TimeProvider time) : IMonitorProbe
{
    public Task<HealthReport> ProbeAsync(MonitorDefinition monitor, CancellationToken ct)
    {
        if (!Uri.TryCreate(monitor.Url, UriKind.Absolute, out var url))
        {
            return Task.FromResult(HealthParser.ProbeFailure("The monitor's address is not a URL.", time.GetUtcNow(), HealthProbeState.Invalid));
        }

        return prober.ProbeAsync(
            new ProbeRequest(url, string.IsNullOrEmpty(monitor.AuthMode) ? null : monitor.AuthMode, monitor.Secret, monitor.TimeoutSec, monitor.AllowInsecure),
            time,
            ct);
    }
}

/// <summary>
/// The node's own timer for its monitors (E54). Each monitor is checked every interval with a
/// little jitter; while a change waits for its confirming sample the next check comes sooner.
/// Checks run on at most <see cref="NodeOptions.Concurrency"/> at once, and each result goes to the
/// outbox. Hangfire is not used here: thousands of 30 second schedules want one timer, not jobs.
/// </summary>
public sealed partial class CheckScheduler(
    IMonitorProbe probe, ResultOutbox outbox, IOptions<NodeOptions> options, TimeProvider time, ILogger<CheckScheduler> logger) : BackgroundService
{
    private static readonly TimeSpan _tick = TimeSpan.FromMilliseconds(250);

    private readonly ConcurrentDictionary<long, Entry> _monitors = new();
    private readonly ConcurrentQueue<DateTimeOffset> _recent = new();
    private SemaphoreSlim? _slots;
    private int _lagMs;

    private sealed class Entry(MonitorDefinition monitor, DateTimeOffset due)
    {
        public MonitorDefinition Monitor { get; set; } = monitor;

        public DateTimeOffset Due { get; set; } = due;

        public HealthTrack Track { get; set; } = HealthTrack.Initial;

        public int Running;
    }

    public long AssignmentVersion { get; private set; }

    public int Count => _monitors.Count;

    public int LagMs => _lagMs;

    /// <summary>Scheduled checks running now; one counts until its next time is set.</summary>
    public int InFlight => _monitors.Values.Count(e => Volatile.Read(ref e.Running) == 1);

    /// <summary>Checks finished in the last minute.</summary>
    public int ChecksLastMinute
    {
        get
        {
            var cutoff = time.GetUtcNow().AddMinutes(-1);
            while (_recent.TryPeek(out var at) && at < cutoff)
            {
                _recent.TryDequeue(out _);
            }

            return _recent.Count;
        }
    }

    /// <summary>Replaces every monitor. New ones start at a random point of their interval, so they spread out.</summary>
    public void Apply(AssignmentSnapshot snapshot)
    {
        var keep = snapshot.Monitors.Select(m => m.Id).ToHashSet();
        foreach (var id in _monitors.Keys.Where(id => !keep.Contains(id)))
        {
            _monitors.TryRemove(id, out _);
        }

        foreach (var monitor in snapshot.Monitors)
        {
            Upsert(monitor);
        }

        AssignmentVersion = snapshot.AssignmentVersion;
    }

    public void Apply(AssignmentDelta delta)
    {
        foreach (var id in delta.Removed)
        {
            _monitors.TryRemove(id, out _);
        }

        foreach (var monitor in delta.Upserts)
        {
            Upsert(monitor);
        }

        AssignmentVersion = delta.AssignmentVersion;
    }

    /// <summary>Stops every check: the node is drained.</summary>
    public void Clear()
    {
        _monitors.Clear();
        AssignmentVersion = 0;
    }

    /// <summary>Checks a monitor once, now, to confirm another node's result.</summary>
    public async Task ConfirmAsync(ConfirmCheck confirm, CancellationToken ct)
    {
        var slots = _slots ??= new SemaphoreSlim(Math.Max(1, options.Value.Concurrency));
        await slots.WaitAsync(ct);
        try
        {
            await RunAsync(confirm.Monitor, confirm.ConfirmId, ct);
        }
        finally
        {
            slots.Release();
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var slots = _slots ??= new SemaphoreSlim(Math.Max(1, options.Value.Concurrency));
        using var timer = new PeriodicTimer(_tick, time);
        while (await TickAsync(timer, stoppingToken))
        {
            var now = time.GetUtcNow();
            var lag = 0;
            foreach (var entry in _monitors.Values.Where(e => e.Due <= now).OrderBy(e => e.Due))
            {
                if (Volatile.Read(ref entry.Running) == 1)
                {
                    continue;
                }

                if (!slots.Wait(0, CancellationToken.None))
                {
                    lag = Math.Max(lag, (int)(now - entry.Due).TotalMilliseconds);
                    break;
                }

                lag = Math.Max(lag, (int)(now - entry.Due).TotalMilliseconds);
                Interlocked.Exchange(ref entry.Running, 1);
                _ = Task.Run(async () =>
                {
                    try
                    {
                        var state = await RunAsync(entry.Monitor, null, stoppingToken);
                        if (state is { } probed)
                        {
                            var step = HealthTransitions.Next(entry.Track, probed);
                            entry.Track = step.Track;
                            entry.Due = time.GetUtcNow() + HealthIntervals.NextDelay(entry.Monitor.IntervalSec, step.Track.Pending);
                        }
                    }
                    finally
                    {
                        Interlocked.Exchange(ref entry.Running, 0);
                        slots.Release();
                    }
                }, CancellationToken.None);
            }

            _lagMs = lag;
        }
    }

    private static async Task<bool> TickAsync(PeriodicTimer timer, CancellationToken ct)
    {
        try
        {
            return await timer.WaitForNextTickAsync(ct);
        }
        catch (OperationCanceledException)
        {
            return false;
        }
    }

    private void Upsert(MonitorDefinition monitor)
    {
        var interval = HealthIntervals.NormalizeInterval(monitor.IntervalSec);
        _monitors.AddOrUpdate(
            monitor.Id,
            _ => new Entry(monitor, time.GetUtcNow() + Spread(interval)),
            (_, entry) =>
            {
                if (entry.Monitor.Version != monitor.Version && entry.Monitor.IntervalSec != monitor.IntervalSec)
                {
                    entry.Due = time.GetUtcNow() + Spread(interval);
                }

                entry.Monitor = monitor;
                return entry;
            });
    }

    private TimeSpan Spread(int intervalSec) =>
        TimeSpan.FromSeconds(Random.Shared.NextDouble() * Math.Min(intervalSec, options.Value.StartSpread.TotalSeconds));

    /// <summary>Probes and keeps the result. Never throws for a probe that failed; that is a result too.</summary>
    private async Task<HealthProbeState?> RunAsync(MonitorDefinition monitor, string? confirmId, CancellationToken ct)
    {
        HealthReport report;
        try
        {
            report = await probe.ProbeAsync(monitor, ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            return null;
        }
        catch (Exception e)
        {
            ProbeCrashed(logger, monitor.Id, e);
            report = HealthParser.ProbeFailure("The check could not run on this node.", time.GetUtcNow());
        }

        _recent.Enqueue(time.GetUtcNow());
        try
        {
            await outbox.AddAsync(ToResult(monitor, report, confirmId), CancellationToken.None);
        }
        catch (Exception e)
        {
            OutboxFailed(logger, monitor.Id, e);
        }

        return report.State;
    }

    internal static CheckResult ToResult(MonitorDefinition monitor, HealthReport report, string? confirmId)
    {
        var result = new CheckResult
        {
            Id = Guid.CreateVersion7(report.CheckedAt).ToString(),
            MonitorId = monitor.Id,
            MonitorVersion = monitor.Version,
            CheckedAt = Timestamp.FromDateTimeOffset(report.CheckedAt),
            State = HealthStates.ToWire(report.State),
            HttpStatus = report.HttpStatus ?? 0,
            LatencyMs = report.LatencyMs ?? -1,
            Problem = report.Problem ?? "",
            ConfirmId = confirmId ?? "",
        };
        foreach (var service in report.Services.Where(s => s.Status != HealthCheckStatus.Pass).Take(50))
        {
            result.Services.Add(new ServiceProblem
            {
                Key = service.Key,
                Status = HealthStates.ToWire(service.Status),
                Message = service.Error?.Message ?? "",
            });
        }

        return result;
    }

    [LoggerMessage(Level = LogLevel.Error, Message = "The check of monitor {MonitorId} threw.")]
    private static partial void ProbeCrashed(ILogger logger, long monitorId, Exception exception);

    [LoggerMessage(Level = LogLevel.Error, Message = "The result of monitor {MonitorId} could not be kept.")]
    private static partial void OutboxFailed(ILogger logger, long monitorId, Exception exception);
}
