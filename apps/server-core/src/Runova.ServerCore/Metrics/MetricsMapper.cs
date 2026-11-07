using Riok.Mapperly.Abstractions;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Metrics;

[Mapper]
internal static partial class MetricsMapper
{
    /// <summary>An averaged sample, stored at its resolution (seconds per sample).</summary>
    [MapProperty(nameof(MetricsSample.AtUnixMs), nameof(MetricSample.At))]
    public static partial MetricSample ToRow(MetricsSample sample, int resolution);

    [MapProperty(nameof(MetricSample.At), nameof(MetricsSample.AtUnixMs))]
    public static partial MetricsSample ToSample(MetricSample row);
}
