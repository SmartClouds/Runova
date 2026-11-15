using System.Globalization;
using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace Runova.ServerCore.Cloudflare;

/// <summary>Whether cloudflared holds a connection to Cloudflare, and how many.</summary>
internal sealed record TunnelHealth(bool Ready, int Connections);

/// <summary>Asks cloudflared itself, on its loopback metrics port.</summary>
internal interface ICloudflaredHealth
{
    Task<TunnelHealth> ReadAsync(int metricsPort, CancellationToken cancellationToken);
}

/// <summary>
/// cloudflared's /ready answers 200 once at least one connection to Cloudflare's edge is up, with
/// the count in readyConnections, and 503 otherwise. Anything else (not running, no answer in five
/// seconds) counts as not ready.
/// </summary>
internal sealed class HttpCloudflaredHealth : ICloudflaredHealth, IDisposable
{
    private readonly HttpClient _client = new(new SocketsHttpHandler { AllowAutoRedirect = false, UseProxy = false })
    {
        Timeout = TimeSpan.FromSeconds(5),
        MaxResponseContentBufferSize = 64 * 1024,
    };

    public async Task<TunnelHealth> ReadAsync(int metricsPort, CancellationToken cancellationToken)
    {
        if (metricsPort is < 1 or > 65535)
        {
            return new TunnelHealth(false, 0);
        }

        try
        {
            using var response = await _client.GetAsync(new Uri($"http://127.0.0.1:{metricsPort.ToString(CultureInfo.InvariantCulture)}/ready"), cancellationToken);
            var body = await response.Content.ReadFromJsonAsync<ReadyBody>(cancellationToken);
            var connections = Math.Max(0, body?.ReadyConnections ?? 0);
            return new TunnelHealth(response.IsSuccessStatusCode && connections > 0, connections);
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException or System.Text.Json.JsonException or NotSupportedException)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return new TunnelHealth(false, 0);
        }
    }

    public void Dispose() => _client.Dispose();

    private sealed record ReadyBody([property: JsonPropertyName("readyConnections")] int ReadyConnections);
}
