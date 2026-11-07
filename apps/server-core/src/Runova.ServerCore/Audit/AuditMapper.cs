using Riok.Mapperly.Abstractions;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Audit;

[Mapper]
internal static partial class AuditMapper
{
    /// <summary>
    /// An event as the app reads it, with the actor's and device's names as they are now. The ids
    /// stay what the chain recorded, and the hashes stay on the server.
    /// </summary>
    [MapProperty(nameof(AuditEvent.At), nameof(AuditEventInfo.AtUnixMs))]
    public static partial AuditEventInfo ToInfo(AuditEvent auditEvent, string? actorUserName, string? deviceName);

    public static partial AuditVerificationInfo ToInfo(AuditVerification verification);

    /// <summary>
    /// An entry as the next link of the chain: the caller picks its id, time and previous hash, and
    /// passes the parameters already redacted. The hash is filled in once the row is complete.
    /// </summary>
    [MapperIgnoreSource(nameof(AuditEntry.Parameters))]
    [MapValue(nameof(AuditEvent.Hash), "")]
    public static partial AuditEvent ToEvent(AuditEntry entry, long id, long at, string? parameters, string prevHash);
}
