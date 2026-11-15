using Runova.ServerCore.Cloudflare;
using Runova.ServerCore.Jobs;

namespace Runova.ServerCore.Tests.Cloudflare;

/// <summary>
/// cloudflared as the tests see it: installing and starting only record what happened, and the
/// tunnel counts as connected once started unless a test cuts it off with <see cref="Connected"/>.
/// </summary>
internal sealed class FakeCloudflared : ICloudflared, ICloudflaredHealth, ICloudflareMesh
{
    /// <summary>The Mesh address the node gets when it joins.</summary>
    public string MeshAddress { get; set; } = "100.96.0.12";

    public string? MeshToken { get; private set; }

    public Task<string> JoinAsync(string token, JobContext job, CancellationToken cancellationToken)
    {
        TunnelToken.Parse(token);
        MeshToken = token;
        job.Log($"This server's Mesh address is {MeshAddress}.");
        return Task.FromResult(MeshAddress);
    }

    public bool Installed { get; private set; }

    public bool Running { get; private set; }

    /// <summary>The token cloudflared was last started with; null once stopped.</summary>
    public string? Token { get; private set; }

    public int? MetricsPort { get; private set; }

    /// <summary>Whether the edge answers; a running tunnel only counts as ready while this holds.</summary>
    public bool Connected { get; set; } = true;

    public Exception? StartFailure { get; set; }

    public int Starts { get; private set; }

    public Task<CloudflaredState> InspectAsync(CancellationToken cancellationToken) =>
        Task.FromResult(new CloudflaredState(Installed, Installed ? "2025.10.1" : null, Running));

    public Task InstallAsync(JobContext job, CancellationToken cancellationToken)
    {
        job.Log(Installed ? "cloudflared is already installed." : "cloudflared is installed.");
        Installed = true;
        return Task.CompletedTask;
    }

    public Task StartAsync(string token, int metricsPort, CancellationToken cancellationToken)
    {
        if (StartFailure is { } failure)
        {
            return Task.FromException(failure);
        }

        TunnelToken.Parse(token);
        (Running, Token, MetricsPort) = (true, token, metricsPort);
        Starts++;
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        (Running, Token) = (false, null);
        return Task.CompletedTask;
    }

    public Task<TunnelHealth> ReadAsync(int metricsPort, CancellationToken cancellationToken) =>
        Task.FromResult(Running && Connected && metricsPort == MetricsPort ? new TunnelHealth(true, 4) : new TunnelHealth(false, 0));
}
