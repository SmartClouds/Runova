using Riok.Mapperly.Abstractions;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Hubs;

/// <summary>Users, their devices and sessions as the hub lists them. Keys, stamps and hashes stay on the server.</summary>
[Mapper]
internal static partial class AccountMapper
{
    /// <summary>The owner's name comes from the users table; current is the caller's own device.</summary>
    [MapPropertyFromSource(nameof(DeviceInfo.Revoked), Use = nameof(IsRevoked))]
    [MapProperty(nameof(Device.CreatedAt), nameof(DeviceInfo.CreatedAtUnixMs))]
    [MapProperty(nameof(Device.LastSeenAt), nameof(DeviceInfo.LastSeenAtUnixMs))]
    public static partial DeviceInfo ToInfo(Device device, string userName, bool current);

    /// <summary>The device's name comes from the devices table; current is the caller's own session.</summary>
    [MapProperty(nameof(DeviceSession.CreatedAt), nameof(SessionInfo.CreatedAtUnixMs))]
    [MapProperty(nameof(DeviceSession.LastRenewedAt), nameof(SessionInfo.LastRenewedAtUnixMs))]
    [MapProperty(nameof(DeviceSession.ExpiresAt), nameof(SessionInfo.ExpiresAtUnixMs))]
    public static partial SessionInfo ToInfo(DeviceSession session, string deviceName, bool current);

    /// <summary>Role, lockout, last sign-in and device count come from other tables and the clock.</summary>
    [MapProperty(nameof(CoreUser.UserName), nameof(UserInfo.UserName), Use = nameof(NameOf))]
    [MapProperty(nameof(CoreUser.CreatedAt), nameof(UserInfo.CreatedAtUnixMs))]
    public static partial UserInfo ToInfo(
        CoreUser user,
        string? role,
        bool disabled,
        long? lockedOutUntilUnixMs,
        long? lastSignInAtUnixMs,
        int devices,
        bool current);

    private static bool IsRevoked(Device device) => device.RevokedAt is not null;

    private static string NameOf(string? userName) => userName ?? string.Empty;
}
