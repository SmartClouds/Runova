using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using OpenTelemetry;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using Runova.Monitoring.Core.Net;

namespace Runova.Monitoring.Node;

/// <summary>Builds the node, so tests run the same host with their own settings.</summary>
public static class NodeHost
{
    public static IHost Build(string[] args, Action<HostApplicationBuilder>? configure = null)
    {
        var builder = Host.CreateApplicationBuilder(args);
        var configuration = builder.Configuration;
        var services = builder.Services;

        // The compose file uses short names; NODE_* and Node__* both work.
        services.AddOptions<NodeOptions>()
            .BindConfiguration("Node")
            .Configure(o =>
            {
                o.ApiUrl ??= configuration["RUNOVA_API_URL"];
                o.EnrollmentToken ??= configuration["NODE_ENROLLMENT_TOKEN"];
                if (configuration["NODE_DATA_PATH"] is { Length: > 0 } data)
                {
                    o.DataPath = data;
                }

                if (int.TryParse(configuration["NODE_CONCURRENCY"], out var concurrency) && concurrency is > 0 and <= 1024)
                {
                    o.Concurrency = concurrency;
                }

                o.GatewayCaPath ??= configuration["NODE_GATEWAY_CA_PATH"];
            })
            .Validate(o => !o.AllowPrivateAddresses || builder.Environment.IsDevelopment(), "Private addresses can only be allowed in Development.")
            .ValidateOnStart();

        services.AddSingleton(TimeProvider.System);
        services.AddDbContextFactory<NodeDb>((provider, db) =>
        {
            var path = provider.GetRequiredService<IOptions<NodeOptions>>().Value.DataPath;
            Directory.CreateDirectory(path);
            db.UseSqlite($"Data Source={Path.Combine(path, "node.db")};Pooling=False");
        });
        services.AddHttpClient(NodeIdentityStore.EnrollmentClient, client => client.Timeout = TimeSpan.FromSeconds(30));
        services.AddHttpClient("probe")
            .ConfigurePrimaryHttpMessageHandler(provider => SafeHttpHandler.Create(new SafeHttpOptions
            {
                AllowPrivateAddresses = provider.GetRequiredService<IOptions<NodeOptions>>().Value.AllowPrivateAddresses,
            }))
            .ConfigureHttpClient(client => client.Timeout = Timeout.InfiniteTimeSpan);
        services.AddSingleton(provider => new HealthProber(provider.GetRequiredService<IHttpClientFactory>().CreateClient("probe")));
        services.AddSingleton<IMonitorProbe, SafeMonitorProbe>();
        services.AddSingleton<ResultOutbox>();
        services.AddSingleton<NodeIdentityStore>();
        // First, so the SQLite file and its tables exist before anything else starts using them.
        services.AddHostedService<NodeDbSetup>();
        services.AddSingleton<CheckScheduler>();
        services.AddHostedService(provider => provider.GetRequiredService<CheckScheduler>());
        services.AddSingleton<GatewayConnection>();
        services.AddHostedService(provider => provider.GetRequiredService<GatewayConnection>());

        // Every SQL statement of the outbox is not news; problems still show.
        builder.Logging.AddFilter("Microsoft.EntityFrameworkCore", LogLevel.Warning);
        builder.Logging.AddSentry(options =>
        {
            options.Dsn = configuration["Sentry:Dsn"] ?? configuration["SENTRY_DSN"] ?? "";
            options.SendDefaultPii = false;
        });
        var telemetry = services.AddOpenTelemetry()
            .ConfigureResource(resource => resource.AddService(configuration["OTEL_SERVICE_NAME"] is { Length: > 0 } name ? name : "runova-monitoring-node"))
            .WithTracing(tracing => tracing.AddHttpClientInstrumentation());
        if (!string.IsNullOrWhiteSpace(configuration["OTEL_EXPORTER_OTLP_ENDPOINT"]))
        {
            telemetry.UseOtlpExporter();
        }

        configure?.Invoke(builder);
        return builder.Build();
    }

    /// <summary>Makes the SQLite file before the other services start using it.</summary>
    private sealed class NodeDbSetup(IDbContextFactory<NodeDb> factory) : IHostedService
    {
        public async Task StartAsync(CancellationToken cancellationToken)
        {
            await using var db = await factory.CreateDbContextAsync(cancellationToken);
            await db.Database.EnsureCreatedAsync(cancellationToken);
            await db.Database.ExecuteSqlRawAsync("PRAGMA journal_mode=WAL;", cancellationToken);
        }

        public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    }
}
