using Runova.ServerCore.Execution;

namespace Runova.ServerCore.Stacks;

/// <summary>
/// Compose stacks in the core (E07): docker compose through the process runner, and the
/// operations the hub and the upload routes call. The DevHost and the tests put a simulated
/// compose in place of the real one.
/// </summary>
internal static class StackServices
{
    public static IServiceCollection AddCoreStacks(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        services.AddSingleton<IComposeRunner>(provider => new DockerComposeRunner(
            provider.GetRequiredService<IProcessRunner>(),
            provider.GetRequiredService<SystemdRunner>()));
        services.AddSingleton<Releases.ReleaseTokens>();
        services.AddSingleton<Releases.ReleaseDownloads>();
        // GitHub Release images (E105): redirects are followed by hand, only to GitHub's asset
        // hosts, and the client logs nothing, so a signed link never reaches a log.
        services.AddHttpClient(Releases.ReleaseDownloads.HttpClientName, client =>
            {
                client.Timeout = TimeSpan.FromMinutes(30);
                client.DefaultRequestHeaders.UserAgent.ParseAdd($"Runova-Core/{CoreVersion.Current}");
            })
            .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { AllowAutoRedirect = false })
            .RemoveAllLoggers();
        services.AddSingleton<StackOperations>();
        services.AddHostedService<StackRecovery>();
        return services;
    }
}

/// <summary>At start-up, after the jobs' own recovery: deploys nobody saw finish are marked failed.</summary>
internal sealed class StackRecovery(StackOperations stacks) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken) => stacks.RecoverAsync(cancellationToken);

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
