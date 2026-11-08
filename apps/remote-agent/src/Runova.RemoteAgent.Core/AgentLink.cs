using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Runova.RemoteAgent.Core;

/// <summary>One way to carry link frames to the other computer; for the agent, the website's relay.</summary>
public interface ILinkTransport : IAsyncDisposable
{
    Task SendAsync(byte[] frame, CancellationToken ct);

    /// <summary>The next frame, or null once the other side or the relay closed.</summary>
    Task<byte[]?> ReceiveAsync(CancellationToken ct);
}

/// <summary>
/// A Runova Anywhere link, as apps/desktop/src/main/remote/anywhere/link.ts: the handshake first,
/// with nothing else accepted until it succeeds, then framed messages, sealed when the transport is
/// the relay.
/// </summary>
public sealed class AgentLink : IAsyncDisposable
{
    private readonly ILinkTransport _transport;
    private readonly FrameCipher? _cipher;
    private readonly LinkReassembler _reassembler = new();
    private readonly SemaphoreSlim _sending = new(1, 1);
    private uint _nextMessageId;

    private AgentLink(ILinkTransport transport, SessionKeys keys, bool sealFrames, uint nextMessageId)
    {
        _transport = transport;
        _cipher = sealFrames ? new FrameCipher(keys.Send, keys.Receive) : null;
        _nextMessageId = nextMessageId;
        SafetyCode = keys.SafetyCode;
    }

    public string SafetyCode { get; }

    public static async Task<AgentLink> AcceptAsync(ILinkTransport transport, HostHandshake handshake, bool sealFrames, TimeSpan timeout, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(transport);
        ArgumentNullException.ThrowIfNull(handshake);
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
        limit.CancelAfter(timeout);
        uint id = 1;
        var hello = await NextHandshakeAsync(transport, limit.Token);
        HandshakeMessage reply;
        try
        {
            reply = handshake.Respond(hello);
        }
        catch (HandshakeException e)
        {
            await AbortAsync(transport, e.Reason, id, ct);
            throw;
        }

        await SendHandshakeAsync(transport, reply, id++, limit.Token);
        var finish = await NextHandshakeAsync(transport, limit.Token);
        try
        {
            return new AgentLink(transport, handshake.Complete(finish), sealFrames, id);
        }
        catch (HandshakeException e) when (finish.T != "hs-abort")
        {
            await AbortAsync(transport, e.Reason, id, ct);
            throw;
        }
    }

    public static async Task<AgentLink> ConnectAsync(ILinkTransport transport, ControllerHandshake handshake, bool sealFrames, TimeSpan timeout, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(transport);
        ArgumentNullException.ThrowIfNull(handshake);
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
        limit.CancelAfter(timeout);
        uint id = 1;
        await SendHandshakeAsync(transport, handshake.Hello, id++, limit.Token);
        var reply = await NextHandshakeAsync(transport, limit.Token);
        try
        {
            var (finish, keys) = handshake.Complete(reply);
            await SendHandshakeAsync(transport, finish, id++, limit.Token);
            return new AgentLink(transport, keys, sealFrames, id);
        }
        catch (HandshakeException e) when (reply.T != "hs-abort")
        {
            await AbortAsync(transport, e.Reason, id, ct);
            throw;
        }
    }

    public Task SendControlAsync(JsonObject message, CancellationToken ct) =>
        SendAsync(LinkFraming.Text, JsonSerializer.SerializeToUtf8Bytes(message), ct);

    public Task SendBinaryAsync(byte[] payload, CancellationToken ct) => SendAsync(LinkFraming.Binary, payload, ct);

    private async Task SendAsync(byte kind, byte[] payload, CancellationToken ct)
    {
        // One message at a time: the frames of a message go together, and each sealed frame takes
        // the next counter in the order it is sent.
        await _sending.WaitAsync(ct);
        try
        {
            foreach (var frame in LinkFraming.Encode(kind, payload, _nextMessageId++))
            {
                await _transport.SendAsync(_cipher is null ? frame : _cipher.Seal(frame), ct);
            }
        }
        finally
        {
            _sending.Release();
        }
    }

    public async IAsyncEnumerable<LinkMessage> ReadAsync([EnumeratorCancellation] CancellationToken ct)
    {
        while (await _transport.ReceiveAsync(ct) is { } frame)
        {
            if (_reassembler.Push(_cipher is null ? frame : _cipher.Open(frame)) is { } message)
            {
                yield return message;
            }
        }
    }

    private static async Task<HandshakeMessage> NextHandshakeAsync(ILinkTransport transport, CancellationToken ct)
    {
        var frame = await transport.ReceiveAsync(ct) ?? throw new HandshakeException(HandshakeFailure.Protocol);
        try
        {
            var message = frame.Length > 1 && frame[0] == LinkFraming.Text ? JsonSerializer.Deserialize<HandshakeMessage>(frame.AsSpan(1)) : null;
            return message is not null && message.T.StartsWith("hs-", StringComparison.Ordinal) ? message : throw new HandshakeException(HandshakeFailure.Protocol);
        }
        catch (JsonException)
        {
            throw new HandshakeException(HandshakeFailure.Protocol);
        }
    }

    private static async Task SendHandshakeAsync(ILinkTransport transport, HandshakeMessage message, uint id, CancellationToken ct)
    {
        foreach (var frame in LinkFraming.Encode(LinkFraming.Text, JsonSerializer.SerializeToUtf8Bytes(message), id))
        {
            await transport.SendAsync(frame, ct);
        }
    }

    private static async Task AbortAsync(ILinkTransport transport, HandshakeFailure reason, uint id, CancellationToken ct)
    {
        try
        {
            await SendHandshakeAsync(transport, new HandshakeMessage { T = "hs-abort", Reason = HandshakeException.WireName(reason) }, id, ct);
        }
        catch (Exception e) when (e is OperationCanceledException or IOException or InvalidOperationException)
        {
        }
    }

    public async ValueTask DisposeAsync()
    {
        _cipher?.Dispose();
        _sending.Dispose();
        await _transport.DisposeAsync();
    }
}
