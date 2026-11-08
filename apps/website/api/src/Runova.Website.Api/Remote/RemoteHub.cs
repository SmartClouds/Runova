using System.Globalization;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Api.Identity;
using Runova.Website.Data;
using Runova.Website.Data.Remote;

namespace Runova.Website.Api.Remote;

/// <summary>What the remote hub calls on a connected app (E60).</summary>
public interface IRemoteClient
{
    /// <summary>Someone asks to connect to this computer.</summary>
    Task IncomingRequest(IncomingRequestDto request);

    /// <summary>The computer answered this app's request.</summary>
    Task RequestResolved(RequestResolvedDto resolved);

    /// <summary>A WebRTC signaling message from the other side, passed on untouched and never stored.</summary>
    Task Signal(string sessionId, string payload);

    /// <summary>The other side ended the session, or went away.</summary>
    Task SessionEnded(SessionEndedDto ended);

    /// <summary>A computer this account may connect to came online or went offline.</summary>
    Task PresenceChanged(PresenceChangedDto presence);
}

/// <summary>
/// Runova Anywhere's meeting point (E60). Apps register here as online, ask each other to
/// connect, and pass WebRTC signaling until they talk directly or through the relay. The hub
/// never sees a screen, a keystroke or a password: everything after signaling is encrypted between
/// the two computers, and the signaling itself is passed on without being logged or stored.
/// </summary>
[Authorize(Policies.Account)]
internal sealed partial class RemoteHub(
    AppDbContext db,
    RemotePresence presence,
    RemoteSessionRegistry sessions,
    RemoteRateLimiter limits,
    RemoteAudience audience,
    RemoteRelayTickets relayTickets,
    TimeProvider time,
    ILogger<RemoteHub> logger) : Hub<IRemoteClient>
{
    public const string Path = "/hubs/remote";

    private long Me => long.Parse(Context.UserIdentifier!, CultureInfo.InvariantCulture);

    /// <summary>The computer this connection is the background agent of (E64), or null for the app.</summary>
    private long? AgentOf => RemoteAgentTokens.AgentDevice(Context.User);

    /// <summary>This connection is now how one of the account's computers is reached.</summary>
    public async Task GoOnline(long deviceId)
    {
        var me = Me;
        var agentOf = AgentOf;
        var device = await db.RemoteDevices.SingleOrDefaultAsync(d => d.Id == deviceId && d.UserId == me && d.RevokedAt == null)
            ?? throw new HubException("There is no such computer on this account.");
        if (agentOf is not null && (agentOf != device.Id || device.AgentSecretHash is null))
        {
            throw new HubException("An agent can only host its own computer.");
        }

        var wasOnline = presence.IsOnline(device.Id);
        presence.Online(device.Id, me, Context.ConnectionId, agentOf is null ? RemoteDeviceKinds.App : RemoteDeviceKinds.Agent);
        device.LastSeenAt = time.GetUtcNow();
        await db.SaveChangesAsync();
        if (!wasOnline)
        {
            await audience.PresenceAsync(device, online: true);
        }
    }

    public async Task<ConnectResultDto> RequestConnect(ConnectRequestDto request)
    {
        if (AgentOf is not null)
        {
            throw new HubException("A background agent can not start connections.");
        }

        var me = Me;
        if (!limits.TryAcquire($"request:{me}", RemoteLimits.RequestsPerAccount, RemoteLimits.RequestWindow))
        {
            return Result(RemoteConnectStatuses.RateLimited);
        }

        if (RemoteIds.Parse(request.RemoteId) is not { } remoteId
            || !RemoteAccessModes.All.Contains(request.Mode)
            || !RemoteIntents.All.Contains(request.Intent)
            || await db.RemoteDevices.AsNoTracking().SingleOrDefaultAsync(d => d.RemoteId == remoteId && d.RevokedAt == null) is not { } target)
        {
            return Result(RemoteConnectStatuses.Unavailable);
        }

        var from = request.ControllerDeviceId is { } fromId
            ? await db.RemoteDevices.AsNoTracking().SingleOrDefaultAsync(d => d.Id == fromId && d.UserId == me && d.RevokedAt == null)
            : null;
        if (from?.Id == target.Id)
        {
            return Result(RemoteConnectStatuses.Self);
        }

        var teams = target.UserId == me ? [] : await audience.SharedTeamsAsync(target, me);
        var relation = RemoteAccess.RelationOf(me, target.UserId, teams.Count > 0);
        if (!RemoteAccess.MayRequest(relation, request.Mode, target.UnattendedEnabled))
        {
            return Result(RemoteConnectStatuses.Unavailable);
        }

        if (request.Mode == RemoteAccessModes.Password
            && !limits.TryAcquire($"password:{target.Id}", RemoteLimits.PasswordRequestsPerDevice, RemoteLimits.PasswordWindow))
        {
            return Result(RemoteConnectStatuses.RateLimited);
        }

        if (presence.EndpointOf(target.Id) is not { } endpoint)
        {
            return Result(RemoteConnectStatuses.Offline);
        }

        var hostConnection = endpoint.ConnectionId;

        if (sessions.CountFor(Context.ConnectionId) >= RemoteLimits.SessionsPerConnection
            || sessions.CountFor(hostConnection) >= RemoteLimits.SessionsPerConnection)
        {
            return Result(RemoteConnectStatuses.RateLimited);
        }

        var session = sessions.Open(new RemoteSessionParties(target.Id, target.UserId, hostConnection, me, from?.Id, Context.ConnectionId, request.Mode));
        var user = await db.Users.AsNoTracking().SingleAsync(u => u.Id == me);
        var controller = RemoteMapper.ToPeer(new RemotePeerRow { User = user, Device = from });
        var relationName = RemoteAccess.WireName(relation);
        await Clients.Client(hostConnection).IncomingRequest(
            new IncomingRequestDto(session.Id, request.Mode, relationName, request.Intent, controller, [.. teams.Select(t => t.Name)]));
        LogRinging(logger, target.Id, request.Mode, relationName);

        var host = endpoint.Kind == RemoteDeviceKinds.Agent
            ? RemoteMapper.ToHost(target) with { Kind = RemoteDeviceKinds.Agent, IdentityKey = target.AgentIdentityKey ?? "" }
            : RemoteMapper.ToHost(target);
        return new ConnectResultDto(
            RemoteConnectStatuses.Ringing,
            session.Id,
            relationName,
            relation == RemoteRelation.Other ? host with { Name = "" } : host);
    }

    /// <summary>The computer accepts or declines a ringing request.</summary>
    public async Task Respond(string sessionId, bool accept)
    {
        if (sessions.Get(sessionId) is not { State: RemoteSessionState.Ringing } session || session.Parties.HostConnectionId != Context.ConnectionId)
        {
            throw new HubException("There is no such request.");
        }

        if (accept)
        {
            if (sessions.Accept(sessionId, Context.ConnectionId) is null)
            {
                throw new HubException("There is no such request.");
            }

            await Clients.Client(session.Parties.ControllerConnectionId).RequestResolved(new RequestResolvedDto(sessionId, true, null));
            return;
        }

        sessions.Remove(sessionId);
        await Clients.Client(session.Parties.ControllerConnectionId).RequestResolved(new RequestResolvedDto(sessionId, false, "declined"));
    }

    /// <summary>Passes a signaling message to the other side of an accepted session.</summary>
    public async Task Signal(string sessionId, string payload)
    {
        if (payload.Length > RemoteLimits.MaxSignalLength)
        {
            throw new HubException("That signaling message is too large.");
        }

        if (sessions.SignalTarget(sessionId, Context.ConnectionId) is not { } target)
        {
            throw new HubException("There is no such session.");
        }

        if (!limits.TryAcquire($"signal:{sessionId}", RemoteLimits.SignalsPerSession, RemoteLimits.SignalWindow))
        {
            throw new HubException("Too many signaling messages.");
        }

        await Clients.Client(target).Signal(sessionId, payload);
    }

    /// <summary>
    /// The computer says the two are connected, after the encrypted handshake succeeded, and how.
    /// Only now is the session recorded, so a wrong password leaves no record behind.
    /// </summary>
    public async Task Connected(string sessionId, string transport)
    {
        if (sessions.Get(sessionId) is not { State: RemoteSessionState.Accepted } session
            || session.Parties.HostConnectionId != Context.ConnectionId
            || !RemoteTransports.All.Contains(transport))
        {
            throw new HubException("There is no such session.");
        }

        if (session.RecordId is { } recordId)
        {
            await db.RemoteSessionRecords.Where(r => r.Id == recordId).ExecuteUpdateAsync(r => r.SetProperty(x => x.Transport, transport));
            return;
        }

        var record = new RemoteSessionRecord
        {
            HostDeviceId = session.Parties.HostDeviceId,
            HostUserId = session.Parties.HostUserId,
            ControllerUserId = session.Parties.ControllerUserId,
            ControllerDeviceId = session.Parties.ControllerDeviceId,
            Mode = session.Parties.Mode,
            Transport = transport,
            StartedAt = time.GetUtcNow(),
        };
        db.RemoteSessionRecords.Add(record);
        await db.SaveChangesAsync();
        session.RecordId = record.Id;
    }

    /// <summary>
    /// A one-time ticket for this side of an accepted session to meet the other side on the relay
    /// (E62), when the two can not reach each other directly.
    /// </summary>
    public RelayTicketDto CreateRelayTicket(string sessionId)
    {
        if (sessions.Get(sessionId) is not { State: RemoteSessionState.Accepted } session || !session.Has(Context.ConnectionId))
        {
            throw new HubException("There is no such session.");
        }

        var side = session.Parties.HostConnectionId == Context.ConnectionId ? RelaySide.Host : RelaySide.Controller;
        return new RelayTicketDto($"{RemoteRelay.PathPrefix}/{sessionId}", relayTickets.Issue(sessionId, side));
    }

    /// <summary>Either side ends a session, ringing or live.</summary>
    public async Task End(string sessionId)
    {
        if (sessions.OtherSide(sessionId, Context.ConnectionId) is not { } other || sessions.Remove(sessionId) is not { } session)
        {
            return;
        }

        var reason = session.State == RemoteSessionState.Ringing ? "cancelled" : "ended";
        await Clients.Client(other).SessionEnded(new SessionEndedDto(sessionId, reason));
        await CloseRecordAsync(session);
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (presence.Offline(Context.ConnectionId) is { Change: PresenceChange.WentOffline, Entry: { } entry }
            && await db.RemoteDevices.AsNoTracking().SingleOrDefaultAsync(d => d.Id == entry.DeviceId) is { } device)
        {
            await audience.PresenceAsync(device, online: false);
        }

        foreach (var session in sessions.RemoveFor(Context.ConnectionId))
        {
            var other = session.Parties.HostConnectionId == Context.ConnectionId
                ? session.Parties.ControllerConnectionId
                : session.Parties.HostConnectionId;
            await Clients.Client(other).SessionEnded(new SessionEndedDto(session.Id, "left"));
            await CloseRecordAsync(session);
        }

        await base.OnDisconnectedAsync(exception);
    }

    private async Task CloseRecordAsync(RemoteSession session)
    {
        if (session.RecordId is { } recordId)
        {
            var now = time.GetUtcNow();
            await db.RemoteSessionRecords.Where(r => r.Id == recordId).ExecuteUpdateAsync(r => r.SetProperty(x => x.EndedAt, now));
        }
    }

    private static ConnectResultDto Result(string status) => new(status, null, null, null);

    [LoggerMessage(Level = LogLevel.Information, Message = "A {Mode} request from a {Relation} rings computer {DeviceId}")]
    private static partial void LogRinging(ILogger logger, long deviceId, string mode, string relation);
}
