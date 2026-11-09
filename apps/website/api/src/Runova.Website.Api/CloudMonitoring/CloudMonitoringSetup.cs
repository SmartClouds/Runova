using Runova.Website.Api.Accounts;
using Runova.Website.Api.Billing;
using Runova.Website.Api.Monitoring;

namespace Runova.Website.Api.CloudMonitoring;

/// <summary>
/// Online monitors (E55): the endpoints, the assigner the nodes get their monitors from, the
/// ingestor their results go to, the notifier, plan enforcement and the nightly retention.
/// </summary>
internal static class CloudMonitoringSetup
{
    public static IServiceCollection AddWebsiteCloudMonitoring(this IServiceCollection services)
    {
        services.AddSingleton<CloudMonitorSecrets>();
        services.AddScoped<CloudMonitorViews>();
        services.AddScoped<CloudMonitorNotifier>();
        services.AddScoped<MonitorAssigner>();
        services.AddScoped<IAssignmentSource>(provider => provider.GetRequiredService<MonitorAssigner>());
        services.AddScoped<INodeRebalancer>(provider => provider.GetRequiredService<MonitorAssigner>());
        services.AddScoped<IResultIngestor, CloudMonitorIngestor>();
        services.AddScoped<EncryptionEnforcement>();
        services.AddScoped<PlanEnforcement>();
        services.AddScoped<IPlanEnforcement>(provider => provider.GetRequiredService<PlanEnforcement>());
        services.AddScoped<SampleRetentionJob>();
        return services;
    }
}
