using Riok.Mapperly.Abstractions;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Registries;

[Mapper]
internal static partial class RegistryCredentialMapper
{
    /// <summary>What the app sees of a stored sign-in: never its secret.</summary>
    [MapProperty(nameof(RegistryCredentialRecord.CreatedAt), nameof(RegistryCredentialInfo.CreatedAtUnixMs))]
    [MapProperty(nameof(RegistryCredentialRecord.UpdatedAt), nameof(RegistryCredentialInfo.UpdatedAtUnixMs))]
    [MapProperty(nameof(RegistryCredentialRecord.LastUsedAt), nameof(RegistryCredentialInfo.LastUsedAtUnixMs))]
    public static partial RegistryCredentialInfo ToInfo(RegistryCredentialRecord row);

    /// <summary>A sign-in to keep, its secret sealed by the caller. It has not been used yet.</summary>
    [MapperIgnoreTarget(nameof(RegistryCredentialRecord.LastUsedAt))]
    public static partial RegistryCredentialRecord ToRecord(
        RegistryLogin login,
        Guid id,
        string sealedSecret,
        long createdAt,
        long updatedAt,
        string? createdBy);

    /// <summary>A stored sign-in for a pull; the caller unseals the secret.</summary>
    [MapValue(nameof(RegistryLogin.Source), RegistryLoginSource.Stored)]
    public static partial RegistryLogin ToLogin(RegistryCredentialRecord row, string secret);
}
