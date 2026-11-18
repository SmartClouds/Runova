using Tapper;

namespace Runova.ServerCore.Contracts;

[TranspilationSource]
public enum AlertKind
{
    DiskPressure,
    JobFailed,
    RebootRequired,

    /// <summary>A firewall change was not confirmed in time, so the rules from before it are back.</summary>
    FirewallRolledBack,

    /// <summary>Putting a firewall change's saved rules back failed.</summary>
    FirewallRollbackFailed,

    CertificateRenewalFailed,

    /// <summary>The origin lock could not fetch Cloudflare's ranges or bring the firewall up to date with them (E14).</summary>
    OriginLockRefreshFailed,

    /// <summary>A backup plan's run failed, or not every destination took it (E30). The resource is the plan.</summary>
    BackupFailed,

    /// <summary>A container keeps exiting and being started again (E30). The resource is the container's name.</summary>
    ContainerCrashLoop,

    /// <summary>The Cloudflare Tunnel lost its connection to Cloudflare (E95): the sites and the core domain do not answer.</summary>
    CloudflareTunnelDown,

    /// <summary>The tunnel stayed down, so the core opened SSH to everyone as the person asked (E95).</summary>
    TunnelBreakGlassOpened,

    /// <summary>Addresses probing a site for files and admin pages (E110). The resource is <c>site:&lt;id&gt;</c>.</summary>
    WebScan,

    /// <summary>Addresses trying passwords on a site's login pages (E110). The resource is <c>site:&lt;id&gt;</c>.</summary>
    WebBruteForce,

    /// <summary>A site flooded with requests (E110). The resource is <c>site:&lt;id&gt;</c>.</summary>
    WebFlood,

    /// <summary>Injection probes (SQL, XSS, traversal, commands) against a site (E110). The resource is <c>site:&lt;id&gt;</c>.</summary>
    WebInjection,
}

[TranspilationSource]
public enum AlertSeverity
{
    Info,
    Warning,
    Critical,
}

/// <summary>
/// Something on the server that needs a person. An alert is one condition on one resource; it
/// stays one alert while the condition lasts (its last-seen time and count move on) and resolves
/// by itself when the condition clears. Every change gives it a new revision, higher than any
/// before it on this server, so a client that remembers the highest one it saw misses nothing.
/// </summary>
[TranspilationSource]
public sealed record AlertInfo(
    long Id,
    long Revision,
    AlertKind Kind,
    AlertSeverity Severity,
    string Resource,
    string Message,
    long FirstSeenAtUnixMs,
    long LastSeenAtUnixMs,
    int Occurrences,
    long? AcknowledgedAtUnixMs = null,
    string? AcknowledgedBy = null,
    long? ResolvedAtUnixMs = null);

/// <summary>Open alerts by default, newest change first.</summary>
[TranspilationSource]
public sealed record AlertQuery(bool IncludeResolved = false, int? Limit = null);

/// <summary>
/// Alerts as they change. Without a revision the stream starts with every open alert; with one it
/// starts with everything that changed after it. If the stream ends on its own (a client too slow
/// to keep up), subscribe again with the highest revision received.
/// </summary>
[TranspilationSource]
public sealed record AlertStreamRequest(long? AfterRevision = null);
