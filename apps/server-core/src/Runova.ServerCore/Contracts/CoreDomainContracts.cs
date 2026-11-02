using Tapper;

namespace Runova.ServerCore.Contracts;

// Core domain (E44): a domain nginx serves over HTTPS and passes to the core, so the app reaches
// the core without SSH and without a port of its own. Off by default, and only offered once nginx
// is installed and running. nginx asks each caller for its device certificate and the core checks
// it against the enrolled devices on every request; the usual sign-in, sessions and roles apply
// on top. In Direct mode the domain points straight at the server (DNS only): a proxy such as
// Cloudflare's ends TLS itself and never passes the device certificate on. In Cloudflare mode the
// domain is proxied, and each request carries a header signed with the device key instead.

/// <summary>
/// How the app reaches the core domain. Direct: straight to the server, the device proven by its
/// TLS client certificate. Cloudflare: through Cloudflare's proxy (works with the origin lock on),
/// the device proven by a signed header on every request, since Cloudflare ends TLS at its edge.
/// </summary>
[TranspilationSource]
public enum CoreDomainMode
{
    Direct,
    Cloudflare,
}

/// <summary>
/// The core domain as the core runs it. Listening says whether the core's loopback port for nginx
/// is open; SiteApplied whether nginx runs the domain's site as saved. Certificate is null until
/// one is issued for the domain (through the usual certificate calls, with SiteId). Ready when all
/// of it holds and the app can connect through the domain. OriginLocked means the Cloudflare origin
/// lock is on, which keeps everyone but Cloudflare off ports 80 and 443; it only stops a domain in
/// Direct mode.
/// </summary>
[TranspilationSource]
public sealed record CoreDomainStatus(
    bool Enabled,
    string? Domain,
    string[] Sources,
    bool NginxInstalled,
    bool NginxRunning,
    bool OriginLocked,
    bool Listening,
    bool SiteApplied,
    bool Ready,
    string SiteId,
    CertificateInfo? Certificate = null,
    long? ChangedAtUnixMs = null,
    string? ChangedBy = null,
    string? Error = null,
    CoreDomainMode Mode = CoreDomainMode.Direct);

/// <summary>Turns the core domain on, or changes it (Owner, with a step-up). Sources are addresses or CIDR networks nginx lets in.</summary>
[TranspilationSource]
public sealed record CoreDomainRequest(string Domain, string[]? Sources = null, CoreDomainMode Mode = CoreDomainMode.Direct);
