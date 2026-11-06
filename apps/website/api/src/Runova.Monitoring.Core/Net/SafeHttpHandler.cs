using System.Net;
using System.Net.Sockets;

namespace Runova.Monitoring.Core.Net;

/// <summary>Looks up the addresses of a host name.</summary>
public delegate Task<IPAddress[]> HostResolver(string host, CancellationToken ct);

/// <summary>How <see cref="SafeHttpHandler"/> resolves and connects.</summary>
public sealed record SafeHttpOptions
{
    /// <summary>The DNS lookup. <see cref="Dns.GetHostAddressesAsync(string, CancellationToken)"/> unless replaced.</summary>
    public HostResolver Resolve { get; init; } = (host, ct) => Dns.GetHostAddressesAsync(host, ct);

    /// <summary>Lets loopback and private addresses through. Only for tests against a local server.</summary>
    public bool AllowPrivateAddresses { get; init; }

    /// <summary>How long resolving and connecting may take together.</summary>
    public TimeSpan ConnectTimeout { get; init; } = TimeSpan.FromSeconds(5);

    /// <summary>Opens the TCP stream to a checked address. Tests replace it to see where it connects.</summary>
    internal Func<IPEndPoint, CancellationToken, ValueTask<Stream>> Connect { get; init; } = ConnectSocketAsync;

    private static async ValueTask<Stream> ConnectSocketAsync(IPEndPoint endpoint, CancellationToken ct)
    {
        var socket = new Socket(endpoint.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
        try
        {
            await socket.ConnectAsync(endpoint, ct).ConfigureAwait(false);
            return new NetworkStream(socket, ownsSocket: true);
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }
}

/// <summary>
/// The HTTP handler a monitoring node checks users' endpoints with. It only ever connects to
/// public addresses: the host is resolved once, the answers are checked with
/// <see cref="PublicAddressGuard"/>, and the socket is connected to a checked address itself, so a
/// DNS answer that changes between the check and the connection (rebinding) can not slip a
/// private address in. Redirects, cookies and proxies are off.
/// </summary>
public static class SafeHttpHandler
{
    /// <summary>The response headers may be this large, in KB.</summary>
    public const int MaxResponseHeadersKb = 64;

    public static SocketsHttpHandler Create(SafeHttpOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        return new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            UseCookies = false,
            UseProxy = false,
            Proxy = null,
            Credentials = null,
            PreAuthenticate = false,
            AutomaticDecompression = DecompressionMethods.None,
            MaxResponseHeadersLength = MaxResponseHeadersKb,
            // A body left unread is not drained; the connection is closed instead.
            MaxResponseDrainSize = 0,
            ConnectTimeout = options.ConnectTimeout,
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
            PooledConnectionIdleTimeout = TimeSpan.FromSeconds(30),
            ConnectCallback = (context, ct) => ConnectAsync(options, context.DnsEndPoint, ct),
        };
    }

    internal static async ValueTask<Stream> ConnectAsync(SafeHttpOptions options, DnsEndPoint endpoint, CancellationToken ct)
    {
        var host = endpoint.Host;
        var bare = host.StartsWith('[') && host.EndsWith(']') ? host[1..^1] : host;
        IPAddress[] candidates = IPAddress.TryParse(bare, out var literal)
            ? [literal]
            : await options.Resolve(host, ct).ConfigureAwait(false) ?? [];

        var allowed = new List<IPAddress>();
        (IPAddress Address, string Reason)? refused = null;
        foreach (var candidate in candidates)
        {
            var reason = options.AllowPrivateAddresses ? null : PublicAddressGuard.WhyBlocked(candidate);
            if (reason is not null)
            {
                refused ??= (candidate, reason);
                continue;
            }

            var address = candidate.IsIPv4MappedToIPv6 ? candidate.MapToIPv4() : candidate;
            if (!allowed.Contains(address))
            {
                allowed.Add(address);
            }
        }

        if (allowed.Count == 0)
        {
            if (refused is { } blocked)
            {
                throw new BlockedAddressException(host, blocked.Address, blocked.Reason);
            }

            throw new SocketException((int)SocketError.HostNotFound);
        }

        // Try each checked address in turn, never asking DNS again.
        for (var index = 0; ; index++)
        {
            try
            {
                return await options.Connect(new IPEndPoint(allowed[index], endpoint.Port), ct).ConfigureAwait(false);
            }
            catch (SocketException) when (index < allowed.Count - 1 && !ct.IsCancellationRequested)
            {
            }
        }
    }
}
