using Riok.Mapperly.Abstractions;
using Runova.Website.Data.Identity;
using Runova.Website.Data.Remote;

namespace Runova.Website.Api.Remote;

/// <summary>The account asking to connect, with the computer it asks from when it named one.</summary>
internal sealed record RemotePeerRow
{
    public required AppUser User { get; init; }

    public required RemoteDevice? Device { get; init; }
}

/// <summary>A session record joined with both sides, and which side the caller was.</summary>
internal sealed record RemoteSessionRow
{
    public required RemoteSessionRecord Record { get; init; }

    public required string Role { get; init; }

    public required RemoteDevice HostDevice { get; init; }

    public required AppUser HostUser { get; init; }

    public required AppUser ControllerUser { get; init; }
}

[Mapper]
internal static partial class RemoteMapper
{
    /// <summary>The teams the computer is shown to and whether it is online come from elsewhere.</summary>
    public static partial RemoteDeviceDto ToDto(RemoteDevice device, IReadOnlyList<long> teamIds, bool online);

    public static partial RemoteDirectoryEntryDto ToEntry(RemoteDevice device, RemoteOwnerDto owner, IReadOnlyList<RemoteTeamDto> teams, bool online);

    [MapProperty(nameof(AppUser.Id), nameof(RemoteOwnerDto.UserId))]
    [MapProperty(nameof(AppUser.Email), nameof(RemoteOwnerDto.Email), Use = nameof(OrEmpty))]
    public static partial RemoteOwnerDto ToOwner(AppUser user);

    public static partial RemoteHostDto ToHost(RemoteDevice device);

    [MapProperty([nameof(RemotePeerRow.User), nameof(AppUser.Id)], nameof(RemotePeerDto.UserId))]
    [MapProperty([nameof(RemotePeerRow.User), nameof(AppUser.DisplayName)], nameof(RemotePeerDto.DisplayName))]
    [MapProperty([nameof(RemotePeerRow.User), nameof(AppUser.Email)], nameof(RemotePeerDto.Email), Use = nameof(OrEmpty))]
    [MapProperty([nameof(RemotePeerRow.Device), nameof(RemoteDevice.Name)], nameof(RemotePeerDto.DeviceName))]
    [MapProperty([nameof(RemotePeerRow.Device), nameof(RemoteDevice.Platform)], nameof(RemotePeerDto.Platform))]
    [MapProperty([nameof(RemotePeerRow.Device), nameof(RemoteDevice.RemoteId)], nameof(RemotePeerDto.RemoteId))]
    [MapProperty([nameof(RemotePeerRow.Device), nameof(RemoteDevice.IdentityKey)], nameof(RemotePeerDto.IdentityKey))]
    public static partial RemotePeerDto ToPeer(RemotePeerRow row);

    public static partial IQueryable<RemoteSessionDto> ProjectToDto(this IQueryable<RemoteSessionRow> rows);

    [MapProperty([nameof(RemoteSessionRow.Record), nameof(RemoteSessionRecord.Id)], nameof(RemoteSessionDto.Id))]
    [MapProperty([nameof(RemoteSessionRow.Record), nameof(RemoteSessionRecord.Mode)], nameof(RemoteSessionDto.Mode))]
    [MapProperty([nameof(RemoteSessionRow.Record), nameof(RemoteSessionRecord.Transport)], nameof(RemoteSessionDto.Transport))]
    [MapProperty([nameof(RemoteSessionRow.HostDevice), nameof(RemoteDevice.RemoteId)], nameof(RemoteSessionDto.HostRemoteId))]
    [MapProperty([nameof(RemoteSessionRow.HostDevice), nameof(RemoteDevice.Name)], nameof(RemoteSessionDto.HostName))]
    [MapProperty([nameof(RemoteSessionRow.HostUser), nameof(AppUser.DisplayName)], nameof(RemoteSessionDto.HostOwnerName))]
    [MapProperty([nameof(RemoteSessionRow.ControllerUser), nameof(AppUser.DisplayName)], nameof(RemoteSessionDto.ControllerName))]
    [MapProperty([nameof(RemoteSessionRow.ControllerUser), nameof(AppUser.Email)], nameof(RemoteSessionDto.ControllerEmail), Use = nameof(OrEmpty))]
    [MapProperty([nameof(RemoteSessionRow.Record), nameof(RemoteSessionRecord.StartedAt)], nameof(RemoteSessionDto.StartedAt))]
    [MapProperty([nameof(RemoteSessionRow.Record), nameof(RemoteSessionRecord.EndedAt)], nameof(RemoteSessionDto.EndedAt))]
    public static partial RemoteSessionDto ToDto(RemoteSessionRow row);

    [UserMapping(Default = false)]
    private static string OrEmpty(string? value) => value ?? "";
}
