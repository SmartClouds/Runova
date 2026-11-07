namespace Runova.Website.Api.Monitoring;

/// <summary>The log lines of the monitoring node code (E54).</summary>
internal static partial class MonitoringLog
{
    [LoggerMessage(Level = LogLevel.Debug, Message = "No RabbitMQ is configured; a {Kind} for node {NodeId} goes nowhere.")]
    public static partial void NoBus(this ILogger logger, string kind, long nodeId);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Node {NodeId} connected with certificate {Serial}, which is not good; closing it.")]
    public static partial void BadCertificate(this ILogger logger, long nodeId, string serial);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Node {NodeId} connected from {Address}, which its allow list does not hold.")]
    public static partial void AddressRefused(this ILogger logger, long nodeId, string? address);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Results from node {NodeId}, which is not enrolled or is revoked, were dropped.")]
    public static partial void UnknownNodeResults(this ILogger logger, long nodeId);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Node {NodeId} ({Name}) sent no heartbeat since {LastSeen}; it is offline.")]
    public static partial void NodeSilent(this ILogger logger, long nodeId, string name, DateTimeOffset? lastSeen);
}
