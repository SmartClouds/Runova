namespace Runova.Monitoring.Gateway;

/// <summary>The gateway's settings, from <c>Gateway__*</c>.</summary>
public sealed class GatewayOptions
{
    /// <summary>Who this gateway is in node rows and logs. Defaults to the host name and a random suffix.</summary>
    public string? Id { get; set; }

    /// <summary>The port nodes connect to: TLS 1.3, HTTP/2 only, client certificates required.</summary>
    public int NodePort { get; set; } = 8043;

    /// <summary>A plain HTTP port for <c>/healthz</c>, reachable only on the internal network.</summary>
    public int HealthPort { get; set; } = 8080;

    /// <summary>The server certificate (PEM, with its chain) nodes see on <c>nodes.runovahq.com</c>.</summary>
    public string? ServerCertificatePath { get; set; }

    /// <summary>Its private key (PEM).</summary>
    public string? ServerKeyPath { get; set; }

    /// <summary>The most results one batch may carry.</summary>
    public int MaxBatchResults { get; set; } = 500;

    /// <summary>How long a node has to say Hello after it connects.</summary>
    public TimeSpan HelloTimeout { get; set; } = TimeSpan.FromSeconds(10);

    /// <summary>How often the trust list is fetched again, besides the revocations pushed at once.</summary>
    public TimeSpan TrustRefresh { get; set; } = TimeSpan.FromMinutes(5);
}
