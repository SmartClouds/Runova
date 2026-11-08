using System.Buffers;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Options;

namespace Runova.Website.Api.Remote;

public enum RelaySide
{
    Host,
    Controller,
}

public sealed record RelayTicket(string SessionId, RelaySide Side);

/// <summary>What one relay session may cost, from the <c>Remote:Relay</c> settings.</summary>
public sealed class RemoteRelayOptions
{
    public const string SectionName = "Remote:Relay";

    /// <summary>Bytes both directions may carry together, about a day of screen tiles.</summary>
    public long MaxSessionBytes { get; set; } = 50L * 1024 * 1024 * 1024;
}

/// <summary>A ticket for one side of a session to meet the other on the relay.</summary>
public sealed record RelayTicketDto(string Path, string Ticket);

/// <summary>
/// One-time tickets for the relay (E62). The hub hands one to each side of an accepted session;
/// a ticket works once, for one minute, for its own session only. It is the relay's only
/// credential, so it is 256 random bits and compared through a dictionary of its hash.
/// </summary>
internal sealed class RemoteRelayTickets(TimeProvider time)
{
    public static readonly TimeSpan ValidFor = TimeSpan.FromMinutes(1);

    private readonly Dictionary<string, (RelayTicket Ticket, DateTimeOffset ExpiresAt)> _tickets = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();

    public int Count
    {
        get
        {
            lock (_gate)
            {
                return _tickets.Count;
            }
        }
    }

    public string Issue(string sessionId, RelaySide side)
    {
        var ticket = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        var now = time.GetUtcNow();
        lock (_gate)
        {
            foreach (var (key, entry) in _tickets.ToList())
            {
                if (entry.ExpiresAt <= now)
                {
                    _tickets.Remove(key);
                }
            }

            _tickets[Hash(ticket)] = (new RelayTicket(sessionId, side), now + ValidFor);
        }

        return ticket;
    }

    /// <summary>Uses the ticket up. Null when it is unknown, used, expired or for another session.</summary>
    public RelayTicket? Redeem(string ticket, string sessionId)
    {
        if (string.IsNullOrEmpty(ticket))
        {
            return null;
        }

        lock (_gate)
        {
            if (!_tickets.Remove(Hash(ticket), out var entry) || entry.ExpiresAt <= time.GetUtcNow() || entry.Ticket.SessionId != sessionId)
            {
                return null;
            }

            return entry.Ticket;
        }
    }

    private static string Hash(string ticket) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(ticket)));
}

/// <summary>
/// Runova Anywhere's relay (E62): when two computers can not reach each other directly, each opens
/// a WebSocket here with its ticket, and the relay copies binary messages between them. It never
/// reads them; the two computers seal every frame with keys the relay never sees. One message is
/// forwarded at a time in each direction, so a slow side slows the other instead of filling memory.
/// </summary>
internal sealed partial class RemoteRelay(RemoteRelayTickets tickets, IOptions<RemoteRelayOptions> options, TimeProvider time, ILogger<RemoteRelay> logger)
{
    public const string PathPrefix = "/relay/remote";

    public const string OverLimitReason = "This relay session used up its data limit.";

    /// <summary>A link frame is 60 KiB, plus 24 bytes of the cipher; anything much larger is not ours.</summary>
    public const int MaxMessageBytes = 128 * 1024;

    public static readonly TimeSpan PairWithin = TimeSpan.FromSeconds(30);

    /// <summary>A session on the relay ends after this long, connected or not.</summary>
    public static readonly TimeSpan MaxDuration = TimeSpan.FromHours(12);

    private readonly Dictionary<string, Waiting> _waiting = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();

    private sealed record Waiting(RelaySide Side, WebSocket Socket, TaskCompletionSource<WebSocket?> Partner);

    public async Task HandleAsync(HttpContext http, string sessionId)
    {
        if (!http.WebSockets.IsWebSocketRequest)
        {
            http.Response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }

        if (tickets.Redeem(http.Request.Query["ticket"].ToString(), sessionId) is not { } ticket)
        {
            http.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }

        using var socket = await http.WebSockets.AcceptWebSocketAsync();
        var ct = http.RequestAborted;
        var partner = await PairAsync(ticket, socket, ct);
        if (partner is null)
        {
            await CloseQuietlyAsync(socket, WebSocketCloseStatus.PolicyViolation, "The other computer did not arrive.");
            return;
        }

        // The side that arrived second runs both pumps; the first one waits here for them to end.
        if (ReferenceEquals(partner, socket))
        {
            await WaitClosedAsync(socket, ct);
            return;
        }

        LogPaired(logger, sessionId);
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(ct);
        lifetime.CancelAfter(MaxDuration);
        var ready = Encoding.ASCII.GetBytes("ready");
        await socket.SendAsync(ready, WebSocketMessageType.Text, true, lifetime.Token);
        await partner.SendAsync(ready, WebSocketMessageType.Text, true, lifetime.Token);
        var started = time.GetUtcNow();
        var allowance = new Allowance(options.Value.MaxSessionBytes);
        var first = await Task.WhenAny(PumpAsync(socket, partner, allowance, lifetime.Token), PumpAsync(partner, socket, allowance, lifetime.Token));
        var (status, reason) = allowance.Exceeded
            ? (WebSocketCloseStatus.PolicyViolation, OverLimitReason)
            : (WebSocketCloseStatus.NormalClosure, "ended");

        // Both sides hear why before the pumps stop: cancelling a receive aborts its socket.
        await CloseQuietlyAsync(socket, status, reason);
        await CloseQuietlyAsync(partner, status, reason);
        await lifetime.CancelAsync();
        var bytes = await first;
        var seconds = (time.GetUtcNow() - started).TotalSeconds;
        LogEnded(logger, sessionId, seconds, bytes);
    }

    /// <summary>
    /// Waits for the other side. Returns the partner's socket to the second arrival, this socket to
    /// the first (whose request then only waits), or null when no one came in time.
    /// </summary>
    private async Task<WebSocket?> PairAsync(RelayTicket ticket, WebSocket socket, CancellationToken ct)
    {
        Waiting? waiting;
        Waiting? mine = null;
        lock (_gate)
        {
            if (_waiting.Remove(ticket.SessionId, out waiting) && waiting.Side != ticket.Side)
            {
                waiting.Partner.TrySetResult(socket);
                return waiting.Socket;
            }

            if (waiting is not null)
            {
                // The same side twice: the newer connection wins, the older one gives up.
                waiting.Partner.TrySetResult(null);
            }

            mine = new Waiting(ticket.Side, socket, new TaskCompletionSource<WebSocket?>(TaskCreationOptions.RunContinuationsAsynchronously));
            _waiting[ticket.SessionId] = mine;
        }

        try
        {
            var partner = await mine.Partner.Task.WaitAsync(PairWithin, time, ct);
            return partner is null ? null : socket;
        }
        catch (Exception e) when (e is TimeoutException or OperationCanceledException)
        {
            lock (_gate)
            {
                if (_waiting.TryGetValue(ticket.SessionId, out var current) && ReferenceEquals(current, mine))
                {
                    _waiting.Remove(ticket.SessionId);
                }
            }

            return null;
        }
    }

    /// <summary>The bytes a session has left, shared by its two directions.</summary>
    private sealed class Allowance(long limit)
    {
        private long _used;

        public bool Exceeded => Volatile.Read(ref _used) > limit;

        public bool Spend(int bytes) => Interlocked.Add(ref _used, bytes) <= limit;
    }

    private static async Task<long> PumpAsync(WebSocket from, WebSocket to, Allowance allowance, CancellationToken ct)
    {
        var buffer = ArrayPool<byte>.Shared.Rent(MaxMessageBytes);
        long total = 0;
        try
        {
            while (!ct.IsCancellationRequested)
            {
                var length = 0;
                ValueWebSocketReceiveResult result;
                do
                {
                    if (length == MaxMessageBytes)
                    {
                        return total;
                    }

                    result = await from.ReceiveAsync(buffer.AsMemory(length, MaxMessageBytes - length), ct);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        return total;
                    }

                    length += result.Count;
                }
                while (!result.EndOfMessage);

                // Only binary frames are the computers' own; anything else ends the session.
                if (result.MessageType != WebSocketMessageType.Binary)
                {
                    return total;
                }

                if (!allowance.Spend(length))
                {
                    return total;
                }

                await to.SendAsync(buffer.AsMemory(0, length), WebSocketMessageType.Binary, true, ct);
                total += length;
            }
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException)
        {
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }

        return total;
    }

    private static async Task WaitClosedAsync(WebSocket socket, CancellationToken ct)
    {
        while (socket.State is WebSocketState.Open or WebSocketState.CloseReceived && !ct.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(1), ct);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    private static async Task CloseQuietlyAsync(WebSocket socket, WebSocketCloseStatus status, string reason)
    {
        if (socket.State is not (WebSocketState.Open or WebSocketState.CloseReceived))
        {
            return;
        }

        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            await socket.CloseOutputAsync(status, reason, timeout.Token);
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException)
        {
        }
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Relay session {SessionId} paired")]
    private static partial void LogPaired(ILogger logger, string sessionId);

    [LoggerMessage(Level = LogLevel.Information, Message = "Relay session {SessionId} ended after {Seconds:F0} s and {Bytes} bytes one way")]
    private static partial void LogEnded(ILogger logger, string sessionId, double seconds, long bytes);
}
