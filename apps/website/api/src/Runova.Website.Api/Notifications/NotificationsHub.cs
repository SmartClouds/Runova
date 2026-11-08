using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Runova.Website.Api.Accounts;
using Runova.Website.Api.CloudMonitoring;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Remote;

namespace Runova.Website.Api.Notifications;

/// <summary>What the server calls on a connected app or page.</summary>
public interface INotificationsClient
{
    /// <summary>A new message for this account.</summary>
    Task NotificationCreated(UserNotificationDto notification);

    /// <summary>The dependency findings this account sees changed; read <c>/dependency-findings</c> again.</summary>
    Task DependencySummaryChanged(DependencySummaryDto summary);

    /// <summary>An online monitor this account sees has a new result (E55).</summary>
    Task CloudMonitorUpdated(CloudMonitorLiveDto monitor);

    /// <summary>A scope's online monitors were added, changed or removed; read them again.</summary>
    Task CloudMonitorsChanged(CloudMonitorsChangedDto change);
}

public sealed record DependencySummaryDto(int Total, int Projects);

/// <summary>
/// Live messages for a signed-in account (E51): the desktop app with its device token, or the
/// website with its session cookie. The hub only sends; a client calls nothing on it. Every
/// connection of an account gets its messages, since SignalR groups them by the account id.
/// </summary>
[Authorize(Policies.Account)]
internal sealed class NotificationsHub : Hub<INotificationsClient>
{
    public const string Path = "/hubs/notifications";
}

/// <summary>The account id in the principal is what <c>Clients.User</c> matches.</summary>
internal sealed class AccountUserIdProvider : IUserIdProvider
{
    public string? GetUserId(HubConnectionContext connection) => connection.User.FindFirstValue(ClaimTypes.NameIdentifier);
}

/// <summary>
/// A WebSocket from a browser can not carry an Authorization header, so on the hub path the
/// device token may come as <c>access_token</c> in the query, as the SignalR clients send it, on
/// the notifications hub and the remote hub (E60).
/// It is moved into the header before authentication runs, and never anywhere else.
/// </summary>
internal sealed class HubAccessTokenMiddleware(RequestDelegate next)
{
    public Task InvokeAsync(HttpContext http)
    {
        if ((http.Request.Path.StartsWithSegments(NotificationsHub.Path, StringComparison.Ordinal)
                || http.Request.Path.StartsWithSegments(RemoteHub.Path, StringComparison.Ordinal))
            && http.Request.Query.TryGetValue("access_token", out var token)
            && (token.ToString().StartsWith(DeviceTokens.Prefix, StringComparison.Ordinal)
                || (http.Request.Path.StartsWithSegments(RemoteHub.Path, StringComparison.Ordinal) && token.ToString().StartsWith(RemoteAgentTokens.Prefix, StringComparison.Ordinal)))
            && string.IsNullOrEmpty(http.Request.Headers.Authorization))
        {
            http.Request.Headers.Authorization = "Bearer " + token;
        }

        return next(http);
    }
}
