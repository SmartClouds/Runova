using System.Net;
using System.Net.Sockets;
using System.Text;
using Microsoft.Extensions.Time.Testing;
using Runova.Monitoring.Core.Health;
using Runova.Monitoring.Core.Net;
using Runova.Monitoring.Tests.Health;

namespace Runova.Monitoring.Tests.Net;

/// <summary>
/// The prober end to end against a local server. The handler is told to allow private addresses,
/// since the server is on 127.0.0.1; the refusals have their own tests with the guard on.
/// </summary>
public sealed class HealthProberTests : IDisposable
{
    private const string Key = "rnh_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
    private const string Passing = """{"status":"pass","checks":{"db":[{"status":"pass"}]}}""";

    private readonly HttpClient _http = new(SafeHttpHandler.Create(new SafeHttpOptions { AllowPrivateAddresses = true }));

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public void Dispose() => _http.Dispose();

    private Task<HealthReport> Probe(Uri url, string? mode = "bearer", string? secret = Key, int timeoutSec = 10, bool insecure = true, TimeProvider? clock = null, HttpClient? http = null) =>
        new HealthProber(http ?? _http).ProbeAsync(new ProbeRequest(url, mode, secret, timeoutSec, insecure), clock ?? TimeProvider.System, Ct);

    private static HttpClient Guarded(HostResolver? resolve = null) =>
        new(SafeHttpHandler.Create(resolve is null ? new SafeHttpOptions() : new SafeHttpOptions { Resolve = resolve }));

    [Fact]
    public async Task Reads_a_passing_report_and_sends_the_key_and_accept_headers()
    {
        await using var server = TestHttpServer.Answering(200, Passing);
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 11, 6, 12, 0, 0, TimeSpan.Zero));

        var report = await Probe(server.Url(), clock: clock);

        Assert.Equal(HealthProbeState.Pass, report.State);
        Assert.Equal(200, report.HttpStatus);
        Assert.NotNull(report.LatencyMs);
        Assert.Equal(clock.GetUtcNow(), report.CheckedAt);
        Assert.Equal("db", Assert.Single(report.Services).Key);
        var request = Assert.Single(server.Requests);
        Assert.Equal("GET", request.Method);
        Assert.Equal("/health", request.Target);
        Assert.Equal("Bearer " + Key, request.Headers["Authorization"]);
        Assert.Equal("application/health+json, application/json", request.Headers["Accept"]);
        Assert.Equal("Runova-Health/1", request.Headers["User-Agent"]);
        Assert.False(request.Headers.ContainsKey("Cookie"));
    }

    [Fact]
    public async Task Sends_basic_credentials_as_base64_of_user_and_password()
    {
        await using var server = TestHttpServer.Answering(200, Passing);

        var report = await Probe(server.Url(), "basic", "monitor:s3cret-pass");

        Assert.Equal(HealthProbeState.Pass, report.State);
        Assert.Equal("Basic " + Convert.ToBase64String(Encoding.UTF8.GetBytes("monitor:s3cret-pass")), Assert.Single(server.Requests).Headers["Authorization"]);
    }

    [Fact]
    public async Task Sends_no_authorization_when_the_monitor_has_none()
    {
        await using var server = TestHttpServer.Answering(200, Passing);

        var report = await Probe(server.Url(), null, null);

        Assert.Equal(HealthProbeState.Pass, report.State);
        Assert.False(Assert.Single(server.Requests).Headers.ContainsKey("Authorization"));
    }

    [Fact]
    public async Task Reads_a_failing_report()
    {
        await using var server = TestHttpServer.Answering(503, """{"status":"fail","checks":{"db":[{"status":"fail","output":"connect ECONNREFUSED"}]}}""");

        var report = await Probe(server.Url());

        Assert.Equal(HealthProbeState.Fail, report.State);
        Assert.Equal(503, report.HttpStatus);
        Assert.Equal("connect ECONNREFUSED", report.Services[0].Error!.Message);
    }

    [Fact]
    public async Task Reports_a_rejected_key_as_unauthorized()
    {
        await using var server = TestHttpServer.Answering(401, "nope", "text/plain");

        var report = await Probe(server.Url());

        Assert.Equal(HealthProbeState.Unauthorized, report.State);
        Assert.Equal(401, report.HttpStatus);
        Assert.Null(report.Raw);
    }

    [Fact]
    public async Task Does_not_follow_a_redirect_so_the_key_never_goes_elsewhere()
    {
        await using var server = new TestHttpServer((request, stream, ct) => request.Target == "/health"
            ? TestHttpServer.WriteAsync(stream, 302, "", null, "Location: /elsewhere\r\n", ct)
            : TestHttpServer.WriteAsync(stream, 200, Passing, ct: ct));

        var report = await Probe(server.Url());

        Assert.Equal(HealthProbeState.Invalid, report.State);
        Assert.Equal(302, report.HttpStatus);
        Assert.Contains("redirect", report.Problem, StringComparison.Ordinal);
        Assert.Single(server.Requests);
    }

    [Fact]
    public async Task Stops_at_a_declared_body_over_512_KB()
    {
        await using var server = TestHttpServer.Answering(200, new string('x', HealthProber.MaxBodyBytes + 1), "text/plain");

        var report = await Probe(server.Url());

        Assert.Equal(HealthProbeState.Invalid, report.State);
        Assert.Equal("The response is larger than 512 KB, so Runova stopped reading it.", report.Problem);
        Assert.Null(report.HttpStatus);
    }

    [Fact]
    public async Task Stops_reading_an_undeclared_body_once_it_passes_512_KB()
    {
        await using var server = new TestHttpServer(async (_, stream, ct) =>
        {
            await stream.WriteAsync("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n"u8.ToArray(), ct);
            var chunk = new byte[64 * 1024];
            Array.Fill(chunk, (byte)'x');
            for (var sent = 0; sent <= HealthProber.MaxBodyBytes; sent += chunk.Length)
            {
                await stream.WriteAsync(chunk, ct);
            }
        });

        var report = await Probe(server.Url());

        Assert.Equal(HealthProbeState.Invalid, report.State);
        Assert.Equal("The response is larger than 512 KB, so Runova stopped reading it.", report.Problem);
    }

    [Fact]
    public async Task Reads_a_body_of_exactly_512_KB()
    {
        await using var server = TestHttpServer.Answering(200, new string(' ', HealthProber.MaxBodyBytes - Passing.Length) + Passing);

        var report = await Probe(server.Url());

        Assert.Equal(HealthProbeState.Pass, report.State);
    }

    [Fact]
    public async Task Gives_up_after_the_timeout()
    {
        await using var server = new TestHttpServer((_, _, ct) => Task.Delay(Timeout.Infinite, ct));
        var clock = new FakeTimeProvider();

        var probe = Probe(server.Url(), timeoutSec: 7, clock: clock);
        await server.FirstRequest.WaitAsync(TimeSpan.FromSeconds(10), Ct);
        clock.Advance(TimeSpan.FromSeconds(7));
        var report = await probe.WaitAsync(TimeSpan.FromSeconds(10), Ct);

        Assert.Equal(HealthProbeState.Unreachable, report.State);
        Assert.Equal("Timed out after 7 s.", report.Problem);
    }

    [Fact]
    public async Task Keeps_the_timeout_inside_the_allowed_range()
    {
        await using var server = new TestHttpServer((_, _, ct) => Task.Delay(Timeout.Infinite, ct));
        var clock = new FakeTimeProvider();

        var probe = Probe(server.Url(), timeoutSec: 0, clock: clock);
        await server.FirstRequest.WaitAsync(TimeSpan.FromSeconds(10), Ct);
        clock.Advance(TimeSpan.FromSeconds(HealthIntervals.TimeoutMinSec));
        var report = await probe.WaitAsync(TimeSpan.FromSeconds(10), Ct);

        Assert.Equal("Timed out after 2 s.", report.Problem);
    }

    [Fact]
    public async Task Throws_when_the_caller_cancels()
    {
        await using var server = new TestHttpServer((_, _, ct) => Task.Delay(Timeout.Infinite, ct));
        using var cancel = CancellationTokenSource.CreateLinkedTokenSource(Ct);

        var probe = new HealthProber(_http).ProbeAsync(new ProbeRequest(server.Url(), null, null, 10, true), TimeProvider.System, cancel.Token);
        await server.FirstRequest.WaitAsync(TimeSpan.FromSeconds(10), Ct);
        await cancel.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => probe);
    }

    [Fact]
    public async Task Refuses_plain_http_unless_the_monitor_allows_it()
    {
        await using var server = TestHttpServer.Answering(200, Passing);

        var report = await Probe(server.Url(), insecure: false);

        Assert.Equal(HealthProbeState.Invalid, report.State);
        Assert.StartsWith("Plain http:// is not encrypted", report.Problem, StringComparison.Ordinal);
        Assert.Empty(server.Requests);
    }

    [Theory]
    [InlineData("ftp://example.com/health", "The address must start with https://.")]
    [InlineData("file:///etc/passwd", "The address must start with https://.")]
    [InlineData("/health", "The address is not a valid URL.")]
    public async Task Refuses_an_address_it_can_not_probe(string url, string problem)
    {
        var report = await Probe(new Uri(url, UriKind.RelativeOrAbsolute));

        Assert.Equal(HealthProbeState.Invalid, report.State);
        Assert.Equal(problem, report.Problem);
    }

    [Fact]
    public async Task Refuses_loopback_when_the_guard_is_on()
    {
        await using var server = TestHttpServer.Answering(200, Passing);
        using var http = Guarded();

        var report = await Probe(server.Url(), http: http);

        Assert.Equal(HealthProbeState.Invalid, report.State);
        Assert.Equal("127.0.0.1 is not a public address (it is a loopback address). Runova only checks public addresses.", report.Problem);
        Assert.Empty(server.Requests);
    }

    [Theory]
    [InlineData("https://[::1]:8443/health", "::1 is not a public address (it is a loopback address). Runova only checks public addresses.")]
    [InlineData("https://[::ffff:10.0.0.1]/health", "::ffff:10.0.0.1 is not a public address (it is an IPv4-mapped form of 10.0.0.1, which is a private address in 10.0.0.0/8). Runova only checks public addresses.")]
    [InlineData("https://169.254.169.254/latest/meta-data/", "169.254.169.254 is not a public address (it is the cloud metadata address). Runova only checks public addresses.")]
    [InlineData("http://0x7f000001/health", "127.0.0.1 is not a public address (it is a loopback address). Runova only checks public addresses.")]
    public async Task Refuses_an_ip_literal_that_is_not_public(string url, string problem)
    {
        using var http = Guarded((_, _) => throw new InvalidOperationException("An IP literal must not be resolved."));

        var report = await Probe(new Uri(url), http: http);

        Assert.Equal(HealthProbeState.Invalid, report.State);
        Assert.Equal(problem, report.Problem);
    }

    [Fact]
    public async Task Refuses_a_name_that_resolves_to_the_metadata_service()
    {
        using var http = Guarded((_, _) => Task.FromResult(new[] { IPAddress.Parse("169.254.169.254") }));

        var report = await Probe(new Uri("https://metadata.test/latest/meta-data/"), http: http);

        Assert.Equal(HealthProbeState.Invalid, report.State);
        Assert.Equal(
            "metadata.test resolves to 169.254.169.254, which is not a public address (it is the cloud metadata address). Runova only checks public addresses.",
            report.Problem);
    }

    [Fact]
    public async Task Says_when_the_host_name_does_not_resolve()
    {
        using var http = Guarded((_, _) => throw new SocketException((int)SocketError.HostNotFound));

        var report = await Probe(new Uri("https://missing.test/health"), http: http);

        Assert.Equal(HealthProbeState.Unreachable, report.State);
        Assert.Equal("The host name of missing.test could not be resolved. Check the address.", report.Problem);
    }

    [Fact]
    public async Task Says_when_the_connection_is_refused()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();

        var report = await Probe(new Uri($"http://127.0.0.1:{port}/health"));

        Assert.Equal(HealthProbeState.Unreachable, report.State);
        Assert.Equal($"The connection to 127.0.0.1:{port} was refused. Nothing is listening there, or a firewall blocks it.", report.Problem);
    }

    [Fact]
    public async Task Says_when_connecting_takes_too_long()
    {
        var options = new SafeHttpOptions
        {
            Resolve = (_, _) => Task.FromResult(new[] { IPAddress.Parse("8.8.8.8") }),
            ConnectTimeout = TimeSpan.FromMilliseconds(100),
            Connect = async (_, ct) =>
            {
                await Task.Delay(Timeout.Infinite, ct);
                throw new InvalidOperationException("Not reached.");
            },
        };
        using var http = new HttpClient(SafeHttpHandler.Create(options));

        var report = await Probe(new Uri("https://slow.test/health"), http: http);

        Assert.Equal(HealthProbeState.Unreachable, report.State);
        Assert.Equal("The connection to slow.test timed out.", report.Problem);
    }

    [Fact]
    public async Task Says_when_the_connection_drops_before_the_answer_is_complete()
    {
        await using var server = new TestHttpServer(async (_, stream, ct) =>
            await stream.WriteAsync("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{\"status\""u8.ToArray(), ct));

        var report = await Probe(server.Url());

        Assert.Equal(HealthProbeState.Unreachable, report.State);
        Assert.Equal($"The connection to 127.0.0.1:{server.Port} was reset before it answered.", report.Problem);
    }

    [Fact]
    public async Task Says_when_tls_fails()
    {
        // Plain HTTP where TLS was expected: the handshake can not succeed.
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var answer = Task.Run(async () =>
        {
            using var client = await listener.AcceptTcpClientAsync(Ct);
            await client.GetStream().WriteAsync("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"u8.ToArray(), Ct);
        }, Ct);

        var report = await Probe(new Uri($"https://127.0.0.1:{port}/health"));
        await answer;
        listener.Stop();

        Assert.Equal(HealthProbeState.Unreachable, report.State);
        Assert.StartsWith($"Runova does not trust the TLS certificate of 127.0.0.1:{port}", report.Problem, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Says_when_the_answer_is_not_http()
    {
        await using var server = new TestHttpServer(async (_, stream, ct) => await stream.WriteAsync("SSH-2.0-OpenSSH_9.6\r\n\r\n"u8.ToArray(), ct));

        var report = await Probe(server.Url());

        Assert.Equal(HealthProbeState.Invalid, report.State);
        Assert.Equal($"127.0.0.1:{server.Port} did not answer with valid HTTP.", report.Problem);
    }

    [Fact]
    public async Task Says_when_the_response_headers_are_too_large()
    {
        var header = "X-Padding: " + new string('a', 100 * 1024) + "\r\n";
        await using var server = TestHttpServer.Answering(200, Passing, headers: header);

        var report = await Probe(server.Url());

        Assert.Equal(HealthProbeState.Invalid, report.State);
        Assert.Equal($"The response headers from 127.0.0.1:{server.Port} are larger than 64 KB.", report.Problem);
    }

    [Theory]
    [InlineData("bearer", "has a\nnewline", "The key has characters an HTTP header can not carry, such as spaces or line breaks.")]
    [InlineData("bearer", "", "This monitor uses bearer authentication but has no key.")]
    [InlineData("basic", null, "This monitor uses basic authentication but has no key.")]
    [InlineData("basic", "no-colon-here", "The credentials for basic authentication must be user:password.")]
    [InlineData("digest", "whatever-it-is", "The monitor's authentication must be bearer, basic or none.")]
    public async Task Refuses_credentials_it_can_not_send(string mode, string? secret, string problem)
    {
        await using var server = TestHttpServer.Answering(200, Passing);

        var report = await Probe(server.Url(), mode, secret);

        Assert.Equal(HealthProbeState.Invalid, report.State);
        Assert.Equal(problem, report.Problem);
        Assert.Empty(server.Requests);
    }

    [Fact]
    public async Task Accepts_the_auth_mode_in_any_case()
    {
        await using var server = TestHttpServer.Answering(200, Passing);

        var report = await Probe(server.Url(), "Bearer");

        Assert.Equal(HealthProbeState.Pass, report.State);
        Assert.Equal("Bearer " + Key, Assert.Single(server.Requests).Headers["Authorization"]);
    }

    [Theory]
    [InlineData("bearer", Key)]
    [InlineData("basic", "monitor:hunter2hunter2")]
    public async Task Never_lets_an_echoed_secret_into_the_report(string mode, string secret)
    {
        // The endpoint crashes and prints the request headers, a classic way for a key to leak.
        await using var server = new TestHttpServer((request, stream, ct) =>
        {
            var password = secret[(secret.IndexOf(':', StringComparison.Ordinal) + 1)..];
            var body = $"crash! auth was {request.Headers["Authorization"]}, password {password}, secret {secret}";
            return TestHttpServer.WriteAsync(stream, 500, body, "text/plain", ct: ct);
        });

        var report = await Probe(server.Url(), mode, secret);

        Assert.Equal(HealthProbeState.Fail, report.State);
        var all = FixtureTests.Everything(report);
        Assert.DoesNotContain(secret, all, StringComparison.Ordinal);
        Assert.DoesNotContain("hunter2hunter2", all, StringComparison.Ordinal);
        Assert.DoesNotContain(Convert.ToBase64String(Encoding.UTF8.GetBytes(secret)), all, StringComparison.Ordinal);
        Assert.Contains("crash!", report.Raw, StringComparison.Ordinal);
    }
}
