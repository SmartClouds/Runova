namespace Runova.Website.Api.Remote;

/// <summary>One of the caller's own computers, as registered for Runova Anywhere (E60).</summary>
public sealed record RemoteDeviceDto(
    long Id,
    string RemoteId,
    string Name,
    string Platform,
    string Kind,
    string IdentityKey,
    bool AllowOwnDevices,
    bool UnattendedEnabled,
    IReadOnlyList<long> TeamIds,
    bool Online,
    string? AgentIdentityKey,
    DateTimeOffset CreatedAt,
    DateTimeOffset LastSeenAt);

/// <summary>Registers this computer, or updates it when it registered before.</summary>
public sealed record RegisterRemoteDeviceRequest(Guid DeviceId, string Name, string Platform, string IdentityKey);

/// <summary>A change to one of the caller's computers. Fields left out stay as they are.</summary>
public sealed record UpdateRemoteDeviceRequest(string? Name, bool? AllowOwnDevices, bool? UnattendedEnabled, IReadOnlyList<long>? TeamIds);

public sealed record RemoteDeviceListDto(IReadOnlyList<RemoteDeviceDto> Items);

public sealed record RemoteOwnerDto(long UserId, string DisplayName, string Email);

public sealed record RemoteTeamDto(long Id, string Name);

/// <summary>A computer the caller may ask to connect to: one of their own, or a teammate's shown to a shared team.</summary>
public sealed record RemoteDirectoryEntryDto(
    long Id,
    string RemoteId,
    string Name,
    string Platform,
    string Kind,
    string IdentityKey,
    bool UnattendedEnabled,
    bool Online,
    DateTimeOffset LastSeenAt,
    RemoteOwnerDto Owner,
    IReadOnlyList<RemoteTeamDto> Teams,
    IReadOnlyList<string> Features);

public sealed record RemoteDirectoryDto(IReadOnlyList<RemoteDirectoryEntryDto> Mine, IReadOnlyList<RemoteDirectoryEntryDto> Teammates);

/// <summary>A past or live session the caller was in, from either side.</summary>
public sealed record RemoteSessionDto(
    long Id,
    string Role,
    string Mode,
    string? Transport,
    string HostRemoteId,
    string HostName,
    string HostOwnerName,
    string ControllerName,
    string ControllerEmail,
    DateTimeOffset StartedAt,
    DateTimeOffset? EndedAt);

/// <summary>What a controller sends to start a connection.</summary>
public sealed record ConnectRequestDto(string RemoteId, string Mode, long? ControllerDeviceId, string Intent);

/// <summary>The computer being connected to. The name is left empty for a stranger.</summary>
public sealed record RemoteHostDto(string RemoteId, string Name, string Platform, string Kind, string IdentityKey);

/// <summary>
/// How a request went: <c>ringing</c> (the computer has it), <c>offline</c>, <c>unavailable</c>
/// (no such ID, or it does not take this kind of request; the two look the same on purpose),
/// <c>rate-limited</c>, or <c>self</c> (the caller's own computer).
/// </summary>
public sealed record ConnectResultDto(string Status, string? SessionId, string? Relation, RemoteHostDto? Host);

/// <summary>The account asking to connect, and the computer it asks from.</summary>
public sealed record RemotePeerDto(
    long UserId,
    string DisplayName,
    string Email,
    string? DeviceName,
    string? Platform,
    string? RemoteId,
    string? IdentityKey);

/// <summary>A request the computer's person sees, or that the app answers itself by its own rules.</summary>
public sealed record IncomingRequestDto(string SessionId, string Mode, string Relation, string Intent, RemotePeerDto Controller, IReadOnlyList<string> Teams);

public sealed record RequestResolvedDto(string SessionId, bool Accepted, string? Reason);

public sealed record SessionEndedDto(string SessionId, string Reason);

/// <summary>A computer came online or went offline, with what its app can do while it is online (E112).</summary>
public sealed record PresenceChangedDto(long DeviceId, string RemoteId, bool Online, IReadOnlyList<string> Features);

public static class RemoteConnectStatuses
{
    public const string Ringing = "ringing";
    public const string Offline = "offline";
    public const string Unavailable = "unavailable";
    public const string RateLimited = "rate-limited";
    public const string Self = "self";
}

/// <summary>
/// What an app can do beyond connecting, which it says when it goes online (E112). Kept in memory
/// with its presence and gone when it disconnects: nothing of it is stored.
/// </summary>
public static class RemoteFeatures
{
    /// <summary>It takes files sent to it.</summary>
    public const string ReceiveFiles = "receive-files";

    public static readonly IReadOnlyList<string> All = [ReceiveFiles];

    /// <summary>The features named that this server knows, each once, in the order named.</summary>
    public static string[] Known(IEnumerable<string>? named) =>
        named is null ? [] : [.. named.Where(All.Contains).Distinct(StringComparer.Ordinal)];
}

public static class RemoteIntents
{
    public const string Control = "control";
    public const string Files = "files";

    /// <summary>A phone working with its owner's computer: projects, terminals, git and the rest.</summary>
    public const string Manage = "manage";

    /// <summary>Sending files to a computer that takes them (E112). The files never pass the hub.</summary>
    public const string Send = "send";

    public static readonly IReadOnlyList<string> All = [Control, Files, Manage, Send];
}
