using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Runova.Website.Api.Email;

/// <summary>
/// Sends through SendGrid's v3 Mail Send API. Tracking is off, since click tracking would rewrite
/// the one-time links in verify and reset emails. With no API key it refuses, so messages stay queued.
/// </summary>
internal sealed partial class SendGridEmailTransport(HttpClient http, IOptions<EmailOptions> options, ILogger<SendGridEmailTransport> logger) : IEmailTransport
{
    public const string MailSendPath = "v3/mail/send";

    private static readonly JsonSerializerOptions _json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    public static void Configure(HttpClient http)
    {
        http.BaseAddress = new Uri("https://api.sendgrid.com/");
        http.Timeout = TimeSpan.FromSeconds(30);
    }

    public async Task SendAsync(OutgoingEmail email, CancellationToken cancellationToken)
    {
        var settings = options.Value;
        if (string.IsNullOrWhiteSpace(settings.SendGridApiKey))
        {
            LogNotConfigured(logger);
            throw new InvalidOperationException("Email is not configured. Set Email__SendGridApiKey.");
        }

        List<Content> content = [new("text/plain", email.TextBody)];
        if (email.HtmlBody is not null)
        {
            content.Add(new("text/html", email.HtmlBody));
        }

        var body = new MailSend(
            [new Personalization([new Address(email.To, null)])],
            new Address(settings.From, settings.FromName),
            email.Subject,
            content,
            [email.Kind],
            new TrackingSettings(new ClickTracking(false, false), new Switch(false)),
            new MailSettings(new Switch(settings.SandboxMode)));

        using var request = new HttpRequestMessage(HttpMethod.Post, MailSendPath)
        {
            Content = JsonContent.Create(body, options: _json),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", settings.SendGridApiKey);

        using var response = await http.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var reason = await ReasonAsync(response, cancellationToken);
            throw new HttpRequestException($"SendGrid answered {(int)response.StatusCode}: {reason}", null, response.StatusCode);
        }
    }

    /// <summary>What SendGrid's <c>errors</c> list says, or the start of whatever else it sent.</summary>
    private static async Task<string> ReasonAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        var text = await response.Content.ReadAsStringAsync(cancellationToken);
        try
        {
            using var json = JsonDocument.Parse(text);
            if (json.RootElement.TryGetProperty("errors", out var errors) && errors.ValueKind == JsonValueKind.Array)
            {
                var messages = errors.EnumerateArray()
                    .Select(e => e.TryGetProperty("message", out var m) ? m.GetString() : null)
                    .OfType<string>()
                    .ToList();
                if (messages.Count > 0)
                {
                    return string.Join("; ", messages);
                }
            }
        }
        catch (JsonException)
        {
            // Not JSON, so the raw text below says what there is to say.
        }

        return text.Length <= 200 ? text : text[..200];
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "An email is waiting, but Email__SendGridApiKey is not set, so it stays queued")]
    private static partial void LogNotConfigured(ILogger logger);

    // The Mail Send request, in SendGrid's snake_case names.
    private sealed record MailSend(
        IReadOnlyList<Personalization> Personalizations,
        Address From,
        string Subject,
        IReadOnlyList<Content> Content,
        IReadOnlyList<string> Categories,
        TrackingSettings TrackingSettings,
        MailSettings MailSettings);

    private sealed record Personalization(IReadOnlyList<Address> To);

    private sealed record Address(string Email, string? Name);

    private sealed record Content(string Type, string Value);

    private sealed record TrackingSettings(ClickTracking ClickTracking, Switch OpenTracking);

    private sealed record ClickTracking(bool Enable, bool EnableText);

    private sealed record MailSettings(Switch SandboxMode);

    private sealed record Switch(bool Enable);
}
