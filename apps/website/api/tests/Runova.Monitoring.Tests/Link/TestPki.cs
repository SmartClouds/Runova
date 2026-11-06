using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Runova.Monitoring.Contracts;

namespace Runova.Monitoring.Tests.Link;

/// <summary>Certificates for the link tests: a Node CA, node certificates good and bad, and the gateway's server certificate.</summary>
public sealed class TestPki : IDisposable
{
    private readonly ECDsa _caKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
    private readonly ECDsa _gatewayCaKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);

    public TestPki()
    {
        Ca = MakeCa("CN=Test Node CA", _caKey);
        GatewayCa = MakeCa("CN=Test Gateway CA", _gatewayCaKey);
        Server = Issue(GatewayCa, _gatewayCaKey, "CN=localhost", ServerExtensions, DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(30));
    }

    /// <summary>The Node CA the gateway trusts.</summary>
    public X509Certificate2 Ca { get; }

    /// <summary>The CA the gateway's server certificate chains to; nodes are told to trust it.</summary>
    public X509Certificate2 GatewayCa { get; }

    public X509Certificate2 Server { get; }

    public string GatewayCaPem => GatewayCa.ExportCertificatePem();

    public NodeTrust Trust(IReadOnlyList<string>? revokedSerials = null, IReadOnlyList<long>? revokedNodes = null) =>
        new(Ca.RawData, revokedSerials ?? [], revokedNodes ?? []);

    /// <summary>A node certificate the way the API signs one.</summary>
    public X509Certificate2 Node(long nodeId, DateTimeOffset? notBefore = null, DateTimeOffset? notAfter = null, bool withSan = true) =>
        Issue(Ca, _caKey, $"CN=runova-node-{nodeId}", request => NodeExtensions(request, withSan ? nodeId : null),
            notBefore ?? DateTimeOffset.UtcNow.AddMinutes(-5), notAfter ?? DateTimeOffset.UtcNow.AddDays(7));

    /// <summary>The same shape, signed by a CA the gateway has never heard of.</summary>
    public static X509Certificate2 Stranger(long nodeId)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var ca = MakeCa("CN=Someone else", key);
        return Issue(ca, key, $"CN=runova-node-{nodeId}", request => NodeExtensions(request, nodeId),
            DateTimeOffset.UtcNow.AddMinutes(-5), DateTimeOffset.UtcNow.AddDays(7));
    }

    /// <summary>Signs a CSR the way the API does, for the fake enrollment endpoint.</summary>
    public X509Certificate2 SignCsr(long nodeId, byte[] csr)
    {
        var request = CertificateRequest.LoadSigningRequest(csr, HashAlgorithmName.SHA256);
        var signed = new CertificateRequest(new X500DistinguishedName($"CN=runova-node-{nodeId}"), request.PublicKey, HashAlgorithmName.SHA256);
        NodeExtensions(signed, nodeId);
        return signed.Create(Ca.SubjectName, X509SignatureGenerator.CreateForECDsa(_caKey),
            DateTimeOffset.UtcNow.AddMinutes(-5), DateTimeOffset.UtcNow.AddDays(7), RandomNumberGenerator.GetBytes(16));
    }

    public void Dispose()
    {
        Ca.Dispose();
        GatewayCa.Dispose();
        Server.Dispose();
        _caKey.Dispose();
        _gatewayCaKey.Dispose();
    }

    private static X509Certificate2 MakeCa(string subject, ECDsa key)
    {
        var request = new CertificateRequest(subject, key, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, true, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign, true));
        request.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(request.PublicKey, false));
        return request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddYears(1));
    }

    private static void NodeExtensions(CertificateRequest request, long? nodeId)
    {
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature, true));
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension([new Oid("1.3.6.1.5.5.7.3.2")], true));
        if (nodeId is { } id)
        {
            var san = new SubjectAlternativeNameBuilder();
            san.AddUri(new Uri(NodeIdentity.Uri(id)));
            request.CertificateExtensions.Add(san.Build(true));
        }
    }

    private static void ServerExtensions(CertificateRequest request)
    {
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature, true));
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension([new Oid("1.3.6.1.5.5.7.3.1")], true));
        var san = new SubjectAlternativeNameBuilder();
        san.AddDnsName("localhost");
        request.CertificateExtensions.Add(san.Build(true));
    }

    /// <summary>A leaf with its own key, through PKCS#12 so TLS can use the key on Windows too.</summary>
    private static X509Certificate2 Issue(X509Certificate2 ca, ECDsa caKey, string subject, Action<CertificateRequest> extensions, DateTimeOffset notBefore, DateTimeOffset notAfter)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest(subject, key, HashAlgorithmName.SHA256);
        extensions(request);
        using var certificate = request.Create(ca.SubjectName, X509SignatureGenerator.CreateForECDsa(caKey), notBefore, notAfter, RandomNumberGenerator.GetBytes(16));
        using var withKey = certificate.CopyWithPrivateKey(key);
        return X509CertificateLoader.LoadPkcs12(withKey.Export(X509ContentType.Pkcs12), null);
    }
}
