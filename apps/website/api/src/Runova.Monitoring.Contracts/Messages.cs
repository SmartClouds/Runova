using System.Globalization;

namespace Runova.Monitoring.Contracts;

// The records the gateway and the API exchange through Wolverine on the internal RabbitMQ. The
// gateway stamps NodeId from the node's verified certificate; nothing a node sends can set it.

/// <summary>A node opened its stream on a gateway.</summary>
public sealed record NodeConnected(
    long NodeId,
    string GatewayId,
    string Version,
    long AssignmentVersion,
    int Concurrency,
    string? RemoteAddress,
    string CertificateSerial,
    DateTimeOffset At);

/// <summary>The API's answer to <see cref="NodeConnected"/>; a refused node's stream is closed at once.</summary>
public sealed record NodeAccepted(bool Accepted, string? Reason);

/// <summary>A node's stream closed, or the gateway closed it.</summary>
public sealed record NodeDisconnected(long NodeId, string GatewayId, DateTimeOffset At);

public sealed record NodeHeartbeat(
    long NodeId,
    int Monitors,
    int ChecksLastMinute,
    int QueuedResults,
    int LagMs,
    DateTimeOffset At);

/// <summary>
/// A node's results. The gateway asks with this and acks the batch to the node only once the API
/// answers with <see cref="BatchStored"/>, so a broker or an API that is down means no ack.
/// </summary>
public sealed record CheckResultBatch(long NodeId, string BatchId, IReadOnlyList<CheckResultRecord> Results);

public sealed record BatchStored(string BatchId);

public sealed record CheckResultRecord(
    Guid Id,
    long MonitorId,
    long MonitorVersion,
    DateTimeOffset CheckedAt,
    string State,
    int? HttpStatus,
    int? LatencyMs,
    string? Problem,
    IReadOnlyList<ServiceProblemRecord> Services,
    string? ConfirmId);

public sealed record ServiceProblemRecord(string Key, string Status, string Message);

/// <summary>A node asks for a fresh certificate; the API answers with <see cref="CertificateRenewed"/>.</summary>
public sealed record RenewNodeCertificate(long NodeId, string PresentedSerial, byte[] Csr);

/// <summary>When <see cref="Refused"/> is set the certificate is empty.</summary>
public sealed record CertificateRenewed(byte[] Certificate, IReadOnlyList<byte[]> CaCertificates, string? Refused);

/// <summary>
/// Something for one node: a serialized <c>ServerMessage</c>. Published to every gateway; the one
/// holding the node's stream writes it and the others drop it.
/// </summary>
public sealed record NodeOutbound(long NodeId, byte[] ServerMessage);

/// <summary>The node is revoked: close its stream now and refuse these certificate serials.</summary>
public sealed record NodeRevoked(long NodeId, IReadOnlyList<string> Serials);

/// <summary>Close the node's stream without refusing its certificate (it connected from an address it may not use).</summary>
public sealed record CloseNodeConnection(long NodeId, string Reason);

/// <summary>A gateway asks, when it starts and every few minutes, what to trust and what to refuse.</summary>
public sealed record GetNodeTrust(string GatewayId);

/// <summary>The Node CA certificate (DER) and what is revoked; certificates past their end need no listing.</summary>
public sealed record NodeTrust(byte[] CaCertificate, IReadOnlyList<string> RevokedSerials, IReadOnlyList<long> RevokedNodeIds);

/// <summary>The names both sides use on RabbitMQ.</summary>
public static class MonitoringQueues
{
    /// <summary>Gateways to the API: one durable queue.</summary>
    public const string ToApi = "runova-monitoring-api";

    /// <summary>The API to every gateway: a fanout exchange, with one queue per gateway.</summary>
    public const string ToGateways = "runova-monitoring-gateways";
}

/// <summary>The URI a node certificate carries in its subject alternative name.</summary>
public static class NodeIdentity
{
    public const string UriPrefix = "urn:runova:node:";

    public static string Uri(long nodeId) => string.Create(CultureInfo.InvariantCulture, $"{UriPrefix}{nodeId}");

    public static bool TryParse(string? uri, out long nodeId)
    {
        nodeId = 0;
        return uri is not null
            && uri.StartsWith(UriPrefix, StringComparison.Ordinal)
            && long.TryParse(uri.AsSpan(UriPrefix.Length), NumberStyles.None, CultureInfo.InvariantCulture, out nodeId)
            && nodeId > 0;
    }
}
