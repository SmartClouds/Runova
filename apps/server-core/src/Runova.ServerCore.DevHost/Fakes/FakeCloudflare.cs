using System.Collections.Concurrent;
using Runova.ServerCore.Cloudflare;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.DevHost.Fakes;

/// <summary>
/// Cloudflare as the DevHost sees it: a short list of real Cloudflare ranges (so the pretend
/// firewall applies in seconds, not a minute), and a DNS API that keeps records in memory and
/// accepts any token that looks like one, except tokens starting "denied", which it refuses as
/// Cloudflare refuses a token without DNS rights. Nothing leaves the machine.
/// </summary>
internal sealed class FakeCloudflare : ICloudflareRangeSource, ICloudflareDnsApi
{
    private readonly ConcurrentDictionary<string, CloudflareTxtRecord> _records = new(StringComparer.Ordinal);

    public Task<CloudflareRanges> FetchAsync(CancellationToken cancellationToken) =>
        Task.FromResult(CloudflareRangeList.Parse(["173.245.48.0/20", "103.21.244.0/22", "104.16.0.0/13"], ["2400:cb00::/32", "2606:4700::/32"], 0));

    public Task<string?> CheckAsync(string zoneId, string token, CancellationToken cancellationToken) =>
        Task.FromResult(token.StartsWith("denied", StringComparison.Ordinal)
            ? "This token cannot read the zone's DNS records (Authentication error (code 10000)). It needs Zone > DNS > Edit on this zone."
            : null);

    public Task<string> CreateTxtAsync(string zoneId, string token, string name, string content, CancellationToken cancellationToken)
    {
        var id = Guid.NewGuid().ToString("N");
        _records[id] = new CloudflareTxtRecord(id, name, content);
        return Task.FromResult(id);
    }

    public Task<IReadOnlyList<CloudflareTxtRecord>> FindTxtAsync(string zoneId, string token, string name, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<CloudflareTxtRecord>>([.. _records.Values.Where(record => record.Name == name)]);

    public Task DeleteAsync(string zoneId, string token, string recordId, CancellationToken cancellationToken)
    {
        _records.TryRemove(recordId, out _);
        return Task.CompletedTask;
    }
}

/// <summary>
/// cloudflared and the Cloudflare One client as the DevHost sees them (E95): installing, starting
/// and joining Mesh only remember what happened, and a started tunnel is connected at once, so the
/// app's whole tunnel flow runs without Cloudflare. Nothing leaves the machine.
/// </summary>
internal sealed class FakeCloudflaredMachine : ICloudflared, ICloudflaredHealth, ICloudflareMesh
{
    private volatile bool _installed;
    private volatile bool _running;
    private int _metricsPort;

    public Task<CloudflaredState> InspectAsync(CancellationToken cancellationToken) =>
        Task.FromResult(new CloudflaredState(_installed, _installed ? "2025.10.1" : null, _running));

    public Task InstallAsync(Jobs.JobContext job, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(job);
        job.Log(_installed ? "cloudflared is already installed." : "Installed cloudflared (pretend).");
        _installed = true;
        return Task.CompletedTask;
    }

    public Task StartAsync(string token, int metricsPort, CancellationToken cancellationToken)
    {
        TunnelToken.Parse(token);
        (_running, _metricsPort) = (true, metricsPort);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _running = false;
        return Task.CompletedTask;
    }

    public Task<TunnelHealth> ReadAsync(int metricsPort, CancellationToken cancellationToken) =>
        Task.FromResult(_running && metricsPort == _metricsPort ? new TunnelHealth(true, 4) : new TunnelHealth(false, 0));

    public Task<string> JoinAsync(string token, Jobs.JobContext job, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(job);
        TunnelToken.Parse(token);
        job.Log("This server's Mesh address is 100.96.0.12 (pretend).");
        return Task.FromResult("100.96.0.12");
    }
}
