using System.Net.WebSockets;
using System.Text;
using Runova.RemoteAgent.Core;

namespace Runova.RemoteAgent;

/// <summary>
/// The website's relay (E62) as a link transport: one WebSocket with a one-time ticket, binary
/// messages each way once both sides are there. Frames are sealed above this, so it carries bytes
/// it never needs to read.
/// </summary>
public sealed class RelayTransport : ILinkTransport
{
    private const int MaxFrame = 128 * 1024;
    private readonly ClientWebSocket _socket;
    private readonly byte[] _buffer = new byte[MaxFrame];

    private RelayTransport(ClientWebSocket socket) => _socket = socket;

    public static Uri UrlFor(string siteUrl, string path, string ticket)
    {
        var builder = new UriBuilder(new Uri(new Uri(siteUrl), path))
        {
            Scheme = siteUrl.StartsWith("https:", StringComparison.OrdinalIgnoreCase) ? "wss" : "ws",
            Query = $"ticket={Uri.EscapeDataString(ticket)}",
        };
        return builder.Uri;
    }

    public static async Task<RelayTransport> OpenAsync(Uri url, TimeSpan readyWithin, CancellationToken ct)
    {
        var socket = new ClientWebSocket();
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
        limit.CancelAfter(readyWithin);
        await socket.ConnectAsync(url, limit.Token);
        var transport = new RelayTransport(socket);
        var ready = await socket.ReceiveAsync(transport._buffer, limit.Token);
        if (ready.MessageType != WebSocketMessageType.Text || Encoding.ASCII.GetString(transport._buffer, 0, ready.Count) != "ready")
        {
            await transport.DisposeAsync();
            throw new IOException("The relay did not connect the other computer.");
        }

        return transport;
    }

    public Task SendAsync(byte[] frame, CancellationToken ct) => _socket.SendAsync(frame, WebSocketMessageType.Binary, true, ct);

    public async Task<byte[]?> ReceiveAsync(CancellationToken ct)
    {
        var length = 0;
        while (true)
        {
            WebSocketReceiveResult result;
            try
            {
                result = await _socket.ReceiveAsync(new ArraySegment<byte>(_buffer, length, MaxFrame - length), ct);
            }
            catch (WebSocketException)
            {
                return null;
            }

            if (result.MessageType == WebSocketMessageType.Close)
            {
                return null;
            }

            length += result.Count;
            if (result.EndOfMessage)
            {
                return result.MessageType == WebSocketMessageType.Binary ? _buffer[..length] : null;
            }

            if (length == MaxFrame)
            {
                return null;
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_socket.State == WebSocketState.Open)
        {
            try
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                await _socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "ended", timeout.Token);
            }
            catch (Exception e) when (e is WebSocketException or OperationCanceledException)
            {
            }
        }

        _socket.Dispose();
    }
}
