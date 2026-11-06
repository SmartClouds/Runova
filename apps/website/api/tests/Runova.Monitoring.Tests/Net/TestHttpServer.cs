using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Runova.Monitoring.Tests.Net;

/// <summary>A request as the test server read it.</summary>
public sealed record TestRequest(string Method, string Target, IReadOnlyDictionary<string, string> Headers);

/// <summary>
/// A tiny HTTP/1.1 server on 127.0.0.1 that writes whatever bytes a test wants, including
/// redirects, huge bodies, broken responses and answers that never come. One request per
/// connection; the connection closes after the response.
/// </summary>
public sealed class TestHttpServer : IAsyncDisposable
{
    private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
    private readonly CancellationTokenSource _stop = new();
    private readonly Func<TestRequest, Stream, CancellationToken, Task> _respond;
    private readonly ConcurrentQueue<TestRequest> _requests = new();
    private readonly TaskCompletionSource<TestRequest> _first = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly Task _loop;

    public TestHttpServer(Func<TestRequest, Stream, CancellationToken, Task> respond)
    {
        _respond = respond;
        _listener.Start();
        Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
        _loop = AcceptAsync();
    }

    /// <summary>A server that answers every request with this status and body.</summary>
    public static TestHttpServer Answering(int status, string body, string? contentType = "application/health+json", string headers = "") =>
        new((_, stream, ct) => WriteAsync(stream, status, body, contentType, headers, ct));

    public int Port { get; }

    public IReadOnlyCollection<TestRequest> Requests => _requests;

    public Task<TestRequest> FirstRequest => _first.Task;

    public Uri Url(string path = "/health", string host = "127.0.0.1") => new($"http://{host}:{Port}{path}");

    public static async Task WriteAsync(Stream stream, int status, string body, string? contentType = "application/health+json", string headers = "", CancellationToken ct = default)
    {
        var bytes = Encoding.UTF8.GetBytes(body);
        var head = new StringBuilder()
            .Append("HTTP/1.1 ").Append(status).Append(" Test\r\n")
            .Append(contentType is null ? "" : "Content-Type: " + contentType + "\r\n")
            .Append("Content-Length: ").Append(bytes.Length).Append("\r\n")
            .Append("Connection: close\r\n")
            .Append(headers)
            .Append("\r\n");
        await stream.WriteAsync(Encoding.ASCII.GetBytes(head.ToString()), ct);
        await stream.WriteAsync(bytes, ct);
    }

    private async Task AcceptAsync()
    {
        try
        {
            while (true)
            {
                var client = await _listener.AcceptTcpClientAsync(_stop.Token);
                _ = ServeAsync(client);
            }
        }
        catch (Exception error) when (error is OperationCanceledException or SocketException or ObjectDisposedException)
        {
        }
    }

    private async Task ServeAsync(TcpClient client)
    {
        using (client)
        {
            try
            {
                var stream = client.GetStream();
                var request = await ReadRequestAsync(stream, _stop.Token);
                if (request is null)
                {
                    return;
                }

                _requests.Enqueue(request);
                _first.TrySetResult(request);
                await _respond(request, stream, _stop.Token);
                await stream.FlushAsync(_stop.Token);
            }
            catch (Exception error) when (error is IOException or SocketException or OperationCanceledException or ObjectDisposedException)
            {
                // The client went away or the test ended; either is fine here.
            }
        }
    }

    private static async Task<TestRequest?> ReadRequestAsync(Stream stream, CancellationToken ct)
    {
        var head = new List<byte>();
        var one = new byte[1];
        while (head.Count < 64 * 1024)
        {
            if (await stream.ReadAsync(one, ct) == 0)
            {
                return null;
            }

            head.Add(one[0]);
            if (head.Count >= 4 && head[^4] == '\r' && head[^3] == '\n' && head[^2] == '\r' && head[^1] == '\n')
            {
                break;
            }
        }

        var lines = Encoding.ASCII.GetString([.. head]).Split("\r\n");
        var start = lines[0].Split(' ');
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var line in lines.Skip(1).Where(line => line.Length > 0))
        {
            var colon = line.IndexOf(':', StringComparison.Ordinal);
            headers[line[..colon]] = line[(colon + 1)..].Trim();
        }

        return new TestRequest(start[0], start[1], headers);
    }

    public async ValueTask DisposeAsync()
    {
        await _stop.CancelAsync();
        _listener.Stop();
        await _loop;
        _stop.Dispose();
    }
}
