using System.Diagnostics.CodeAnalysis;
using System.Text.Json;
using Riok.Mapperly.Abstractions;
using Runova.ServerCore.Certificates.Acme;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Certificates;

[Mapper]
internal static partial class CertificateMapper
{
    /// <summary>The row as the app sees it, its state judged at <paramref name="now"/>.</summary>
    public static CertificateInfo ToInfo(SiteCertificate row, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(row);
        var nowMs = now.ToUnixTimeMilliseconds();
        var state = row.RevokedAt is not null ? CertificateState.Revoked
            : row.NotAfter <= nowMs ? CertificateState.Expired
            : row.NotAfter - nowMs < (long)CertificateViews.ExpiringSoon.TotalMilliseconds ? CertificateState.ExpiringSoon
            : CertificateState.Valid;
        return ToInfo(row, state);
    }

    /// <summary>
    /// An ACME certificate as the issuer works with it. The caller has checked that the row has a
    /// directory and a certificate id, and passes the key it unsealed.
    /// </summary>
    [MapProperty(nameof(SiteCertificate.SiteId), nameof(AcmeCertificateRecord.Name))]
    [MapProperty(nameof(SiteCertificate.DirectoryUrl), nameof(AcmeCertificateRecord.DirectoryUrl), Use = nameof(DirectoryOf))]
    [MapPropertyFromSource(nameof(AcmeCertificateRecord.Domains), Use = nameof(DomainList))]
    [MapProperty(nameof(SiteCertificate.KeyType), nameof(AcmeCertificateRecord.KeyType), Use = nameof(KeyTypeOf))]
    [MapProperty(nameof(SiteCertificate.CertificateId), nameof(AcmeCertificateRecord.CertificateId), Use = nameof(Checked))]
    public static partial AcmeCertificateRecord ToRecord(SiteCertificate row, byte[] privateKeyPkcs8);

    /// <summary>The caller unseals the key, and disposes of it with the account.</summary>
    [MapProperty(nameof(AcmeAccountRecord.Status), nameof(AcmeAccount.Status), Use = nameof(StatusOf))]
    [MapProperty(nameof(AcmeAccountRecord.Contact), nameof(AcmeAccount.Contact), Use = nameof(ContactOf))]
    public static partial AcmeAccount ToAccount(AcmeAccountRecord row, AcmeAccountKey key);

    /// <summary>The reason as RFC 5280 numbers it; one the app does not know is unspecified.</summary>
    [MapEnum(EnumMappingStrategy.ByName, FallbackValue = AcmeRevocationReason.Unspecified)]
    [MapperIgnoreTargetValue(AcmeRevocationReason.AffiliationChanged)]
    public static partial AcmeRevocationReason ToAcme(CertificateRevocationReason reason);

    [MapProperty(nameof(SiteCertificate.Source), nameof(CertificateInfo.Source), Use = nameof(SourceOf))]
    [MapPropertyFromSource(nameof(CertificateInfo.Domains), Use = nameof(Domains))]
    [MapPropertyFromSource(nameof(CertificateInfo.Staging), Use = nameof(IsStaging))]
    [MapProperty(nameof(SiteCertificate.NotBefore), nameof(CertificateInfo.NotBeforeUnixMs))]
    [MapProperty(nameof(SiteCertificate.NotAfter), nameof(CertificateInfo.NotAfterUnixMs))]
    [MapProperty(nameof(SiteCertificate.RenewAt), nameof(CertificateInfo.RenewAtUnixMs))]
    [MapProperty(nameof(SiteCertificate.LastAttemptAt), nameof(CertificateInfo.LastAttemptAtUnixMs))]
    [MapProperty(nameof(SiteCertificate.NextAttemptAt), nameof(CertificateInfo.NextAttemptAtUnixMs))]
    [MapProperty(nameof(SiteCertificate.RevokedAt), nameof(CertificateInfo.RevokedAtUnixMs))]
    private static partial CertificateInfo ToInfo(SiteCertificate row, CertificateState state);

    private static CertificateSource SourceOf(string source) => source switch
    {
        CertificateViews.UploadedSource => CertificateSource.Uploaded,
        CertificateViews.CloudflareOriginSource => CertificateSource.CloudflareOrigin,
        _ => CertificateSource.Acme,
    };

    private static string[] Domains(SiteCertificate row) => CertificateViews.DomainsOf(row);

    [SuppressMessage("Performance", "CA1859", Justification = "Mapperly needs the target member's own type.")]
    private static IReadOnlyList<string> DomainList(SiteCertificate row) => CertificateViews.DomainsOf(row);

    private static bool IsStaging(SiteCertificate row) =>
        row.DirectoryUrl is { } directory && CertificateViews.IsStaging(new Uri(directory));

    private static Uri DirectoryOf(string? directoryUrl) => new(directoryUrl!);

    private static AcmeCertificateKeyType KeyTypeOf(string keyType) => Enum.Parse<AcmeCertificateKeyType>(keyType);

    private static string Checked(string? value) => value!;

    [UserMapping(Default = true)]
    private static DateTimeOffset FromUnixMs(long unixMs) => DateTimeOffset.FromUnixTimeMilliseconds(unixMs);

    [UserMapping(Default = true)]
    private static Uri ToUri(string url) => new(url);

    private static AcmeStatus StatusOf(string status) => AcmeStatuses.Parse(status);

    [SuppressMessage("Performance", "CA1859", Justification = "Mapperly needs the target member's own type.")]
    private static IReadOnlyList<string> ContactOf(string contact) => JsonSerializer.Deserialize<string[]>(contact, CoreJson.Options) ?? [];
}
