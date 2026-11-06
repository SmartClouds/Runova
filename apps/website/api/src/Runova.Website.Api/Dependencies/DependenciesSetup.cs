using System.Net;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;
using Runova.Website.Api.Notifications;
using Runova.Website.Api.Telegram;

namespace Runova.Website.Api.Dependencies;

internal static class DependenciesSetup
{
    private static readonly TimeSpan _registryTimeout = TimeSpan.FromSeconds(20);

    /// <summary>Dependency alerts (E51): the registries, the daily check, notifications over SignalR, and the Telegram bot.</summary>
    public static IServiceCollection AddWebsiteDependencies(this IServiceCollection services)
    {
        services.AddOptions<PackageRegistryOptions>().BindConfiguration("PackageRegistries");
        services.AddOptions<TelegramOptions>().BindConfiguration("Telegram");

        services.AddHttpClient<NpmRegistryClient>((provider, http) => Configure(http, provider.GetRequiredService<IOptions<PackageRegistryOptions>>().Value.Npm));
        services.AddHttpClient<PubRegistryClient>((provider, http) => Configure(http, provider.GetRequiredService<IOptions<PackageRegistryOptions>>().Value.Pub));
        services.AddHttpClient<NuGetRegistryClient>((provider, http) => Configure(http, provider.GetRequiredService<IOptions<PackageRegistryOptions>>().Value.NuGet))
            .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Brotli });
        services.AddHttpClient<OsvClient>((provider, http) => Configure(http, provider.GetRequiredService<IOptions<PackageRegistryOptions>>().Value.Osv));
        services.AddTransient<IPackageRegistry>(provider => provider.GetRequiredService<NpmRegistryClient>());
        services.AddTransient<IPackageRegistry>(provider => provider.GetRequiredService<NuGetRegistryClient>());
        services.AddTransient<IPackageRegistry>(provider => provider.GetRequiredService<PubRegistryClient>());
        services.AddHttpClient<TelegramBotClient>(http => http.Timeout = TimeSpan.FromSeconds(60))
            .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { AllowAutoRedirect = false });

        services.AddSingleton<CheckSchedule>();
        services.AddScoped<AlertSettingsStore>();
        services.AddScoped<FindingsReader>();
        services.AddScoped<AlertNotifier>();
        services.AddScoped<DependencyCheckJob>();
        services.AddScoped<TelegramOutbox>();
        services.AddScoped<TelegramOutboxJob>();
        services.AddHostedService<TelegramWebhookSetup>();

        services.AddSignalR();
        services.AddSingleton<IUserIdProvider, AccountUserIdProvider>();
        return services;
    }

    private static void Configure(HttpClient http, Uri baseAddress)
    {
        http.BaseAddress = baseAddress;
        http.Timeout = _registryTimeout;
        http.DefaultRequestHeaders.UserAgent.ParseAdd("Runova-Website/1.0 (+https://runovahq.com)");
    }

    public static RouteGroupBuilder MapDependencies(this RouteGroupBuilder api)
    {
        api.MapPackageInventories();
        api.MapDependencyAlerts();
        api.MapNotifications();
        api.MapTelegram();
        return api;
    }

    /// <summary>The query-string token for the hub has to be in the header before authentication runs.</summary>
    public static IApplicationBuilder UseHubAccessTokens(this IApplicationBuilder app) => app.UseMiddleware<HubAccessTokenMiddleware>();

    public static IEndpointRouteBuilder MapNotificationsHub(this IEndpointRouteBuilder app)
    {
        app.MapHub<NotificationsHub>(NotificationsHub.Path);
        return app;
    }
}
