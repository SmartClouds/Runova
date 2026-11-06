using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Runova.Website.Api.Email;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>
/// Stands in for api.sendgrid.com behind the email transport's HTTP client. It answers 202, or
/// whatever a test set, and keeps each request it saw with its body read out.
/// </summary>
internal sealed class FakeSendGrid
{
    private readonly ConcurrentQueue<Seen> _requests = new();
    private Func<HttpResponseMessage> _reply = () => new HttpResponseMessage(HttpStatusCode.Accepted);

    public IReadOnlyList<Seen> Requests => [.. _requests];

    /// <summary>One request as it reached SendGrid. The body is read while the request is alive.</summary>
    internal sealed record Seen(HttpMethod Method, Uri? Uri, AuthenticationHeaderValue? Authorization, string? ContentType, string Body)
    {
        public JsonElement Json => JsonDocument.Parse(Body).RootElement;
    }

    /// <summary>A reply with this status and SendGrid's error shape around <paramref name="message"/>.</summary>
    public void Answers(HttpStatusCode status, string message = "something went wrong") => _reply = () => new HttpResponseMessage(status)
    {
        Content = new StringContent(
            JsonSerializer.Serialize(new { errors = new[] { new { message, field = (string?)null, help = (string?)null } } }),
            MediaTypeHeaderValue.Parse("application/json")),
    };

    /// <summary>An <see cref="HttpMessageHandler"/> that answers for this fake, for a hand-made client.</summary>
    public HttpMessageHandler Handler() => new FakeHandler(this);

    /// <summary>Puts this fake under the email transport's HTTP client, in place of the network.</summary>
    public void Register(IServiceCollection services) =>
        services.AddHttpClient<IEmailTransport, SendGridEmailTransport>().ConfigurePrimaryHttpMessageHandler(Handler);

    // The client factory disposes its handlers when it rotates them, so each gets a new one.
    private sealed class FakeHandler(FakeSendGrid sendGrid) : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken);
            sendGrid._requests.Enqueue(new Seen(
                request.Method,
                request.RequestUri,
                request.Headers.Authorization,
                request.Content?.Headers.ContentType?.MediaType,
                body));
            return sendGrid._reply();
        }
    }
}
