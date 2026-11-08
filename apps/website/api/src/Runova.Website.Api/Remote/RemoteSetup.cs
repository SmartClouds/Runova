using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Data;

namespace Runova.Website.Api.Remote;

/// <summary>
/// Runova Anywhere (E60): the hub's in-memory state, the sweeper that stops unanswered requests
/// ringing, and the nightly cleanup of old session records. The hub's state lives in this
/// instance, so the API runs as one instance while Anywhere is on it (see docs/RISKS.md).
/// </summary>
internal static class RemoteSetup
{
    public static IServiceCollection AddWebsiteRemote(this IServiceCollection services)
    {
        services.AddSingleton<RemotePresence>();
        services.AddSingleton<RemoteSessionRegistry>();
        services.AddSingleton<RemoteRateLimiter>();
        services.AddSingleton<RemoteRelayTickets>();
        services.AddSingleton<RemoteRelay>();
        services.AddScoped<RemoteAudience>();
        services.AddScoped<RemoteSessionRetentionJob>();
        services.AddHostedService<RemoteRingingSweeper>();
        return services;
    }

    public static IEndpointRouteBuilder MapRemoteHub(this IEndpointRouteBuilder app)
    {
        app.MapHub<RemoteHub>(RemoteHub.Path);
        // The relay is a plain WebSocket outside /api/v1; its one-time ticket is its credential.
        app.Map($"{RemoteRelay.PathPrefix}/{{sessionId}}", (HttpContext http, string sessionId, RemoteRelay relay) => relay.HandleAsync(http, sessionId))
            .AllowAnonymous()
            .ExcludeFromDescription();
        return app;
    }
}

/// <summary>Gives up requests no one answered within <see cref="RemoteLimits.RingFor"/>, and tells both sides.</summary>
internal sealed class RemoteRingingSweeper(RemoteSessionRegistry sessions, IHubContext<RemoteHub, IRemoteClient> hub, TimeProvider time) : BackgroundService
{
    public static readonly TimeSpan Every = TimeSpan.FromSeconds(5);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Every, time);
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            await SweepAsync();
        }
    }

    public async Task SweepAsync()
    {
        foreach (var session in sessions.ExpireRinging())
        {
            await hub.Clients.Client(session.Parties.ControllerConnectionId).RequestResolved(new RequestResolvedDto(session.Id, false, "timeout"));
            await hub.Clients.Client(session.Parties.HostConnectionId).SessionEnded(new SessionEndedDto(session.Id, "timeout"));
        }
    }
}

/// <summary>Deletes session records older than <see cref="RemoteEndpoints.KeepRecordsFor"/>.</summary>
internal sealed class RemoteSessionRetentionJob(AppDbContext db, TimeProvider time)
{
    public async Task RunAsync(CancellationToken ct)
    {
        var cutoff = time.GetUtcNow() - RemoteEndpoints.KeepRecordsFor;
        await db.RemoteSessionRecords.Where(r => r.StartedAt < cutoff).ExecuteDeleteAsync(ct);
    }
}
