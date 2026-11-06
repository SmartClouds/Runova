using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Runova.Monitoring.Node;

/// <summary>Enrollment could not finish; the message says what to do.</summary>
public sealed class EnrollmentException(string message) : Exception(message);

/// <summary>
/// The node's key and certificate (E54). The key is made here and never leaves the machine: it is a
/// PEM file only its owner can read, next to the SQLite file. Enrolling sends a CSR and the
/// one-time token to the API over HTTPS; renewing goes through the gateway with the current
/// certificate.
/// </summary>
public sealed class NodeIdentityStore(
    IDbContextFactory<NodeDb> factory, IHttpClientFactory http, IOptions<NodeOptions> options, IHostEnvironment environment)
{
    public const string EnrollmentClient = "enrollment";

    private string KeyPath => Path.Combine(options.Value.DataPath, "node.key");

    /// <summary>The state once enrolled; enrolls first when there is none.</summary>
    public async Task<NodeState> EnsureEnrolledAsync(CancellationToken ct)
    {
        await using (var db = await factory.CreateDbContextAsync(ct))
        {
            if (await db.State.AsNoTracking().SingleOrDefaultAsync(ct) is { } state && File.Exists(KeyPath))
            {
                return state;
            }
        }

        return await EnrollAsync(ct);
    }

    /// <summary>The client certificate with its private key, ready for TLS.</summary>
    public X509Certificate2 ClientCertificate(NodeState state)
    {
        using var key = LoadKey();
        using var certificate = X509CertificateLoader.LoadCertificate(state.Certificate);
        using var withKey = certificate.CopyWithPrivateKey(key);
        // Through PKCS#12 so the key stays usable for TLS on every platform.
        return X509CertificateLoader.LoadPkcs12(withKey.Export(X509ContentType.Pkcs12), null);
    }

    /// <summary>A CSR for the key the node already has, for renewing.</summary>
    public byte[] RenewalRequest()
    {
        using var key = LoadKey();
        return new CertificateRequest("CN=runova-node", key, HashAlgorithmName.SHA256).CreateSigningRequest();
    }

    public async Task SaveRenewedAsync(byte[] certificate, byte[]? ca, CancellationToken ct)
    {
        using var parsed = X509CertificateLoader.LoadCertificate(certificate);
        await using var db = await factory.CreateDbContextAsync(ct);
        var state = await db.State.SingleAsync(ct);
        state.Certificate = certificate;
        state.NotAfter = parsed.NotAfter.ToUniversalTime();
        if (ca is { Length: > 0 })
        {
            state.CaCertificate = ca;
        }

        await db.SaveChangesAsync(ct);
    }

    private async Task<NodeState> EnrollAsync(CancellationToken ct)
    {
        var settings = options.Value;
        if (string.IsNullOrWhiteSpace(settings.EnrollmentToken))
        {
            throw new EnrollmentException("This node has not enrolled yet. Set NODE_ENROLLMENT_TOKEN to the token from its page on /admin/monitoring-nodes.");
        }

        if (!Uri.TryCreate(settings.ApiUrl, UriKind.Absolute, out var api)
            || (api.Scheme != Uri.UriSchemeHttps && !(settings.AllowInsecureApi && environment.IsDevelopment())))
        {
            throw new EnrollmentException("Set RUNOVA_API_URL to the website's https address, such as https://runovahq.com.");
        }

        Directory.CreateDirectory(settings.DataPath);
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var csr = new CertificateRequest("CN=runova-node", key, HashAlgorithmName.SHA256).CreateSigningRequest();

        using var client = http.CreateClient(EnrollmentClient);
        using var response = await client.PostAsJsonAsync(
            new Uri(api, "/api/v1/monitoring-node-enrollments"),
            new { token = settings.EnrollmentToken.Trim(), csr = Convert.ToBase64String(csr) },
            ct);
        if (!response.IsSuccessStatusCode)
        {
            throw new EnrollmentException(response.StatusCode switch
            {
                System.Net.HttpStatusCode.Unauthorized => "The enrollment token was refused: it was used already or ran out. Make a new one on the node's page.",
                System.Net.HttpStatusCode.ServiceUnavailable => "Online monitoring is not set up on the website yet.",
                _ => $"Enrollment failed with HTTP {(int)response.StatusCode}.",
            });
        }

        var enrolled = await response.Content.ReadFromJsonAsync<EnrollmentAnswer>(ct)
            ?? throw new EnrollmentException("The enrollment answer was empty.");
        var certificate = Convert.FromBase64String(enrolled.Certificate);
        using var parsed = X509CertificateLoader.LoadCertificate(certificate);

        WriteKey(key);
        var state = new NodeState
        {
            NodeId = enrolled.NodeId,
            Certificate = certificate,
            CaCertificate = Convert.FromBase64String(enrolled.CaCertificates[0]),
            GatewayAddress = enrolled.GatewayAddress,
            NotAfter = parsed.NotAfter.ToUniversalTime(),
        };
        await using var db = await factory.CreateDbContextAsync(ct);
        db.State.RemoveRange(db.State);
        db.State.Add(state);
        await db.SaveChangesAsync(ct);
        return state;
    }

    private void WriteKey(ECDsa key)
    {
        var pem = key.ExportPkcs8PrivateKeyPem();
        var temporary = KeyPath + ".new";
        if (OperatingSystem.IsWindows())
        {
            File.WriteAllText(temporary, pem);
        }
        else
        {
            using var stream = new FileStream(temporary, new FileStreamOptions
            {
                Mode = FileMode.Create,
                Access = FileAccess.Write,
                UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite,
            });
            using var writer = new StreamWriter(stream);
            writer.Write(pem);
        }

        File.Move(temporary, KeyPath, overwrite: true);
    }

    private ECDsa LoadKey()
    {
        var key = ECDsa.Create();
        key.ImportFromPem(File.ReadAllText(KeyPath));
        return key;
    }

    private sealed record EnrollmentAnswer(long NodeId, string Certificate, string[] CaCertificates, string GatewayAddress, DateTimeOffset ExpiresAt);
}
