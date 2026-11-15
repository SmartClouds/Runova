using Riok.Mapperly.Abstractions;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Cloudflare;

[Mapper]
internal static partial class CloudflareTunnelMapper
{
    /// <summary>
    /// What the app sees of the tunnel: the stored row plus what the core found out just now (the
    /// state, the firewall, cloudflared). The sealed token is never mapped.
    /// </summary>
    [MapProperty(nameof(CloudflareTunnelSetting.TunnelPort), nameof(CloudflareTunnelStatus.TunnelPort), Use = nameof(PortOrNull))]
    [MapProperty(nameof(CloudflareTunnelSetting.LastConnectedAt), nameof(CloudflareTunnelStatus.LastConnectedAtUnixMs))]
    [MapProperty(nameof(CloudflareTunnelSetting.DownSince), nameof(CloudflareTunnelStatus.DownSinceUnixMs))]
    public static partial CloudflareTunnelStatus ToStatus(
        CloudflareTunnelSetting row,
        CloudflareTunnelState state,
        int[] webPorts,
        int[] sshPorts,
        string[] openRules,
        string[] warnings,
        int connections,
        bool cloudflaredInstalled,
        string? cloudflaredVersion,
        FirewallChangeState? changeState);

    private static int? PortOrNull(int port) => port > 0 ? port : null;
}
