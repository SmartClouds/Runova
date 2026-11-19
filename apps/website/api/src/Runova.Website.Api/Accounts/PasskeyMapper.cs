using System.Buffers.Text;
using Microsoft.AspNetCore.Identity;
using Riok.Mapperly.Abstractions;
using Runova.Website.Core.Accounts;

namespace Runova.Website.Api.Accounts;

/// <summary>An account's passkeys as the Security page lists them, never with their keys (E115).</summary>
[Mapper]
internal static partial class PasskeyMapper
{
    public const string DefaultName = "Passkey";

    [MapProperty(nameof(UserPasskeyInfo.CredentialId), nameof(PasskeyDto.Id), Use = nameof(Base64UrlId))]
    [MapProperty(nameof(UserPasskeyInfo.Name), nameof(PasskeyDto.Name), Use = nameof(NameOrDefault))]
    [MapProperty(nameof(UserPasskeyInfo.IsBackedUp), nameof(PasskeyDto.Synced))]
    [MapperIgnoreSource(nameof(UserPasskeyInfo.PublicKey))]
    [MapperIgnoreSource(nameof(UserPasskeyInfo.SignCount))]
    [MapperIgnoreSource(nameof(UserPasskeyInfo.Transports))]
    [MapperIgnoreSource(nameof(UserPasskeyInfo.IsUserVerified))]
    [MapperIgnoreSource(nameof(UserPasskeyInfo.IsBackupEligible))]
    [MapperIgnoreSource(nameof(UserPasskeyInfo.AttestationObject))]
    [MapperIgnoreSource(nameof(UserPasskeyInfo.ClientDataJson))]
    [MapperIgnoreSource(nameof(UserPasskeyInfo.Aaguid))]
    public static partial PasskeyDto ToDto(UserPasskeyInfo passkey);

    [UserMapping(Default = false)]
    private static string Base64UrlId(byte[] credentialId) => Base64Url.EncodeToString(credentialId);

    [UserMapping(Default = false)]
    private static string NameOrDefault(string? name) => string.IsNullOrWhiteSpace(name) ? DefaultName : name;
}
