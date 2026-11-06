using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Runova.Monitoring.Contracts;
using Runova.Website.Data;
using Runova.Website.Data.Monitoring;

namespace Runova.Website.Api.Monitoring;

/// <summary>Why a CSR was refused, in a sentence an Admin or the node's log can show.</summary>
public sealed class CertificateRequestException(string message) : Exception(message);

/// <summary>A signed node certificate, with the CA bundle the node pins.</summary>
public sealed record IssuedCertificate(byte[] Certificate, string Serial, DateTimeOffset NotAfter, byte[] CaCertificate);

/// <summary>
/// The private Node CA (E54). It signs the client certificates nodes connect with: ECDSA P-256,
/// 7 days, the node's id as a URI in the SAN. Its key is sealed with Data Protection in Postgres and
/// never leaves the API; the gateway only gets the CA certificate.
/// </summary>
public sealed class NodeCertificateAuthority(AppDbContext db, IDataProtectionProvider protection, TimeProvider time)
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromDays(7);

    /// <summary>Back-dating covers a node whose clock runs a little behind.</summary>
    private static readonly TimeSpan _skew = TimeSpan.FromMinutes(5);

    private const string Purpose = "Runova.NodeAuthority.v1";
    private const string ClientAuthOid = "1.3.6.1.5.5.7.3.2";

    /// <summary>The CA certificate, made on first use.</summary>
    public async Task<X509Certificate2> GetCertificateAsync(CancellationToken ct = default)
    {
        var row = await LoadAsync(ct);
        return X509CertificateLoader.LoadCertificate(row.Certificate);
    }

    /// <summary>Checks a PKCS#10 request and signs a certificate for <paramref name="nodeId"/>.</summary>
    public async Task<IssuedCertificate> IssueAsync(long nodeId, byte[] csr, byte[]? requiredKeyHash, CancellationToken ct = default)
    {
        var request = ReadRequest(csr);
        var publicKey = request.PublicKey;
        var keyHash = SHA256.HashData(publicKey.ExportSubjectPublicKeyInfo());
        if (requiredKeyHash is not null && !CryptographicOperations.FixedTimeEquals(keyHash, requiredKeyHash))
        {
            throw new CertificateRequestException("A renewal must keep the key the node already has.");
        }

        var row = await LoadAsync(ct);
        using var caCertificate = X509CertificateLoader.LoadCertificate(row.Certificate);
        using var caKey = ECDsa.Create();
        caKey.ImportPkcs8PrivateKey(Protector().Unprotect(Convert.FromBase64String(row.SealedPrivateKey)), out _);

        var signed = new CertificateRequest(
            new X500DistinguishedName($"CN=runova-node-{nodeId}"), publicKey, HashAlgorithmName.SHA256);
        signed.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        signed.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature, true));
        signed.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension([new Oid(ClientAuthOid)], true));
        var san = new SubjectAlternativeNameBuilder();
        san.AddUri(new Uri(NodeIdentity.Uri(nodeId)));
        signed.CertificateExtensions.Add(san.Build(true));
        signed.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(publicKey, false));
        signed.CertificateExtensions.Add(X509AuthorityKeyIdentifierExtension.CreateFromCertificate(caCertificate, true, false));

        var now = time.GetUtcNow();
        var notBefore = now - _skew;
        var notAfter = now + Lifetime;
        var serial = NewSerial();
        using var certificate = signed.Create(
            caCertificate.SubjectName, X509SignatureGenerator.CreateForECDsa(caKey), notBefore, notAfter, serial);

        db.NodeCertificates.Add(new NodeCertificate
        {
            Serial = certificate.SerialNumber,
            NodeId = nodeId,
            PublicKeyHash = keyHash,
            NotBefore = notBefore,
            NotAfter = notAfter,
        });
        return new IssuedCertificate(certificate.RawData, certificate.SerialNumber, notAfter, row.Certificate);
    }

    /// <summary>
    /// Reads a CSR, checks its signature and refuses keys too weak to trust: ECDSA below P-256 and
    /// RSA below 3072 bits.
    /// </summary>
    public static CertificateRequest ReadRequest(byte[] csr)
    {
        CertificateRequest request;
        try
        {
            request = CertificateRequest.LoadSigningRequest(csr, HashAlgorithmName.SHA256, CertificateRequestLoadOptions.Default);
        }
        catch (CryptographicException)
        {
            throw new CertificateRequestException("The certificate request is not a signed PKCS#10 request.");
        }

        using var ec = request.PublicKey.GetECDsaPublicKey();
        if (ec is not null)
        {
            if (ec.KeySize < 256)
            {
                throw new CertificateRequestException("The key is too weak: use ECDSA P-256 or stronger.");
            }

            return request;
        }

        using var rsa = request.PublicKey.GetRSAPublicKey();
        if (rsa is not null)
        {
            if (rsa.KeySize < 3072)
            {
                throw new CertificateRequestException("The key is too weak: use ECDSA P-256, or RSA with 3072 bits or more.");
            }

            return request;
        }

        throw new CertificateRequestException("The key must be ECDSA or RSA.");
    }

    /// <summary>SHA-256 of a certificate's SubjectPublicKeyInfo, the way renewals compare keys.</summary>
    public static byte[] KeyHash(X509Certificate2 certificate) =>
        SHA256.HashData(certificate.PublicKey.ExportSubjectPublicKeyInfo());

    private async Task<NodeAuthority> LoadAsync(CancellationToken ct)
    {
        if (await db.NodeAuthorities.AsNoTracking().SingleOrDefaultAsync(ct) is { } existing)
        {
            return existing;
        }

        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest("CN=Runova Node CA, O=Runova", key, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, true, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign, true));
        request.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(request.PublicKey, false));
        var now = time.GetUtcNow();
        using var certificate = request.CreateSelfSigned(now - _skew, now.AddYears(10));

        var row = new NodeAuthority
        {
            Certificate = certificate.RawData,
            SealedPrivateKey = Convert.ToBase64String(Protector().Protect(key.ExportPkcs8PrivateKey())),
            CreatedAt = now,
        };

        // Two first enrollments at once: one insert wins and both use its key.
        try
        {
            await db.Database.ExecuteSqlInterpolatedAsync(
                $"""INSERT INTO "NodeAuthorities" ("Id", "Certificate", "SealedPrivateKey", "CreatedAt") VALUES ({NodeAuthority.SingletonId}, {row.Certificate}, {row.SealedPrivateKey}, {row.CreatedAt}) ON CONFLICT ("Id") DO NOTHING""",
                ct);
        }
        catch (PostgresException)
        {
            // Read below whichever row is there.
        }

        return await db.NodeAuthorities.AsNoTracking().SingleAsync(ct);
    }

    private IDataProtector Protector() => protection.CreateProtector(Purpose);

    /// <summary>A random positive 16 byte serial, as RFC 5280 asks (at most 20 bytes, not negative).</summary>
    private static byte[] NewSerial()
    {
        var serial = RandomNumberGenerator.GetBytes(16);
        serial[0] &= 0x7F;
        serial[0] |= 0x01;
        return serial;
    }
}
