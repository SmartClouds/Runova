using System.Globalization;
using System.Net;
using System.Net.Sockets;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.DirectTls;
using Runova.ServerCore.Nginx;
using Runova.ServerCore.Updates;
using Runova.ServerCore.Web;

namespace Runova.ServerCore.CoreDomain;

/// <summary>Whether Kestrel has the core domain's loopback port bound right now. Tests on the in-memory server fake it.</summary>
internal interface ICoreDomainBinding
{
    bool IsListening(int port);
}

internal sealed class KestrelCoreDomainBinding(IServer server) : ICoreDomainBinding
{
    public bool IsListening(int port)
    {
        var address = string.Create(CultureInfo.InvariantCulture, $"http://127.0.0.1:{port}");
        var addresses = server.Features.Get<IServerAddressesFeature>()?.Addresses ?? [];
        return addresses.Any(bound => bound.TrimEnd('/').Equals(address, StringComparison.OrdinalIgnoreCase));
    }
}

/// <summary>Refused change: the message says why, in words for the person who asked.</summary>
internal sealed class CoreDomainRefusedException(string message) : Exception(message);

/// <summary>
/// Turns the core domain on and off (E44) and says how it stands. On means three things together:
/// the core's loopback port for nginx, the reserved site that sends the domain's requests there,
/// and the key that proves a request came through nginx. The certificate is the usual one for a
/// site, issued through the certificate calls, and renewed with the rest.
/// </summary>
internal sealed partial class CoreDomainManager(
    CoreDomainStore store,
    CoreDomainEndpoint endpoint,
    ICoreDomainBinding binding,
    WebSites sites,
    IDbContextFactory<CoreDbContext> databases,
    TimeProvider time,
    ILogger<CoreDomainManager> logger) : IDisposable
{
    private static readonly TimeSpan _bindWait = TimeSpan.FromSeconds(5);

    private readonly SemaphoreSlim _gate = new(1, 1);

    private string? _error;

    public void Dispose() => _gate.Dispose();

    /// <summary>Opens the loopback port again when the mode was left on.</summary>
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var settings = store.Read();
            if (settings.Enabled)
            {
                endpoint.Open(settings.Port);
                LogOpened(logger, settings.Domain ?? string.Empty, settings.Port);
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<CoreDomainStatus> StatusAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            return await DescribeAsync(store.Read(), cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Turns the mode on, or changes the domain or sources while it is on. nginx has to be
    /// installed and running first, and the Cloudflare origin lock off.
    /// </summary>
    public async Task<CoreDomainStatus> EnableAsync(CoreDomainRequest request, Requester who, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var domain = (request.Domain ?? string.Empty).Trim().ToLowerInvariant();
        if (NginxNames.DomainProblem(domain) is { } domainProblem)
        {
            throw new CoreDomainRefusedException(domainProblem);
        }

        if (domain.StartsWith("*.", StringComparison.Ordinal))
        {
            throw new CoreDomainRefusedException("The server core answers for one domain, not a wildcard.");
        }

        if (DirectTlsSettings.ValidateSources(request.Sources, out var sources) is { } sourceProblem)
        {
            throw new CoreDomainRefusedException(sourceProblem);
        }

        await _gate.WaitAsync(cancellationToken);
        try
        {
            var (inspection, _) = await sites.InspectAsync(cancellationToken);
            if (!inspection.Installed)
            {
                throw new CoreDomainRefusedException("nginx is not installed on this server. Install it under Websites first, then come back here.");
            }

            if (!inspection.Running)
            {
                throw new CoreDomainRefusedException("nginx is installed but not running. Start it (Websites shows how) and try again.");
            }

            if (await OriginLockedAsync(cancellationToken))
            {
                throw new CoreDomainRefusedException(
                    "The Cloudflare origin lock lets only Cloudflare reach ports 80 and 443, and the core domain has to be reached directly. Turn the origin lock off under Websites first.");
            }

            var current = store.Read();
            var port = current.Enabled && current.Port > 0 ? current.Port : FreeLoopbackPort();
            var problems = await sites.SaveCoreSiteAsync(domain, port, sources, cancellationToken);
            if (problems.Length > 0)
            {
                throw new CoreDomainRefusedException(string.Join(" ", problems.Select(problem => problem.Message)));
            }

            var settings = new CoreDomainSettings(
                true,
                domain,
                port,
                current.Key ?? CoreDomainSettings.NewKey(),
                sources,
                time.GetUtcNow().ToUnixTimeMilliseconds(),
                who.UserName);
            store.Write(settings);
            endpoint.Open(port);
            _error = await WaitAsync(() => binding.IsListening(port), cancellationToken)
                ? null
                : $"The core could not open its port for nginx ({port}). Its journal says why (journalctl -u runova-core).";
            var apply = await sites.ApplyAsync(who, cancellationToken);
            if (!apply.Applied)
            {
                _error = ApplyError("nginx did not take the domain's site", apply);
            }

            LogOpened(logger, domain, port);
            return await DescribeAsync(settings, cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Takes the domain's site out of nginx and closes the core's port for it.</summary>
    public async Task<CoreDomainStatus> DisableAsync(Requester who, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var current = store.Read();
            _error = null;
            if (await sites.DeleteCoreSiteAsync(cancellationToken))
            {
                var (inspection, _) = await sites.InspectAsync(cancellationToken);
                if (inspection.Installed)
                {
                    var apply = await sites.ApplyAsync(who, cancellationToken);
                    if (!apply.Applied)
                    {
                        _error = ApplyError("nginx still runs the domain's site, but the core no longer answers it", apply);
                    }
                }
            }

            // The key goes with the site: a new one is made when the mode is turned on again.
            var settings = current with
            {
                Enabled = false,
                Key = null,
                ChangedAt = time.GetUtcNow().ToUnixTimeMilliseconds(),
                ChangedBy = who.UserName,
            };
            store.Write(settings);
            endpoint.Close();
            if (current.Port > 0 && !await WaitAsync(() => !binding.IsListening(current.Port), cancellationToken))
            {
                _error ??= $"The core's port for nginx ({current.Port}) is still open. Restart the core to close it (systemctl restart runova-core).";
            }

            return await DescribeAsync(settings, cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<CoreDomainStatus> DescribeAsync(CoreDomainSettings settings, CancellationToken cancellationToken)
    {
        var (inspection, _) = await sites.InspectAsync(cancellationToken);
        var site = settings.Enabled ? await sites.GetSiteAsync(CoreDomainSettings.SiteId, cancellationToken) : null;
        var listening = settings.Enabled && binding.IsListening(settings.Port);
        var originLocked = await OriginLockedAsync(cancellationToken);
        var certificate = site?.Certificate;
        var usable = certificate is { State: CertificateState.Valid or CertificateState.ExpiringSoon, Staging: false }
            && certificate.Source != CertificateSource.CloudflareOrigin;
        var ready = settings.Enabled && listening && site is { Applied: true } && usable
            && inspection.Running && !originLocked;
        return new CoreDomainStatus(
            settings.Enabled,
            settings.Domain,
            settings.Sources,
            inspection.Installed,
            inspection.Running,
            originLocked,
            listening,
            site is { Applied: true },
            ready,
            CoreDomainSettings.SiteId,
            certificate,
            settings.ChangedAt,
            settings.ChangedBy,
            settings.Enabled && !listening ? _error ?? "The core's port for nginx is not open yet." : _error);
    }

    private async Task<bool> OriginLockedAsync(CancellationToken cancellationToken)
    {
        await using var db = await databases.CreateDbContextAsync(cancellationToken);
        return await db.OriginLock.AsNoTracking().AnyAsync(setting => setting.Id == OriginLockSetting.SingletonId && setting.Enabled, cancellationToken);
    }

    private static string ApplyError(string what, NginxApplyResult apply)
    {
        var reasons = apply.Problems.Select(problem => problem.Message).Append(apply.Error).OfType<string>().ToArray();
        return reasons.Length == 0 ? what + "." : $"{what}: {string.Join(" ", reasons)}";
    }

    /// <summary>A port nothing on loopback uses now; the OS picks it, so it never clashes with a service.</summary>
    private static int FreeLoopbackPort()
    {
        using var probe = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
        probe.Bind(new IPEndPoint(IPAddress.Loopback, 0));
        return ((IPEndPoint)probe.LocalEndPoint!).Port;
    }

    private static async Task<bool> WaitAsync(Func<bool> done, CancellationToken cancellationToken)
    {
        // Wall-clock time on purpose: Kestrel binds in real time even when a test fakes the clock.
        var deadline = Environment.TickCount64 + (long)_bindWait.TotalMilliseconds;
        while (!done())
        {
            if (Environment.TickCount64 >= deadline)
            {
                return false;
            }

            await Task.Delay(TimeSpan.FromMilliseconds(50), cancellationToken);
        }

        return true;
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "The core domain {Domain} is on; nginx passes it to port {Port}.")]
    private static partial void LogOpened(ILogger logger, string domain, int port);
}

/// <summary>Runs <see cref="CoreDomainManager.StartAsync"/> with the host. A failure is logged, never fatal.</summary>
internal sealed partial class CoreDomainStartup(CoreDomainManager manager, ILogger<CoreDomainStartup> logger) : IHostedService
{
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            await manager.StartAsync(cancellationToken);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            LogStartFailed(logger, error);
        }
    }

    [LoggerMessage(Level = LogLevel.Error, Message = "The core domain could not start; the Unix socket is unaffected.")]
    private static partial void LogStartFailed(ILogger logger, Exception error);

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}

internal static class CoreDomainServices
{
    /// <summary>
    /// Registers the core domain's loopback port for nginx. Nothing is bound until the mode is
    /// turned on: the endpoint only exists in configuration while it is.
    /// </summary>
    public static WebApplicationBuilder AddCoreDomain(this WebApplicationBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        var endpoint = new CoreDomainEndpoint();
        ((IConfigurationBuilder)builder.Configuration).Add(endpoint);
        builder.Services.AddSingleton(endpoint);
        builder.Services.TryAddSingleton<ICoreDomainBinding, KestrelCoreDomainBinding>();
        builder.Services.AddSingleton<CoreDomainManager>();
        builder.Services.AddHostedService<CoreDomainStartup>();
        builder.WebHost.ConfigureKestrel(kestrel =>
            kestrel.ConfigurationLoader?.Endpoint(CoreDomainEndpoint.Name, CoreDomainEndpoint.Configure));
        return builder;
    }
}
