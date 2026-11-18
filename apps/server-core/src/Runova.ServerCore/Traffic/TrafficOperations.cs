using Microsoft.Extensions.DependencyInjection.Extensions;
using Runova.ServerCore.Hosting;
using Runova.ServerCore.Hubs;

namespace Runova.ServerCore.Traffic;

/// <summary>Where DB-IP's country file is downloaded from. The DevHost and the tests put a fake in its place.</summary>
internal sealed record GeoDownload(HttpMessageHandler Handler);

/// <summary>What the hub's traffic and attack methods use, in one parameter.</summary>
internal sealed record TrafficHubServices(
    TrafficManager Manager,
    TrafficStore Store,
    TrafficLiveView Live,
    AttackMonitor Attacks,
    AddressBlocks Blocks,
    IAppAddresses App,
    StreamLimits Streams);

/// <summary>
/// Keeps DB-IP's country file current while statistics or detection run with countries on: the file
/// already in the data folder on start, then a check every few hours (a download only once a month).
/// </summary>
internal sealed partial class TrafficGeoRefresher(GeoDatabaseUpdater updater, TrafficManager manager, TrafficOptions options, ILogger<TrafficGeoRefresher> logger) : BackgroundService
{
    public static readonly TimeSpan Every = TimeSpan.FromHours(6);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.RunInBackground)
        {
            return;
        }

        updater.LoadExisting();
        // A minute after the start, then every few hours; paced in real time like the other loops.
        using var first = new PeriodicTimer(TimeSpan.FromMinutes(1), TimeProvider.System);
        await first.WaitForNextTickAsync(stoppingToken);
        using var timer = new PeriodicTimer(Every, TimeProvider.System);
        do
        {
            var config = manager.Current;
            if (config.Tailing && config.Statistics.Countries)
            {
                try
                {
                    await updater.UpdateAsync(stoppingToken);
                }
                catch (Exception error) when (error is not OperationCanceledException)
                {
                    LogFailed(logger, error);
                }
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Checking DB-IP's country file failed; it is tried again later.")]
    private static partial void LogFailed(ILogger logger, Exception error);
}

/// <summary>Website traffic statistics (E109) and attack detection and blocking (E110).</summary>
internal static class TrafficOperations
{
    /// <summary>Call after the web operations: it reads the sites' logs through their machine and blocks through their applier.</summary>
    public static IServiceCollection AddTrafficOperations(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        services.TryAddSingleton(TrafficOptions.Default);
        services.TryAddSingleton(_ => new GeoDownload(new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            ConnectTimeout = TimeSpan.FromSeconds(15),
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
        }));
        services.AddSingleton<GeoCountry>();
        services.AddSingleton(provider => new GeoDatabaseUpdater(
            provider.GetRequiredService<GeoDownload>().Handler,
            Path.Combine(provider.GetRequiredService<CoreDirectories>().Data, "geo"),
            provider.GetRequiredService<GeoCountry>(),
            provider.GetRequiredService<TimeProvider>(),
            provider.GetRequiredService<ILogger<GeoDatabaseUpdater>>()));
        services.AddSingleton(provider => new VisitorHasher(VisitorHasher.LoadSalt(provider.GetRequiredService<CoreDirectories>().Data)));
        services.AddSingleton(provider => new TrafficStore(
            provider.GetRequiredService<Microsoft.EntityFrameworkCore.IDbContextFactory<Data.CoreDbContext>>(),
            provider.GetRequiredService<TimeProvider>()));
        services.AddSingleton<TrafficManager>();
        services.AddSingleton<BlockList>();
        services.AddSingleton<AddressBlocks>();
        services.TryAddSingleton<IAppAddresses, AppAddresses>();
        services.AddSingleton<AttackMonitor>();
        services.AddSingleton(provider => new TrafficLiveView(provider.GetRequiredService<TimeProvider>()));
        services.AddSingleton<TrafficTailer>();
        services.AddSingleton<TrafficHubServices>();
        services.AddHostedService(provider => provider.GetRequiredService<TrafficTailer>());
        services.AddHostedService<TrafficGeoRefresher>();
        services.AddHostedService<TrafficMaintenance>();
        return services;
    }
}
