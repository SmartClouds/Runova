using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Runova.Monitoring.Contracts;

namespace Runova.Monitoring.Gateway;

/// <summary>
/// What the gateway trusts: the Node CA certificate and what is revoked, loaded from the API. Until
/// the first load it refuses every node, so a gateway that can not reach the API fails closed.
/// </summary>
public sealed class GatewayTrust(TimeProvider time)
{
    private static readonly Oid _clientAuth = new("1.3.6.1.5.5.7.3.2");

    private volatile State? _state;

    private sealed record State(X509Certificate2 Ca, ImmutableHashSet<string> RevokedSerials, ImmutableHashSet<long> RevokedNodes);

    public bool Ready => _state is not null;

    /// <summary>Replaces what is trusted with a fresh list from the API.</summary>
    public void Load(NodeTrust trust)
    {
        var ca = X509CertificateLoader.LoadCertificate(trust.CaCertificate);
        _state = new State(
            ca,
            trust.RevokedSerials.ToImmutableHashSet(StringComparer.OrdinalIgnoreCase),
            [.. trust.RevokedNodeIds]);
    }

    /// <summary>Adds serials pushed by the API when a node is revoked, before the next full load.</summary>
    public void Revoke(IReadOnlyList<string> serials)
    {
        while (_state is { } state)
        {
            var next = state with { RevokedSerials = state.RevokedSerials.Union(serials) };
            if (Interlocked.CompareExchange(ref _state, next, state) == state)
            {
                return;
            }
        }
    }

    /// <summary>
    /// Checks a client certificate the way the handshake and every new stream do: it chains to the
    /// Node CA, is within its dates, is for client authentication, names a node, and neither it nor
    /// its node is revoked.
    /// </summary>
    public bool Accepts(X509Certificate2? certificate, out long nodeId, out string reason)
    {
        nodeId = 0;
        if (_state is not { } state)
        {
            reason = "The gateway has not loaded its trust list yet.";
            return false;
        }

        if (certificate is null)
        {
            reason = "No client certificate.";
            return false;
        }

        using var chain = new X509Chain();
        chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
        chain.ChainPolicy.CustomTrustStore.Add(state.Ca);
        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        chain.ChainPolicy.VerificationTime = time.GetUtcNow().UtcDateTime;
        chain.ChainPolicy.VerificationTimeIgnored = false;
        chain.ChainPolicy.ApplicationPolicy.Add(_clientAuth);
        if (!chain.Build(certificate)
            || chain.ChainElements.Count != 2
            || !chain.ChainElements[^1].Certificate.RawDataMemory.Span.SequenceEqual(state.Ca.RawDataMemory.Span))
        {
            reason = "The certificate does not chain to the Node CA, or is outside its dates.";
            return false;
        }

        if (NodeCertificates.NodeIdOf(certificate) is not { } id)
        {
            reason = "The certificate names no node.";
            return false;
        }

        if (state.RevokedSerials.Contains(certificate.SerialNumber) || state.RevokedNodes.Contains(id))
        {
            reason = "The certificate or its node is revoked.";
            return false;
        }

        nodeId = id;
        reason = "";
        return true;
    }
}
