using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Microsoft.EntityFrameworkCore;
using Runova.Monitoring.Contracts;
using Runova.Monitoring.Contracts.Grpc;
using Runova.Website.Data;
using Runova.Website.Data.Monitoring;

namespace Runova.Website.Api.Monitoring;

/// <summary>
/// What the API does with what the gateways tell it (E54). The gateway already checked the
/// certificate against the Node CA and the deny list; this checks again against the database,
/// which is the last word, and closes the stream of a node that should not be there.
/// </summary>
public sealed class NodeEvents(
    AppDbContext db,
    INodeBus bus,
    IAssignmentSource assignments,
    IResultIngestor results,
    INodeRebalancer rebalancer,
    NodeCertificateAuthority authority,
    TimeProvider time,
    ILogger<NodeEvents> logger)
{
    public async Task<NodeAccepted> ConnectedAsync(NodeConnected message, CancellationToken ct = default)
    {
        var node = await db.MonitoringNodes.SingleOrDefaultAsync(n => n.Id == message.NodeId, ct);
        var certificate = await db.NodeCertificates.AsNoTracking()
            .SingleOrDefaultAsync(c => c.Serial == message.CertificateSerial && c.NodeId == message.NodeId, ct);
        if (node is null || node.Status == NodeStatuses.Revoked || certificate is null || certificate.RevokedAt is not null)
        {
            logger.BadCertificate(message.NodeId, message.CertificateSerial);
            await bus.RevokedAsync(message.NodeId, [message.CertificateSerial], ct);
            return new NodeAccepted(false, "This certificate is not good.");
        }

        if (!AddressAllowed(node.AllowedAddresses, message.RemoteAddress))
        {
            logger.AddressRefused(node.Id, message.RemoteAddress);
            await bus.CloseAsync(node.Id, "This node may not connect from this address.", ct);
            return new NodeAccepted(false, "This node may not connect from this address.");
        }

        var now = time.GetUtcNow();
        node.Status = NodeStatuses.Online;
        node.GatewayId = message.GatewayId;
        node.RemoteAddress = message.RemoteAddress;
        node.SoftwareVersion = Trim(message.Version, 40);
        node.ConnectedAt = now;
        node.LastSeenAt = now;
        await db.SaveChangesAsync(ct);

        if (node.Draining)
        {
            await bus.SendAsync(node.Id, new ServerMessage { Drain = new Drain { Reason = "This node is being drained." } }, ct);
            return new NodeAccepted(true, null);
        }

        await SendSnapshotAsync(node, ct);
        // A node that came (back) may take monitors from the others: what changes comes as deltas after the snapshot.
        await rebalancer.NodesChangedAsync(ct);
        return new NodeAccepted(true, null);
    }

    public async Task HeartbeatAsync(NodeHeartbeat message, CancellationToken ct = default)
    {
        var node = await db.MonitoringNodes.SingleOrDefaultAsync(n => n.Id == message.NodeId, ct);
        if (node is null || node.Status is NodeStatuses.Revoked or NodeStatuses.Pending)
        {
            return;
        }

        node.LastSeenAt = time.GetUtcNow();
        node.Monitors = Math.Max(0, message.Monitors);
        node.ChecksLastMinute = Math.Max(0, message.ChecksLastMinute);
        node.QueuedResults = Math.Max(0, message.QueuedResults);
        node.LagMs = Math.Max(0, message.LagMs);
        node.Status = NodeStatuses.Online;
        await db.SaveChangesAsync(ct);
    }

    public async Task DisconnectedAsync(NodeDisconnected message, CancellationToken ct = default)
    {
        var node = await db.MonitoringNodes.SingleOrDefaultAsync(n => n.Id == message.NodeId, ct);
        // Only the gateway that holds the stream may close it: a reconnect elsewhere comes first.
        if (node is null || node.Status != NodeStatuses.Online || node.GatewayId != message.GatewayId)
        {
            return;
        }

        node.Status = NodeStatuses.Offline;
        node.GatewayId = null;
        await db.SaveChangesAsync(ct);
    }

    /// <summary>Hands the batch on. The answer is what lets the gateway ack it to the node.</summary>
    public async Task<BatchStored> ResultsAsync(CheckResultBatch batch, CancellationToken ct = default)
    {
        var known = await db.MonitoringNodes.AsNoTracking()
            .AnyAsync(n => n.Id == batch.NodeId && n.Status != NodeStatuses.Revoked && n.Status != NodeStatuses.Pending, ct);
        if (!known)
        {
            logger.UnknownNodeResults(batch.NodeId);
            // Answered all the same: sending it again would not make it any more welcome.
            return new BatchStored(batch.BatchId);
        }

        await results.IngestAsync(batch, ct);
        return new BatchStored(batch.BatchId);
    }

    /// <summary>A fresh certificate for the key the node already holds, asked with a good certificate.</summary>
    public async Task<CertificateRenewed> RenewAsync(RenewNodeCertificate message, CancellationToken ct = default)
    {
        var node = await db.MonitoringNodes.AsNoTracking().SingleOrDefaultAsync(n => n.Id == message.NodeId, ct);
        var presented = await db.NodeCertificates.AsNoTracking()
            .SingleOrDefaultAsync(c => c.Serial == message.PresentedSerial && c.NodeId == message.NodeId, ct);
        if (node is null || node.Status == NodeStatuses.Revoked || presented is null || presented.RevokedAt is not null
            || presented.NotAfter <= time.GetUtcNow())
        {
            return new CertificateRenewed([], [], "This node may not renew its certificate.");
        }

        try
        {
            var issued = await authority.IssueAsync(node.Id, message.Csr, presented.PublicKeyHash, ct);
            await db.SaveChangesAsync(ct);
            return new CertificateRenewed(issued.Certificate, [issued.CaCertificate], null);
        }
        catch (CertificateRequestException e)
        {
            return new CertificateRenewed([], [], e.Message);
        }
    }

    /// <summary>What a gateway trusts: the CA, and the revoked serials that have not run out yet.</summary>
    public async Task<NodeTrust> TrustAsync(CancellationToken ct = default)
    {
        using var ca = await authority.GetCertificateAsync(ct);
        var now = time.GetUtcNow();
        var serials = await db.NodeCertificates.AsNoTracking()
            .Where(c => c.RevokedAt != null && c.NotAfter > now)
            .Select(c => c.Serial).ToListAsync(ct);
        var nodes = await db.MonitoringNodes.AsNoTracking()
            .Where(n => n.Status == NodeStatuses.Revoked).Select(n => n.Id).ToListAsync(ct);
        return new NodeTrust(ca.RawData, serials, nodes);
    }

    /// <summary>Sends the node everything it should check and bumps its assignment version.</summary>
    public async Task SendSnapshotAsync(MonitoringNode node, CancellationToken ct = default)
    {
        var monitors = await assignments.ForNodeAsync(node.Id, ct);
        node.AssignmentVersion++;
        await db.SaveChangesAsync(ct);
        var snapshot = new AssignmentSnapshot { AssignmentVersion = node.AssignmentVersion };
        snapshot.Monitors.AddRange(monitors);
        await bus.SendAsync(node.Id, new ServerMessage { Snapshot = snapshot }, ct);
    }

    /// <summary>True when the list is empty or holds the address.</summary>
    public static bool AddressAllowed(IReadOnlyList<string> allowed, string? remote)
    {
        if (allowed.Count == 0)
        {
            return true;
        }

        if (!IPAddress.TryParse(remote, out var address))
        {
            return false;
        }

        if (address.IsIPv4MappedToIPv6)
        {
            address = address.MapToIPv4();
        }

        return allowed.Any(entry => IPNetwork.TryParse(entry, out var network) && network.Contains(address));
    }

    private static string? Trim(string? value, int max) =>
        value is null ? null : value.Length <= max ? value : value[..max];
}

/// <summary>The Wolverine handlers for the internal queue. Each one hands off to <see cref="NodeEvents"/>.</summary>
public static class NodeMessageHandler
{
    public static Task<NodeAccepted> Handle(NodeConnected message, NodeEvents events, CancellationToken ct) => events.ConnectedAsync(message, ct);

    public static Task Handle(NodeHeartbeat message, NodeEvents events, CancellationToken ct) => events.HeartbeatAsync(message, ct);

    public static Task Handle(NodeDisconnected message, NodeEvents events, CancellationToken ct) => events.DisconnectedAsync(message, ct);

    public static Task<BatchStored> Handle(CheckResultBatch message, NodeEvents events, CancellationToken ct) => events.ResultsAsync(message, ct);

    public static Task<CertificateRenewed> Handle(RenewNodeCertificate message, NodeEvents events, CancellationToken ct) => events.RenewAsync(message, ct);

    public static Task<NodeTrust> Handle(GetNodeTrust message, NodeEvents events, CancellationToken ct) => events.TrustAsync(ct);
}

/// <summary>Helpers the enrollment and the tests share.</summary>
public static class NodeTokens
{
    /// <summary>The prefix makes a leaked token easy to spot and to redact.</summary>
    public const string Prefix = "rnn_";

    public static readonly TimeSpan Lifetime = TimeSpan.FromHours(24);

    public static string New() => Prefix + Base64Url(RandomNumberGenerator.GetBytes(32));

    public static byte[] Hash(string token) => SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(token));

    private static string Base64Url(byte[] bytes) => System.Buffers.Text.Base64Url.EncodeToString(bytes);

    /// <summary>A certificate's serial the way the database keeps it.</summary>
    public static string SerialOf(X509Certificate2 certificate) => certificate.SerialNumber;
}
