using Runova.ServerCore.Certificates.Acme;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Hosting;
using Runova.ServerCore.Platform;

namespace Runova.ServerCore.Cloudflare;

/// <summary>What the hub's Cloudflare methods use, in one place so the hub takes one parameter for them.</summary>
internal sealed record CloudflareServices(
    OriginLockService OriginLock,
    OriginCertificates OriginCertificates,
    DnsCredentials DnsCredentials,
    CloudflareTunnelService Tunnel);

internal static class CloudflareServiceCollection
{
    /// <summary>
    /// Cloudflare on the server (E14): its API over HTTPS, the origin lock with its daily refresh,
    /// Origin CA certificates, DNS-01 and the Cloudflare Tunnel (E95). Call after the web operations
    /// and Docker's (whose repository keys cloudflared's install shares). The DevHost and the tests
    /// register fakes for the API and for cloudflared after this.
    /// </summary>
    public static IServiceCollection AddCloudflare(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        services.AddSingleton<ICloudflareHttp, CloudflareHttp>();
        services.AddSingleton<CloudflareApi>();
        services.AddSingleton<ICloudflareRangeSource>(provider => provider.GetRequiredService<CloudflareApi>());
        services.AddSingleton<ICloudflareDnsApi>(provider => provider.GetRequiredService<CloudflareApi>());
        services.AddSingleton(OriginLockOptions.Default);
        services.AddSingleton(CloudflareDns01Options.Default);
        services.AddSingleton<DnsCredentials>();
        services.AddSingleton<CloudflareDns01Hook>();
        services.AddSingleton<IDns01ChallengeHook>(provider => provider.GetRequiredService<CloudflareDns01Hook>());
        services.AddSingleton<OriginCertificates>();
        services.AddSingleton<OriginLockService>();
        services.AddSingleton<ICloudflared>(provider => new LinuxCloudflared(
            provider.GetRequiredService<IProcessRunner>(),
            provider.GetRequiredService<SystemdRunner>(),
            provider.GetRequiredService<ISystemFiles>(),
            provider.GetRequiredService<OsInfo>(),
            provider.GetRequiredService<IRepositoryKeys>(),
            CoreLayout.Current.ConfigDirectory));
        services.AddSingleton<ICloudflaredHealth, HttpCloudflaredHealth>();
        services.AddSingleton<ICloudflareMesh>(provider => new LinuxCloudflareMesh(
            provider.GetRequiredService<IProcessRunner>(),
            provider.GetRequiredService<SystemdRunner>(),
            provider.GetRequiredService<ISystemFiles>(),
            provider.GetRequiredService<OsInfo>(),
            provider.GetRequiredService<IRepositoryKeys>(),
            provider.GetRequiredService<TimeProvider>()));
        services.AddSingleton(CloudflareTunnelOptions.Default);
        services.AddSingleton<CloudflareTunnelService>();
        services.AddSingleton<CloudflareServices>();
        services.AddHostedService(provider => provider.GetRequiredService<OriginLockService>());
        services.AddHostedService(provider => provider.GetRequiredService<CloudflareTunnelService>());
        return services;
    }
}
