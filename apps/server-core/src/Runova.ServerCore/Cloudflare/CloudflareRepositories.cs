namespace Runova.ServerCore.Cloudflare;

/// <summary>
/// Cloudflare's own package repositories and the fingerprints of their signing keys: pkg.cloudflare.com
/// for cloudflared and pkg.cloudflareclient.com for the Cloudflare One client (warp-cli) that makes the
/// server a Cloudflare Mesh node. A downloaded key is only written when it is exactly the pinned one.
/// </summary>
internal static class CloudflareRepositories
{
    /// <summary>"CloudFlare Software Packaging 2025", RSA 4096, the key behind cloudflare-main.gpg.</summary>
    public const string CloudflaredFingerprint = "CC94B39C77AE7342A68B89628A682D308D4E5E73";

    /// <summary>"Cloudflare Package Repository", RSA 4096, the key of pkg.cloudflareclient.com.</summary>
    public const string WarpFingerprint = "C068A2B5771775193CBE1F2F6E2DD2174FA1C3BA";

    public const string CloudflaredAptKeyring = "/etc/apt/keyrings/cloudflare-main.asc";

    public const string CloudflaredAptSource = "/etc/apt/sources.list.d/cloudflared.sources";

    public const string CloudflaredRpmKey = "/etc/pki/rpm-gpg/cloudflare-main.asc";

    public const string CloudflaredRpmRepository = "/etc/yum.repos.d/cloudflared.repo";

    public const string WarpAptKeyring = "/etc/apt/keyrings/cloudflare-warp.asc";

    public const string WarpAptSource = "/etc/apt/sources.list.d/cloudflare-client.sources";

    public const string WarpRpmKey = "/etc/pki/rpm-gpg/cloudflare-warp.asc";

    public const string WarpRpmRepository = "/etc/yum.repos.d/cloudflare-warp.repo";

    public static Uri CloudflaredKeyUrl { get; } = new("https://pkg.cloudflare.com/cloudflare-ascii-pubkey.gpg");

    public static Uri WarpKeyUrl { get; } = new("https://pkg.cloudflareclient.com/pubkey.gpg");

    /// <summary>cloudflared has one suite for every release ("any").</summary>
    public static string CloudflaredAptSourceText { get; } = $"""
        # Written by Runova: Cloudflare's own cloudflared packages, signed by the key next to it.
        Types: deb
        URIs: https://pkg.cloudflare.com/cloudflared
        Suites: any
        Components: main
        Signed-By: {CloudflaredAptKeyring}

        """;

    public static string CloudflaredRpmRepositoryText { get; } = $"""
        # Written by Runova: Cloudflare's own cloudflared packages, signed by the key it names.
        [cloudflared-stable]
        name=cloudflared-stable
        baseurl=https://pkg.cloudflare.com/cloudflared/rpm
        enabled=1
        gpgcheck=1
        gpgkey=file://{CloudflaredRpmKey}

        """;

    public static string WarpAptSourceFor(string codename) => $"""
        # Written by Runova: Cloudflare's own Cloudflare One client packages, signed by the key next to it.
        Types: deb
        URIs: https://pkg.cloudflareclient.com/
        Suites: {codename}
        Components: main
        Signed-By: {WarpAptKeyring}

        """;

    public static string WarpRpmRepositoryText { get; } = $"""
        # Written by Runova: Cloudflare's own Cloudflare One client packages, signed by the key it names.
        [cloudflare-warp-stable]
        name=cloudflare-warp-stable
        baseurl=https://pkg.cloudflareclient.com/rpm/$releasever
        enabled=1
        gpgcheck=1
        gpgkey=file://{WarpRpmKey}

        """;
}
