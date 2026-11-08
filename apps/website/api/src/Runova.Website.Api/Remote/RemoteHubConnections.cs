using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;

namespace Runova.Website.Api.Remote;

/// <summary>
/// Which account session each hub connection belongs to. A token is only checked when a connection
/// opens, so ending a sign-in closes its connections here, which also ends their sessions.
/// </summary>
internal sealed class RemoteHubConnections
{
    private readonly ConcurrentDictionary<string, (long AccountSessionId, HubCallerContext Context)> _connections = new(StringComparer.Ordinal);

    public void Add(long accountSessionId, HubCallerContext context) => _connections[context.ConnectionId] = (accountSessionId, context);

    public void Remove(string connectionId) => _connections.TryRemove(connectionId, out _);

    public void Close(long accountSessionId)
    {
        foreach (var (_, connection) in _connections)
        {
            if (connection.AccountSessionId == accountSessionId)
            {
                connection.Context.Abort();
            }
        }
    }
}
