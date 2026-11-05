using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Runova.Website.Api.Accounts;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>
/// Stands in for Cloudflare's siteverify behind the Turnstile verifier's HTTP client. A token
/// passes when a test issued it for the secret it is checked with; any other answers the way
/// Cloudflare does. Each check it saw is kept with its form fields.
/// </summary>
internal sealed class FakeTurnstile
{
    public const string SiteKey = "0x4AAAAAAAtestsitekey";
    public const string Secret = "0x4AAAAAAAtestsecret";

    private readonly ConcurrentDictionary<string, (string Secret, string Action)> _tokens = new();
    private readonly ConcurrentQueue<IReadOnlyDictionary<string, string>> _checks = new();

    /// <summary>When set, every check gets this status and no JSON, as when Cloudflare is down.</summary>
    public HttpStatusCode? Failing { get; set; }

    /// <summary>When set, every check throws, as a timeout or a refused connection does.</summary>
    public bool Unreachable { get; set; }

    public IReadOnlyList<IReadOnlyDictionary<string, string>> Checks => [.. _checks];

    /// <summary>A token the widget would hand the page for <paramref name="action"/>, good once.</summary>
    public string Issue(string action, string secret = Secret)
    {
        var token = "tok-" + Guid.NewGuid().ToString("N");
        _tokens[token] = (secret, action);
        return token;
    }

    public HttpMessageHandler Handler() => new FakeHandler(this);

    /// <summary>Puts this fake under the verifier's HTTP client, in place of the network.</summary>
    public void Register(IServiceCollection services) =>
        services.AddHttpClient<TurnstileVerifier>().ConfigurePrimaryHttpMessageHandler(Handler);

    private sealed class FakeHandler(FakeTurnstile turnstile) : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var form = (await request.Content!.ReadAsStringAsync(cancellationToken))
                .Split('&', StringSplitOptions.RemoveEmptyEntries)
                .Select(pair => pair.Split('=', 2))
                .ToDictionary(p => Uri.UnescapeDataString(p[0].Replace('+', ' ')), p => Uri.UnescapeDataString(p[1].Replace('+', ' ')));
            turnstile._checks.Enqueue(form);

            if (turnstile.Unreachable)
            {
                throw new HttpRequestException("No route to challenges.cloudflare.com");
            }

            if (turnstile.Failing is { } status)
            {
                return new HttpResponseMessage(status);
            }

            object body;
            var token = form.GetValueOrDefault("response") ?? "";
            var secret = form.GetValueOrDefault("secret") ?? "";
            if (!secret.StartsWith("0x", StringComparison.Ordinal))
            {
                body = new { success = false, error_codes = new[] { "invalid-input-secret" } };
            }
            else if (turnstile._tokens.TryRemove(token, out var issued) && issued.Secret == secret)
            {
                body = new { success = true, error_codes = Array.Empty<string>(), hostname = "runovahq.com", action = issued.Action };
            }
            else
            {
                body = new { success = false, error_codes = new[] { "invalid-input-response" } };
            }

            var json = JsonSerializer.Serialize(body).Replace("error_codes", "error-codes", StringComparison.Ordinal);
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
        }
    }
}
