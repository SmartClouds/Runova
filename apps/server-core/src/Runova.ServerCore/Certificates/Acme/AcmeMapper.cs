using Riok.Mapperly.Abstractions;

namespace Runova.ServerCore.Certificates.Acme;

[Mapper]
internal static partial class AcmeMapper
{
    /// <summary>
    /// The stored certificate's names, key type and chain again, replacing <paramref name="replaces"/>
    /// when the caller found it is this CA's to replace. Challenge type and profile stay the defaults.
    /// </summary>
    [MapperIgnoreTarget(nameof(AcmeIssueRequest.PreferDns01))]
    [MapperIgnoreTarget(nameof(AcmeIssueRequest.Profile))]
    public static partial AcmeIssueRequest ToRenewal(AcmeCertificateRecord existing, string? replaces);
}
