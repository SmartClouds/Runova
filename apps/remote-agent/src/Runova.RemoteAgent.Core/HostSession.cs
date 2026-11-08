using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace Runova.RemoteAgent.Core;

public sealed record SessionPermissions(bool Control, bool Clipboard, bool Files);

public sealed record SessionOptions(SessionPermissions Permissions, string Intent, TimeSpan FrameInterval);

/// <summary>A captured screen in 32-bit BGRA rows.</summary>
public sealed record ScreenFrame(int Width, int Height, int Stride, byte[] Pixels);

public readonly record struct TileRect(int X, int Y, int W, int H);

/// <summary>Whatever is on the screen right now, including the sign-in screen when no one is signed in.</summary>
public interface IScreenSource
{
    ScreenFrame? Capture();
}

public interface ITileEncoder
{
    byte[] Encode(ScreenFrame frame, TileRect rect);
}

/// <summary>Moves the mouse and types for the controller; the events are the app's `RemoteInputEvent`.</summary>
public interface IInputSink
{
    void Apply(JsonObject inputEvent);
}

/// <summary>
/// One session the agent hosts (E64), speaking the app's remote-control protocol over the link:
/// it lets the controller in (the handshake already proved who it is), streams the screen as JPEG
/// tiles that changed since the last frame, and applies input only when the session may control.
/// The agent has no video encoder, so a request for WebRTC video is answered "unavailable" and the
/// controller shows the tiles, as it does for any host without video. Files are refused: on the
/// sign-in screen no one owns a folder to send them to.
/// </summary>
public sealed class HostSession(AgentLink link, string deviceName, IScreenSource screen, ITileEncoder encoder, IInputSink input, SessionOptions options)
{
    public const int TileSize = 256;
    private const string FilesRefused = "Files are not available here while the computer is on the sign-in screen.";
    private readonly Dictionary<(int, int), byte[]> _tileHashes = [];
    private (int Width, int Height)? _size;
    private uint _frameId;

    public async Task RunAsync(CancellationToken ct)
    {
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var first = screen.Capture();
        _size = first is null ? null : (first.Width, first.Height);
        await link.SendControlAsync(
            new JsonObject
            {
                ["t"] = "auth-ok",
                ["deviceName"] = deviceName,
                ["screen"] = new JsonObject { ["width"] = first?.Width ?? 0, ["height"] = first?.Height ?? 0 },
            },
            stop.Token);

        Task? streaming = null;
        try
        {
            await foreach (var message in link.ReadAsync(stop.Token))
            {
                if (message.Kind != LinkFraming.Text || JsonNode.Parse(message.Payload) is not JsonObject msg)
                {
                    continue;
                }

                var t = (string?)msg["t"];
                if (t == "bye")
                {
                    break;
                }

                if (t == "control-start" && options.Intent == "control" && streaming is null)
                {
                    streaming = StreamAsync(stop.Token);
                    continue;
                }

                await HandleAsync(t, msg, stop.Token);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
        }
        finally
        {
            await stop.CancelAsync();
            if (streaming is not null)
            {
                try
                {
                    await streaming;
                }
                catch (OperationCanceledException)
                {
                }
            }
        }
    }

    private async Task HandleAsync(string? t, JsonObject msg, CancellationToken ct)
    {
        switch (t)
        {
            case "input" when options.Permissions.Control && msg["event"] is JsonObject inputEvent:
                input.Apply(inputEvent);
                break;
            case "ping":
                await link.SendControlAsync(new JsonObject { ["t"] = "pong" }, ct);
                break;
            case "rtc-request":
                await link.SendControlAsync(new JsonObject { ["t"] = "rtc-unavailable", ["reason"] = "This computer is on the sign-in screen and sends its screen as pictures." }, ct);
                break;
            case "file-offer" or "file-resume" or "file-part-done" or "file-complete":
                await link.SendControlAsync(new JsonObject { ["t"] = "file-error", ["transferId"] = (string?)msg["transferId"], ["message"] = FilesRefused }, ct);
                break;
            case "file-request":
                await link.SendControlAsync(new JsonObject { ["t"] = "file-request-ack", ["reqId"] = (string?)msg["reqId"], ["ok"] = false, ["error"] = FilesRefused }, ct);
                break;
            case "fm-roots":
                await link.SendControlAsync(new JsonObject { ["t"] = "fm-roots-reply", ["reqId"] = (string?)msg["reqId"], ["roots"] = new JsonArray() }, ct);
                break;
            case "fm-list":
                await link.SendControlAsync(new JsonObject { ["t"] = "fm-list-reply", ["reqId"] = (string?)msg["reqId"], ["path"] = (string?)msg["path"] ?? "", ["entries"] = new JsonArray(), ["error"] = FilesRefused }, ct);
                break;
            case "fm-mkdir" or "fm-delete" or "fm-rename":
                await link.SendControlAsync(new JsonObject { ["t"] = "fm-ack", ["reqId"] = (string?)msg["reqId"], ["ok"] = false, ["error"] = FilesRefused }, ct);
                break;
        }
    }

    private async Task StreamAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(options.FrameInterval);
        do
        {
            if (screen.Capture() is not { } frame)
            {
                continue;
            }

            if (_size != (frame.Width, frame.Height))
            {
                _size = (frame.Width, frame.Height);
                _tileHashes.Clear();
                await link.SendControlAsync(new JsonObject { ["t"] = "screen-info", ["width"] = frame.Width, ["height"] = frame.Height }, ct);
            }

            _frameId++;
            foreach (var rect in Tiles(frame.Width, frame.Height))
            {
                var hash = HashTile(frame, rect);
                if (_tileHashes.TryGetValue((rect.X, rect.Y), out var previous) && previous.AsSpan().SequenceEqual(hash))
                {
                    continue;
                }

                _tileHashes[(rect.X, rect.Y)] = hash;
                await link.SendBinaryAsync(EncodeTile(_frameId, rect, encoder.Encode(frame, rect)), ct);
            }
        }
        while (await timer.WaitForNextTickAsync(ct));
    }

    public static IEnumerable<TileRect> Tiles(int width, int height)
    {
        for (var y = 0; y < height; y += TileSize)
        {
            for (var x = 0; x < width; x += TileSize)
            {
                yield return new TileRect(x, y, Math.Min(TileSize, width - x), Math.Min(TileSize, height - y));
            }
        }
    }

    private static byte[] HashTile(ScreenFrame frame, TileRect rect)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        for (var row = rect.Y; row < rect.Y + rect.H; row++)
        {
            hash.AppendData(frame.Pixels, (row * frame.Stride) + (rect.X * 4), rect.W * 4);
        }

        return hash.GetHashAndReset();
    }

    /// <summary>The app's screen tile: kind 0x01, frame id u32, x, y, w, h u16, all big-endian, then the JPEG.</summary>
    public static byte[] EncodeTile(uint frameId, TileRect rect, byte[] jpeg)
    {
        ArgumentNullException.ThrowIfNull(jpeg);
        var output = new byte[13 + jpeg.Length];
        output[0] = 0x01;
        BinaryPrimitives.WriteUInt32BigEndian(output.AsSpan(1), frameId);
        BinaryPrimitives.WriteUInt16BigEndian(output.AsSpan(5), (ushort)rect.X);
        BinaryPrimitives.WriteUInt16BigEndian(output.AsSpan(7), (ushort)rect.Y);
        BinaryPrimitives.WriteUInt16BigEndian(output.AsSpan(9), (ushort)rect.W);
        BinaryPrimitives.WriteUInt16BigEndian(output.AsSpan(11), (ushort)rect.H);
        jpeg.CopyTo(output, 13);
        return output;
    }
}
