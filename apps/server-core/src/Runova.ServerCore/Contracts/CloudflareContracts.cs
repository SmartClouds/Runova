using Tapper;

namespace Runova.ServerCore.Contracts;

// Cloudflare on the server side (E14). The account token stays in the desktop app; the core only
// ever holds a zone-scoped DNS token a person sent it for DNS-01, which it never sends back. It
// fetches Cloudflare's published address ranges itself (no token needed) to lock the origin.

/// <summary>Cloudflare's published edge ranges, as the core last fetched them.</summary>
[TranspilationSource]
public sealed record CloudflareRanges(string[] Ipv4, string[] Ipv6, long FetchedAtUnixMs);

[TranspilationSource]
public enum OriginLockState
{
    /// <summary>Ports 80 and 443 are not limited to Cloudflare.</summary>
    Off,

    /// <summary>The firewall change is applied and waits for its confirmation.</summary>
    Pending,

    /// <summary>The firewall matches the ranges for IPv4 and IPv6.</summary>
    On,

    /// <summary>The lock is meant to be on, but the firewall does not match the ranges (see the lists).</summary>
    Drifted,
}

/// <summary>
/// The origin lock: ports 80 and 443 open to Cloudflare's ranges only, nginx taking the visitor's
/// address from CF-Connecting-IP when a request comes from one of them, and optionally only
/// accepting TLS from Cloudflare's client certificate (Authenticated Origin Pulls).
/// MissingRules, OpenRules and StaleRules say how the firewall differs from what the lock needs:
/// a range not allowed yet, a rule that still lets everyone in, a Cloudflare rule for a range
/// Cloudflare no longer lists.
/// </summary>
[TranspilationSource]
public sealed record OriginLockStatus(
    bool Enabled,
    bool AuthenticatedOriginPulls,
    OriginLockState State,
    int[] Ports,
    string[] MissingRules,
    string[] OpenRules,
    string[] StaleRules,
    string[] Warnings,
    CloudflareRanges? Ranges = null,
    long? LastRefreshAtUnixMs = null,
    string? LastRefreshError = null,
    Guid? ChangeSetId = null,
    FirewallChangeState? ChangeState = null);

/// <summary>
/// Turn the lock on or off. SshConnection is `$SSH_CONNECTION` as for any firewall change, so the
/// lockout guard knows what to keep open; the change then waits for its confirmation like any other.
/// </summary>
[TranspilationSource]
public sealed record OriginLockRequest(bool Enabled, bool AuthenticatedOriginPulls = false, string? SshConnection = null);

/// <summary>
/// What turning the lock on or off would do. Firewall is null when the firewall already matches
/// (only nginx changes then); Changes are the firewall changes it would apply.
/// </summary>
[TranspilationSource]
public sealed record OriginLockPreview(FirewallChange[] Changes, string[] Notes, CloudflareRanges Ranges, FirewallChangePreview? Firewall = null);

/// <summary>The lock as it now stands, the firewall change waiting for its confirmation (if any), and how nginx took it.</summary>
[TranspilationSource]
public sealed record OriginLockResult(OriginLockStatus Status, NginxApplyResult Nginx, FirewallChangeSetInfo? ChangeSet = null);

/// <summary>
/// A key made on this server for a Cloudflare Origin CA certificate, and its signing request. The
/// app sends the request to Cloudflare and brings the certificate back with InstallOriginCertificate.
/// </summary>
[TranspilationSource]
public sealed record OriginCertificateRequestInfo(string SiteId, string CsrPem, string[] Hostnames, string RequestType, long CreatedAtUnixMs);

/// <summary>The certificate Cloudflare signed for the request this server made (PEM, the leaf alone is fine).</summary>
[TranspilationSource]
public sealed record OriginCertificateInstall(string SiteId, string CertificatePem);

/// <summary>
/// A zone-scoped Cloudflare token with DNS edit rights, for DNS-01. Token is write-only: the core
/// seals it and never returns it. TokenId is Cloudflare's id for it, when the app made the token,
/// so the app can delete it at Cloudflare again later.
/// </summary>
[TranspilationSource]
public sealed record DnsCredentialRequest(string Zone, string ZoneId, string Token, string? TokenId = null);

/// <summary>A stored DNS token, without the token.</summary>
[TranspilationSource]
public sealed record DnsCredentialInfo(
    string Zone,
    string ZoneId,
    string Provider,
    long CreatedAtUnixMs,
    long UpdatedAtUnixMs,
    string? TokenId = null,
    string? CreatedBy = null,
    long? LastUsedAtUnixMs = null,
    string? LastError = null);

/// <summary>Saved when Problems is empty; otherwise nothing was saved.</summary>
[TranspilationSource]
public sealed record DnsCredentialSaveResult(string[] Problems, DnsCredentialInfo? Credential = null);

// Cloudflare Tunnel (E95): cloudflared on the server dials out to Cloudflare, so ports 80 and 443
// (and Direct TLS) close to everyone and no Cloudflare ranges need to be let in. The sites and the
// core domain answer through the tunnel only. It and the origin lock are never on together.

/// <summary>
/// Who may still open SSH while the tunnel is on. Open: everyone the firewall lets in today.
/// Closed: no one from outside; the app reaches the core through the core domain on the tunnel.
/// Cloudflare: SSH goes through the tunnel behind a Cloudflare Access service token. Mesh: only
/// addresses of the account's Cloudflare Mesh (100.96.0.0/12) reach the SSH port.
/// </summary>
[TranspilationSource]
public enum TunnelSshMode
{
    Open,
    Closed,
    Cloudflare,
    Mesh,
}

[TranspilationSource]
public enum CloudflareTunnelState
{
    /// <summary>No tunnel on this server.</summary>
    Off,

    /// <summary>The setup job installs cloudflared and starts the tunnel.</summary>
    Installing,

    /// <summary>cloudflared runs but has no connection to Cloudflare yet.</summary>
    Connecting,

    /// <summary>The tunnel is connected, and the web ports are still open to everyone (close them next).</summary>
    PortsOpen,

    /// <summary>A firewall change for the tunnel is applied and waits for its confirmation.</summary>
    Pending,

    /// <summary>Connected, the web ports closed and SSH as chosen.</summary>
    Connected,

    /// <summary>Connected, but the firewall no longer matches what the tunnel needs (see OpenRules).</summary>
    Drifted,

    /// <summary>The tunnel was connected and is not now: the sites and the core domain do not answer.</summary>
    Down,

    /// <summary>The setup job failed; LastError says why.</summary>
    Failed,
}

/// <summary>
/// The Cloudflare Tunnel as the core runs it. WebPorts are the ports it keeps closed (80, 443 and
/// Direct TLS's when that is on); OpenRules the firewall rules that still let someone in where the
/// tunnel wants no one, SSH included unless SshMode is Open. TunnelPort is nginx's loopback listener
/// cloudflared sends every request to. The token is never part of this.
/// </summary>
[TranspilationSource]
public sealed record CloudflareTunnelStatus(
    bool Enabled,
    CloudflareTunnelState State,
    TunnelSshMode SshMode,
    int[] WebPorts,
    int[] SshPorts,
    string[] OpenRules,
    string[] Warnings,
    int Connections,
    bool CloudflaredInstalled,
    bool BreakGlassEnabled,
    int BreakGlassDelayMinutes,
    bool BreakGlassOpen,
    string? TunnelId = null,
    string? TunnelName = null,
    string? AccountTag = null,
    string? SshHostname = null,
    string? CloudflaredVersion = null,
    int? TunnelPort = null,
    string? MeshAddress = null,
    Guid? SetupJobId = null,
    Guid? ChangeSetId = null,
    FirewallChangeState? ChangeState = null,
    string? LastError = null,
    long? LastConnectedAtUnixMs = null,
    long? DownSinceUnixMs = null);

/// <summary>
/// Starts the tunnel the app made at Cloudflare. Token is write-only: the core seals it and only
/// ever writes it to cloudflared's root-only environment file. SshHostname is the name the app
/// routed to this server's SSH (Cloudflare only SSH), if any. Nothing in the firewall changes yet.
/// </summary>
[TranspilationSource]
public sealed record CloudflareTunnelSetup(string TunnelId, string TunnelName, string Token, string? SshHostname = null);

/// <summary>A firewall change of the tunnel's; SshConnection and OverrideConfirmation as for any firewall change.</summary>
[TranspilationSource]
public sealed record CloudflareTunnelFirewallRequest(string? SshConnection = null, string? OverrideConfirmation = null);

/// <summary>Who may open SSH while the tunnel is on (a firewall change set).</summary>
[TranspilationSource]
public sealed record TunnelSshRequest(TunnelSshMode Mode, string? SshConnection = null, string? OverrideConfirmation = null);

/// <summary>
/// Turns the tunnel off: SSH opens to everyone again and, unless the origin lock takes over
/// (ReopenWeb false), the web ports too. cloudflared stops once that change is confirmed.
/// </summary>
[TranspilationSource]
public sealed record CloudflareTunnelOffRequest(bool ReopenWeb = true, string? SshConnection = null, string? OverrideConfirmation = null);

/// <summary>
/// Whether the core opens SSH to everyone by itself when the tunnel has been down for DelayMinutes
/// (5 to 1440), and closes it again once the tunnel is back. Off by default.
/// </summary>
[TranspilationSource]
public sealed record TunnelBreakGlassRequest(bool Enabled, int DelayMinutes = 30);

/// <summary>
/// Makes this server a Cloudflare Mesh node, for Mesh-only SSH. NodeId is Cloudflare's id for the
/// node the app made; Token is write-only and only ever handed to warp-cli.
/// </summary>
[TranspilationSource]
public sealed record CloudflareMeshJoin(string NodeId, string Token);

/// <summary>What a tunnel firewall change would do; Firewall is null when the firewall already matches.</summary>
[TranspilationSource]
public sealed record CloudflareTunnelPreview(FirewallChange[] Changes, string[] Notes, FirewallChangePreview? Firewall = null);

/// <summary>The tunnel as it now stands, the firewall change waiting for its confirmation (if any), and how nginx took it.</summary>
[TranspilationSource]
public sealed record CloudflareTunnelResult(CloudflareTunnelStatus Status, FirewallChangeSetInfo? ChangeSet = null, NginxApplyResult? Nginx = null);
