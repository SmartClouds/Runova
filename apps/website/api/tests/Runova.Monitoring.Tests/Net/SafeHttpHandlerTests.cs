using System.Net;
using System.Net.Sockets;
using Runova.Monitoring.Core.Net;

namespace Runova.Monitoring.Tests.Net;

public sealed class SafeHttpHandlerTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>A resolver that answers from a script, one answer per call, and counts the calls.</summary>
    private sealed class ScriptedResolver(params IPAddress[][] answers)
    {
        private int _calls;

        public int Calls => _calls;

        public Task<IPAddress[]> Resolve(string host, CancellationToken ct)
        {
            var call = Interlocked.Increment(ref _calls) - 1;
            return Task.FromResult(answers[Math.Min(call, answers.Length - 1)]);
        }
    }

    private static IPAddress[] Ips(params string[] addresses) => [.. addresses.Select(IPAddress.Parse)];

    [Fact]
    public void Turns_off_redirects_cookies_proxies_and_decompression()
    {
        using var handler = SafeHttpHandler.Create(new SafeHttpOptions { ConnectTimeout = TimeSpan.FromSeconds(3) });
        Assert.False(handler.AllowAutoRedirect);
        Assert.False(handler.UseCookies);
        Assert.False(handler.UseProxy);
        Assert.Null(handler.Proxy);
        Assert.Equal(DecompressionMethods.None, handler.AutomaticDecompression);
        Assert.Equal(64, handler.MaxResponseHeadersLength);
        Assert.Equal(TimeSpan.FromSeconds(3), handler.ConnectTimeout);
        Assert.NotNull(handler.ConnectCallback);
    }

    [Fact]
    public void Defaults_to_real_dns_public_addresses_only_and_five_seconds()
    {
        var options = new SafeHttpOptions();
        Assert.False(options.AllowPrivateAddresses);
        Assert.Equal(TimeSpan.FromSeconds(5), options.ConnectTimeout);
        Assert.NotNull(options.Resolve);
    }

    [Fact]
    public async Task Refuses_a_host_that_resolves_to_a_private_address()
    {
        var resolver = new ScriptedResolver(Ips("10.0.0.5"));
        var connected = new List<IPEndPoint>();
        var options = new SafeHttpOptions { Resolve = resolver.Resolve, Connect = Recording(connected) };

        var error = await Assert.ThrowsAsync<BlockedAddressException>(() =>
            SafeHttpHandler.ConnectAsync(options, new DnsEndPoint("intranet.test", 443), Ct).AsTask());

        Assert.Equal("intranet.test", error.Host);
        Assert.Equal(IPAddress.Parse("10.0.0.5"), error.Address);
        Assert.Contains("10.0.0.5", error.Message, StringComparison.Ordinal);
        Assert.Empty(connected);
    }

    [Theory]
    [InlineData("127.0.0.1")]
    [InlineData("169.254.169.254")]
    [InlineData("[::1]")]
    [InlineData("[::ffff:127.0.0.1]")]
    [InlineData("[fd00:ec2::254]")]
    public async Task Refuses_an_ip_literal_without_asking_dns(string host)
    {
        var resolver = new ScriptedResolver(Ips("8.8.8.8"));
        var connected = new List<IPEndPoint>();
        var options = new SafeHttpOptions { Resolve = resolver.Resolve, Connect = Recording(connected) };

        await Assert.ThrowsAsync<BlockedAddressException>(() => SafeHttpHandler.ConnectAsync(options, new DnsEndPoint(host, 80), Ct).AsTask());

        Assert.Equal(0, resolver.Calls);
        Assert.Empty(connected);
    }

    [Fact]
    public async Task Resolves_once_and_connects_to_the_address_it_checked()
    {
        // DNS rebinding: the first answer is public, every later one points inside. Only the first
        // may ever be used.
        var resolver = new ScriptedResolver(Ips("8.8.8.8"), Ips("127.0.0.1"));
        var connected = new List<IPEndPoint>();
        var options = new SafeHttpOptions { Resolve = resolver.Resolve, Connect = Recording(connected) };

        await using var stream = await SafeHttpHandler.ConnectAsync(options, new DnsEndPoint("rebind.test", 443), Ct);

        Assert.Equal(1, resolver.Calls);
        Assert.Equal([new IPEndPoint(IPAddress.Parse("8.8.8.8"), 443)], connected);
    }

    [Fact]
    public async Task Connects_through_the_handler_to_the_checked_address_only()
    {
        await using var server = TestHttpServer.Answering(200, """{"status":"pass"}""");
        var resolver = new ScriptedResolver(Ips("8.8.8.8"), Ips("127.0.0.1"));
        var connected = new List<IPEndPoint>();
        // The "public" address is played by the local server, so no packet leaves this machine.
        var options = new SafeHttpOptions
        {
            Resolve = resolver.Resolve,
            Connect = async (endpoint, ct) =>
            {
                lock (connected)
                {
                    connected.Add(endpoint);
                }

                var client = new TcpClient();
                await client.ConnectAsync(IPAddress.Loopback, server.Port, ct);
                return client.GetStream();
            },
        };
        using var http = new HttpClient(SafeHttpHandler.Create(options));

        using var response = await http.GetAsync(server.Url(host: "rebind.test"), Ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(1, resolver.Calls);
        Assert.Equal([new IPEndPoint(IPAddress.Parse("8.8.8.8"), server.Port)], connected);
    }

    [Fact]
    public async Task Skips_the_private_answers_and_tries_the_public_ones_in_turn()
    {
        var resolver = new ScriptedResolver(Ips("127.0.0.1", "8.8.8.8", "10.0.0.1", "::ffff:1.1.1.1", "8.8.8.8"));
        var connected = new List<IPEndPoint>();
        var options = new SafeHttpOptions
        {
            Resolve = resolver.Resolve,
            Connect = (endpoint, ct) =>
            {
                connected.Add(endpoint);
                return endpoint.Address.Equals(IPAddress.Parse("8.8.8.8"))
                    ? throw new SocketException((int)SocketError.ConnectionRefused)
                    : ValueTask.FromResult<Stream>(new MemoryStream());
            },
        };

        await using var stream = await SafeHttpHandler.ConnectAsync(options, new DnsEndPoint("mixed.test", 443), Ct);

        Assert.Equal([new IPEndPoint(IPAddress.Parse("8.8.8.8"), 443), new IPEndPoint(IPAddress.Parse("1.1.1.1"), 443)], connected);
    }

    [Fact]
    public async Task Throws_the_last_connection_error_when_every_public_address_fails()
    {
        var options = new SafeHttpOptions
        {
            Resolve = new ScriptedResolver(Ips("8.8.8.8", "1.1.1.1")).Resolve,
            Connect = (_, _) => throw new SocketException((int)SocketError.ConnectionRefused),
        };

        var error = await Assert.ThrowsAsync<SocketException>(() => SafeHttpHandler.ConnectAsync(options, new DnsEndPoint("down.test", 443), Ct).AsTask());
        Assert.Equal(SocketError.ConnectionRefused, error.SocketErrorCode);
    }

    [Fact]
    public async Task Says_host_not_found_when_dns_has_no_answer()
    {
        var options = new SafeHttpOptions { Resolve = new ScriptedResolver(Ips()).Resolve, Connect = Recording([]) };

        var error = await Assert.ThrowsAsync<SocketException>(() => SafeHttpHandler.ConnectAsync(options, new DnsEndPoint("nothing.test", 443), Ct).AsTask());
        Assert.Equal(SocketError.HostNotFound, error.SocketErrorCode);
    }

    [Fact]
    public async Task Lets_private_addresses_through_only_when_told_to()
    {
        var connected = new List<IPEndPoint>();
        var options = new SafeHttpOptions { AllowPrivateAddresses = true, Connect = Recording(connected) };

        await using var stream = await SafeHttpHandler.ConnectAsync(options, new DnsEndPoint("127.0.0.1", 8080), Ct);

        Assert.Equal([new IPEndPoint(IPAddress.Loopback, 8080)], connected);
    }

    [Fact]
    public async Task Surfaces_the_refusal_through_HttpClient()
    {
        using var http = new HttpClient(SafeHttpHandler.Create(new SafeHttpOptions { Resolve = new ScriptedResolver(Ips("192.168.1.1")).Resolve }));

        var error = await Assert.ThrowsAsync<HttpRequestException>(() => http.GetAsync(new Uri("http://router.test/"), Ct));

        Assert.IsType<BlockedAddressException>(error.InnerException);
    }

    [Fact]
    public async Task Refuses_loopback_through_HttpClient_without_connecting()
    {
        await using var server = TestHttpServer.Answering(200, "{}");
        using var http = new HttpClient(SafeHttpHandler.Create(new SafeHttpOptions()));

        await Assert.ThrowsAsync<HttpRequestException>(() => http.GetAsync(server.Url(), Ct));

        Assert.Empty(server.Requests);
    }

    [Fact]
    public async Task Does_not_follow_a_redirect()
    {
        await using var server = new TestHttpServer((request, stream, ct) => request.Target == "/health"
            ? TestHttpServer.WriteAsync(stream, 302, "", null, "Location: /elsewhere\r\n", ct)
            : TestHttpServer.WriteAsync(stream, 200, """{"status":"pass"}""", ct: ct));
        using var http = new HttpClient(SafeHttpHandler.Create(new SafeHttpOptions { AllowPrivateAddresses = true }));

        using var response = await http.GetAsync(server.Url(), Ct);

        Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
        Assert.Single(server.Requests);
    }

    private static Func<IPEndPoint, CancellationToken, ValueTask<Stream>> Recording(List<IPEndPoint> connected) => (endpoint, _) =>
    {
        connected.Add(endpoint);
        return ValueTask.FromResult<Stream>(new MemoryStream());
    };
}
