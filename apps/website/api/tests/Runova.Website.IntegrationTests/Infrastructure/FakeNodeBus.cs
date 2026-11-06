using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Runova.Monitoring.Contracts.Grpc;
using Runova.Website.Api.Monitoring;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>Records what the API would tell the gateways (E54).</summary>
public sealed class FakeNodeBus : INodeBus
{
    public ConcurrentQueue<(long NodeId, ServerMessage Message)> Sent { get; } = new();

    public ConcurrentQueue<(long NodeId, IReadOnlyList<string> Serials)> Revoked { get; } = new();

    public ConcurrentQueue<(long NodeId, string Reason)> Closed { get; } = new();

    public ValueTask SendAsync(long nodeId, ServerMessage message, CancellationToken ct = default)
    {
        Sent.Enqueue((nodeId, message));
        return ValueTask.CompletedTask;
    }

    public ValueTask RevokedAsync(long nodeId, IReadOnlyList<string> serials, CancellationToken ct = default)
    {
        Revoked.Enqueue((nodeId, serials));
        return ValueTask.CompletedTask;
    }

    public ValueTask CloseAsync(long nodeId, string reason, CancellationToken ct = default)
    {
        Closed.Enqueue((nodeId, reason));
        return ValueTask.CompletedTask;
    }

    /// <summary>Puts this bus in place of the real one.</summary>
    public void Register(IServiceCollection services)
    {
        services.RemoveAll<INodeBus>();
        services.AddSingleton<INodeBus>(this);
    }
}

/// <summary>Keys and requests a node would make.</summary>
public static class TestNodeKeys
{
    public static (ECDsa Key, byte[] Csr) NewCsr(string subject = "CN=test-node")
    {
        var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var csr = new CertificateRequest(subject, key, HashAlgorithmName.SHA256).CreateSigningRequest();
        return (key, csr);
    }

    public static byte[] CsrFor(ECDsa key) =>
        new CertificateRequest("CN=test-node", key, HashAlgorithmName.SHA256).CreateSigningRequest();

    public static byte[] WeakRsaCsr()
    {
        using var rsa = RSA.Create(2048);
        return new CertificateRequest("CN=weak", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1).CreateSigningRequest();
    }
}
