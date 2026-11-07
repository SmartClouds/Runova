using Riok.Mapperly.Abstractions;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Alerts;

[Mapper]
internal static partial class AlertMapper
{
    /// <summary>The acknowledger's name as it was then; their id stays on the row.</summary>
    [MapProperty(nameof(Alert.FirstSeenAt), nameof(AlertInfo.FirstSeenAtUnixMs))]
    [MapProperty(nameof(Alert.LastSeenAt), nameof(AlertInfo.LastSeenAtUnixMs))]
    [MapProperty(nameof(Alert.AcknowledgedAt), nameof(AlertInfo.AcknowledgedAtUnixMs))]
    [MapProperty(nameof(Alert.AcknowledgedByName), nameof(AlertInfo.AcknowledgedBy))]
    [MapProperty(nameof(Alert.ResolvedAt), nameof(AlertInfo.ResolvedAtUnixMs))]
    public static partial AlertInfo ToInfo(Alert alert);
}
