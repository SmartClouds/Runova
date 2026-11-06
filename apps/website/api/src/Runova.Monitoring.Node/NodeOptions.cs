namespace Runova.Monitoring.Node;

/// <summary>
/// A node's settings. In the compose file they are plain environment variables:
/// <c>RUNOVA_API_URL</c>, <c>NODE_ENROLLMENT_TOKEN</c> and, rarely, <c>NODE_*</c>.
/// </summary>
public sealed class NodeOptions
{
    /// <summary>Where the node enrolls, such as <c>https://runovahq.com</c>. HTTPS only.</summary>
    public string? ApiUrl { get; set; }

    /// <summary>The one-time token from the node's admin page. Only needed until the node has enrolled.</summary>
    public string? EnrollmentToken { get; set; }

    /// <summary>Where the key, the certificate and the outbox live. A volume, kept across restarts.</summary>
    public string DataPath { get; set; } = "/data";

    /// <summary>How many checks run at the same time.</summary>
    public int Concurrency { get; set; } = 64;

    /// <summary>An extra CA (PEM) the gateway's server certificate may chain to, for a self-signed gateway.</summary>
    public string? GatewayCaPath { get; set; }

    /// <summary>The same, given inline; for tests.</summary>
    public string? GatewayCaPem { get; set; }

    /// <summary>
    /// Lets checks reach private addresses. For tests and a local stack only; refused outside
    /// Development so a production node can never be pointed inside a network.
    /// </summary>
    public bool AllowPrivateAddresses { get; set; }

    /// <summary>Plain HTTP for enrollment, for tests only, refused outside Development.</summary>
    public bool AllowInsecureApi { get; set; }

    /// <summary>The most results kept while the gateway is away; the oldest go first past it.</summary>
    public int MaxOutbox { get; set; } = 200_000;

    /// <summary>A new monitor's first check comes at a random point up to this far ahead, so checks spread out.</summary>
    public TimeSpan StartSpread { get; set; } = TimeSpan.FromSeconds(60);

    public TimeSpan HeartbeatEvery { get; set; } = TimeSpan.FromSeconds(10);

    public TimeSpan BatchEvery { get; set; } = TimeSpan.FromSeconds(2);

    public int BatchSize { get; set; } = 200;

    /// <summary>A batch with no ack after this is sent again.</summary>
    public TimeSpan AckTimeout { get; set; } = TimeSpan.FromSeconds(30);

    /// <summary>Renew when the certificate has less than this left.</summary>
    public TimeSpan RenewBefore { get; set; } = TimeSpan.FromDays(6);
}
