using Riok.Mapperly.Abstractions;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Cloudflare;

[Mapper]
internal static partial class DnsCredentialMapper
{
    /// <summary>What the app sees of a token: never the token itself.</summary>
    [MapProperty(nameof(DnsCredential.CreatedAt), nameof(DnsCredentialInfo.CreatedAtUnixMs))]
    [MapProperty(nameof(DnsCredential.UpdatedAt), nameof(DnsCredentialInfo.UpdatedAtUnixMs))]
    [MapProperty(nameof(DnsCredential.LastUsedAt), nameof(DnsCredentialInfo.LastUsedAtUnixMs))]
    public static partial DnsCredentialInfo ToInfo(DnsCredential row);

    /// <summary>For the core's own DNS calls; the caller unseals the token.</summary>
    public static partial DnsZoneToken ToZoneToken(DnsCredential row, string token);
}
