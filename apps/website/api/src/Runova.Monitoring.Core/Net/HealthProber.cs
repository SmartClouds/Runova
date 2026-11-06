using System.Globalization;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Text;
using Runova.Monitoring.Core.Health;

namespace Runova.Monitoring.Core.Net;

/// <summary>One check of a health endpoint.</summary>
/// <param name="AuthMode">"bearer", "basic" or null for none.</param>
/// <param name="Secret">The bearer key, or "user:password" for basic.</param>
/// <param name="TimeoutSec">Kept inside <see cref="HealthIntervals.TimeoutMinSec"/> to <see cref="HealthIntervals.TimeoutMaxSec"/>.</param>
/// <param name="AllowInsecure">Lets plain http:// through.</param>
public sealed record ProbeRequest(Uri Url, string? AuthMode, string? Secret, int TimeoutSec, bool AllowInsecure);

/// <summary>
/// Probes a health endpoint the way the desktop app does (<c>main/health/probe.ts</c>): the key goes
/// only to the address the user saved, redirects are never followed, plain http only when the
/// monitor allows it, and the body is read up to 512 KB. Every report comes from
/// <see cref="HealthParser"/>, so every string in it is redacted.
/// </summary>
/// <param name="client">An <see cref="HttpClient"/> built on <see cref="SafeHttpHandler"/>.</param>
public sealed class HealthProber(HttpClient client)
{
    public const int MaxBodyBytes = 512 * 1024;

    private const string TooLarge = "The response is larger than 512 KB, so Runova stopped reading it.";
    private const string UserAgent = "Runova-Health/1";

    /// <summary>Probes once. Cancelling <paramref name="ct"/> throws; every other failure is a report.</summary>
    public async Task<HealthReport> ProbeAsync(ProbeRequest request, TimeProvider clock, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(clock);
        var checkedAt = clock.GetUtcNow();
        var secrets = KnownSecrets(request);
        HealthReport Fail(string problem, HealthProbeState state = HealthProbeState.Unreachable) =>
            HealthParser.ProbeFailure(HealthRedactor.Redact(problem, secrets), checkedAt, state);

        var url = request.Url;
        if (url is null || !url.IsAbsoluteUri)
        {
            return Fail("The address is not a valid URL.", HealthProbeState.Invalid);
        }

        if (url.Scheme != Uri.UriSchemeHttps && url.Scheme != Uri.UriSchemeHttp)
        {
            return Fail("The address must start with https://.", HealthProbeState.Invalid);
        }

        if (url.Scheme == Uri.UriSchemeHttp && !request.AllowInsecure)
        {
            return Fail(
                "Plain http:// is not encrypted, so Runova only uses it when the monitor allows insecure HTTP. Use https://, or allow insecure HTTP for this monitor.",
                HealthProbeState.Invalid);
        }

        var authorization = Authorization(request, out var authProblem);
        if (authProblem is not null)
        {
            return Fail(authProblem, HealthProbeState.Invalid);
        }

        var timeoutSec = HealthIntervals.NormalizeTimeout(request.TimeoutSec);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(timeoutSec), clock);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, timeout.Token);
        var host = url.Authority;
        var started = clock.GetTimestamp();
        try
        {
            using var message = new HttpRequestMessage(HttpMethod.Get, url);
            message.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue(HealthProtocol.MediaType));
            message.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            message.Headers.UserAgent.ParseAdd(UserAgent);
            message.Headers.CacheControl = new CacheControlHeaderValue { NoCache = true };
            message.Headers.Authorization = authorization;

            using var response = await client.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, linked.Token).ConfigureAwait(false);
            var status = (int)response.StatusCode;
            // The parser reads no body for these, so neither does the prober.
            var skipBody = status is 401 or 403 or (>= 300 and < 400);
            var body = skipBody ? "" : await ReadCappedAsync(response.Content, linked.Token).ConfigureAwait(false);
            if (body is null)
            {
                return Fail(TooLarge, HealthProbeState.Invalid);
            }

            return HealthParser.Parse(new HealthResponseInput(
                status,
                response.Content.Headers.ContentType?.ToString(),
                body,
                (int)Math.Round(clock.GetElapsedTime(started).TotalMilliseconds),
                checkedAt,
                secrets));
        }
        catch (Exception error) when (!ct.IsCancellationRequested && error is not OutOfMemoryException)
        {
            var (problem, state) = Describe(error, host, timeout.IsCancellationRequested, timeoutSec);
            return Fail(problem, state);
        }
    }

    /// <summary>The secret, and for basic the password and the header value too, so an echo of any is masked.</summary>
    private static string[] KnownSecrets(ProbeRequest request)
    {
        if (string.IsNullOrEmpty(request.Secret))
        {
            return [];
        }

        if (!string.Equals(request.AuthMode, "basic", StringComparison.OrdinalIgnoreCase))
        {
            return [request.Secret];
        }

        var colon = request.Secret.IndexOf(':', StringComparison.Ordinal);
        var password = colon < 0 ? request.Secret : request.Secret[(colon + 1)..];
        return [request.Secret, password, Convert.ToBase64String(Encoding.UTF8.GetBytes(request.Secret))];
    }

    private static AuthenticationHeaderValue? Authorization(ProbeRequest request, out string? problem)
    {
        problem = null;
        if (request.AuthMode is null)
        {
            return null;
        }

        var mode = request.AuthMode.ToLowerInvariant();
        if (mode is not ("bearer" or "basic"))
        {
            problem = "The monitor's authentication must be bearer, basic or none.";
            return null;
        }

        var secret = request.Secret;
        if (string.IsNullOrEmpty(secret))
        {
            problem = "This monitor uses " + mode + " authentication but has no key.";
            return null;
        }

        if (mode == "basic")
        {
            if (!secret.Contains(':', StringComparison.Ordinal))
            {
                problem = "The credentials for basic authentication must be user:password.";
                return null;
            }

            return new AuthenticationHeaderValue("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes(secret)));
        }

        if (!secret.All(c => c is >= '!' and <= '~'))
        {
            problem = "The key has characters an HTTP header can not carry, such as spaces or line breaks.";
            return null;
        }

        return new AuthenticationHeaderValue("Bearer", secret);
    }

    /// <summary>The body as UTF-8, or null when it is over <see cref="MaxBodyBytes"/>.</summary>
    private static async Task<string?> ReadCappedAsync(HttpContent content, CancellationToken ct)
    {
        if (content.Headers.ContentLength is > MaxBodyBytes)
        {
            return null;
        }

        var stream = await content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        await using (stream.ConfigureAwait(false))
        {
            using var buffer = new MemoryStream();
            var chunk = new byte[16 * 1024];
            int read;
            while ((read = await stream.ReadAsync(chunk, ct).ConfigureAwait(false)) > 0)
            {
                if (buffer.Length + read > MaxBodyBytes)
                {
                    return null;
                }

                buffer.Write(chunk, 0, read);
            }

            return Encoding.UTF8.GetString(buffer.GetBuffer(), 0, (int)buffer.Length);
        }
    }

    /// <summary>A plain sentence for a probe that got no answer, in the desktop prober's words where they fit.</summary>
    private static (string Problem, HealthProbeState State) Describe(Exception error, string host, bool timedOut, int timeoutSec)
    {
        var chain = Chain(error);
        if (chain.OfType<BlockedAddressException>().FirstOrDefault() is { } blocked)
        {
            return (blocked.Message, HealthProbeState.Invalid);
        }

        if (timedOut)
        {
            return (string.Create(CultureInfo.InvariantCulture, $"Timed out after {timeoutSec} s."), HealthProbeState.Unreachable);
        }

        var requestError = chain.OfType<HttpRequestException>().FirstOrDefault()?.HttpRequestError;
        if (requestError == HttpRequestError.SecureConnectionError || chain.OfType<AuthenticationException>().Any())
        {
            return ($"Runova does not trust the TLS certificate of {host}, or could not agree on TLS with it. The certificate may be self-signed, expired or for another name.", HealthProbeState.Unreachable);
        }

        if (requestError == HttpRequestError.ConfigurationLimitExceeded)
        {
            return ($"The response headers from {host} are larger than {SafeHttpHandler.MaxResponseHeadersKb} KB.", HealthProbeState.Invalid);
        }

        if (requestError == HttpRequestError.InvalidResponse)
        {
            return ($"{host} did not answer with valid HTTP.", HealthProbeState.Invalid);
        }

        var socket = chain.OfType<SocketException>().FirstOrDefault()?.SocketErrorCode;
        if (socket == SocketError.ConnectionRefused)
        {
            return ($"The connection to {host} was refused. Nothing is listening there, or a firewall blocks it.", HealthProbeState.Unreachable);
        }

        if (requestError == HttpRequestError.NameResolutionError || socket is SocketError.HostNotFound or SocketError.TryAgain or SocketError.NoData)
        {
            return ($"The host name of {host} could not be resolved. Check the address.", HealthProbeState.Unreachable);
        }

        if (socket is SocketError.ConnectionReset or SocketError.ConnectionAborted or SocketError.Shutdown
            || requestError == HttpRequestError.ResponseEnded)
        {
            return ($"The connection to {host} was reset before it answered.", HealthProbeState.Unreachable);
        }

        if (socket == SocketError.TimedOut || chain.Any(link => link is TimeoutException or OperationCanceledException))
        {
            return ($"The connection to {host} timed out.", HealthProbeState.Unreachable);
        }

        if (chain.OfType<IOException>().Any())
        {
            return ($"The connection to {host} was reset before it answered.", HealthProbeState.Unreachable);
        }

        var detail = socket?.ToString() ?? requestError?.ToString() ?? error.GetType().Name;
        return ($"Could not reach {host} ({detail}).", HealthProbeState.Unreachable);
    }

    private static List<Exception> Chain(Exception error)
    {
        var chain = new List<Exception>();
        var pending = new Queue<Exception>([error]);
        while (pending.Count > 0 && chain.Count < 16)
        {
            var current = pending.Dequeue();
            chain.Add(current);
            if (current is AggregateException aggregate)
            {
                foreach (var inner in aggregate.InnerExceptions)
                {
                    pending.Enqueue(inner);
                }
            }
            else if (current.InnerException is { } inner)
            {
                pending.Enqueue(inner);
            }
        }

        return chain;
    }
}
