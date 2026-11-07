using System.Globalization;
using Riok.Mapperly.Abstractions;
using Runova.Website.Data.Monitoring;

namespace Runova.Website.Api.Monitoring;

[Mapper]
internal static partial class MonitoringNodeMapper
{
    /// <summary>
    /// The caller passes the status to show, which can differ from the stored one, and when the
    /// node's certificate runs out. The enrollment token's expiry only shows while a token waits.
    /// </summary>
    [MapPropertyFromSource(nameof(MonitoringNodeDto.EnrollmentTokenExpiresAt), Use = nameof(WaitingTokenExpiry))]
    public static partial MonitoringNodeDto ToDto(MonitoringNode node, string status, DateTimeOffset? certificateExpiresAt);

    private static string VersionToString(uint version) => version.ToString(CultureInfo.InvariantCulture);

    [UserMapping(Default = false)]
    private static DateTimeOffset? WaitingTokenExpiry(MonitoringNode node) =>
        node.EnrollmentTokenHash is null ? null : node.EnrollmentTokenExpiresAt;
}
