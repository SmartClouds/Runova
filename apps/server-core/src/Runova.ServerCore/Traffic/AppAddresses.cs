using System.Net;
using Microsoft.AspNetCore.SignalR;
using Runova.ServerCore.Firewall;
using Runova.ServerCore.Hubs;

namespace Runova.ServerCore.Traffic;

/// <summary>The addresses the app connects from, so blocking never shuts out whoever runs the server (E110).</summary>
internal interface IAppAddresses
{
    /// <summary>The address this hub connection comes from, when the core can tell.</summary>
    Task<IpKey?> OfAsync(HubCallerContext context, CancellationToken cancellationToken);

    /// <summary>Every address an app is connected from right now.</summary>
    Task<IReadOnlyList<IpKey>> CurrentAsync(CancellationToken cancellationToken);
}

/// <summary>
/// Where each open hub connection comes from: the peer's own address over direct TLS (E16); the
/// address nginx passed on in X-Forwarded-For over the core's own domain (E44), where nginx sets the
/// header itself and the peer is loopback; otherwise, over SSH, the SSH connection's client, found
/// the way the firewall finds it (E04).
/// </summary>
internal sealed class AppAddresses(HubConnections connections, ICallerConnections callers, ISshdSettings sshd, TimeProvider time) : IAppAddresses
{
    private static readonly TimeSpan _portsFor = TimeSpan.FromMinutes(1);

    private readonly Lock _gate = new();
    private (DateTimeOffset At, int[] Ports)? _ports;

    public async Task<IpKey?> OfAsync(HubCallerContext context, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(context);
        return AddressOf(context.GetHttpContext(), context.ConnectionId, await PortsAsync(cancellationToken));
    }

    public async Task<IReadOnlyList<IpKey>> CurrentAsync(CancellationToken cancellationToken)
    {
        var ports = await PortsAsync(cancellationToken);
        return [.. connections.Contexts
            .Select(context => AddressOf(context.GetHttpContext(), context.ConnectionId, ports))
            .OfType<IpKey>()
            .Distinct()];
    }

    private IpKey? AddressOf(HttpContext? http, string connectionId, int[] ports)
    {
        if (http?.Connection.RemoteIpAddress is { } remote)
        {
            if (!IPAddress.IsLoopback(remote))
            {
                return IpKey.FromAddress(remote);
            }

            var forwarded = http.Request.Headers["X-Forwarded-For"].ToString();
            var first = forwarded.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
            if (first is not null && IpKey.TryParse(first, out var visitor))
            {
                return visitor;
            }
        }

        return callers.Identify(http, connectionId, ports).Ssh?.Client is { } client ? IpKey.FromAddress(client) : null;
    }

    private async Task<int[]> PortsAsync(CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            if (_ports is { } known && time.GetUtcNow() - known.At < _portsFor)
            {
                return known.Ports;
            }
        }

        var ports = (await sshd.ReadAsync(cancellationToken)).Ports;
        lock (_gate)
        {
            _ports = (time.GetUtcNow(), ports);
        }

        return ports;
    }
}
