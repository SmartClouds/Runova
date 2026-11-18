namespace Runova.ServerCore.Traffic;

/// <summary>
/// Keeps traffic data within its retention whether or not the logs are being read (E109, E110):
/// every minute expired blocks are lifted (nginx told), and once a day statistics and attack events
/// older than their retention go. Nothing here touches the logs.
/// </summary>
internal sealed partial class TrafficMaintenance(
    TrafficManager manager,
    TrafficStore store,
    AttackMonitor attacks,
    AddressBlocks blocks,
    TimeProvider time,
    TrafficOptions options,
    ILogger<TrafficMaintenance> logger) : BackgroundService
{
    public static readonly TimeSpan Every = TimeSpan.FromMinutes(1);

    public static readonly TimeSpan RetentionEvery = TimeSpan.FromDays(1);

    private DateTimeOffset _lastRetention = DateTimeOffset.MinValue;

    private int _passes;

    /// <summary>Passes finished so far, for tests to wait on.</summary>
    public int Passes => Volatile.Read(ref _passes);

    public async Task RunOnceAsync(CancellationToken cancellationToken)
    {
        await blocks.PruneExpiredAsync(cancellationToken);
        var now = time.GetUtcNow();
        if (now - _lastRetention >= RetentionEvery)
        {
            _lastRetention = now;
            await manager.EnsureLoadedAsync(cancellationToken);
            var config = manager.Current;
            var pruned = await store.PruneAsync(config.Statistics.HourlyRetentionDays, config.Statistics.DailyRetentionDays, cancellationToken)
                + await attacks.PruneAsync(config.Attacks.EventRetentionDays, cancellationToken);
            if (pruned > 0)
            {
                LogPruned(logger, pruned);
            }
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.RunInBackground)
        {
            return;
        }

        using var timer = new PeriodicTimer(Every, time);
        do
        {
            try
            {
                await RunOnceAsync(stoppingToken);
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                LogFailed(logger, error);
            }

            Interlocked.Increment(ref _passes);
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Pruned {Rows} traffic rows past their retention.")]
    private static partial void LogPruned(ILogger logger, int rows);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Traffic maintenance failed; it runs again in a minute.")]
    private static partial void LogFailed(ILogger logger, Exception error);
}
