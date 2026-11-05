using System.Net;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;

namespace Runova.Website.Api.Accounts;

/// <summary>The forms a captcha token can be for. The widget names one, and a token passes only on its own form.</summary>
public static class CaptchaActions
{
    public const string Register = "register";
    public const string SignIn = "sign-in";
    public const string PasswordReset = "password-reset";
    public const string VerificationEmail = "verification-email";

    /// <summary>The proof an Admin gives on the settings page that a site key and secret work together.</summary>
    public const string SettingsCheck = "settings-check";
}

/// <summary><c>Captcha__*</c>. Only tests and the e2e stack change the verify URL.</summary>
public sealed class CaptchaOptions
{
    public const string Section = "Captcha";
    public const string DefaultVerifyUrl = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

    public string VerifyUrl { get; set; } = DefaultVerifyUrl;
}

/// <summary>
/// Asks Cloudflare whether a Turnstile token is real. Anything but a clear yes is a no: an error,
/// a timeout or an answer it can not read fails closed, so an outage at Cloudflare blocks the
/// protected forms rather than opening them.
/// </summary>
internal sealed partial class TurnstileVerifier(HttpClient http, IOptions<CaptchaOptions> options, ILogger<TurnstileVerifier> logger)
{
    /// <summary>Cloudflare's own limit on a token's length.</summary>
    public const int MaxTokenLength = 2048;

    public static void Configure(HttpClient client) => client.Timeout = TimeSpan.FromSeconds(10);

    public async Task<bool> VerifyAsync(string secret, string? token, string action, IPAddress? remoteIp, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(token) || token.Length > MaxTokenLength || string.IsNullOrEmpty(secret))
        {
            return false;
        }

        var form = new Dictionary<string, string> { ["secret"] = secret, ["response"] = token };
        if (remoteIp is not null)
        {
            form["remoteip"] = remoteIp.ToString();
        }

        try
        {
            using var content = new FormUrlEncodedContent(form);
            using var response = await http.PostAsync(new Uri(options.Value.VerifyUrl), content, cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                LogUnavailable(logger, (int)response.StatusCode);
                return false;
            }

            var answer = await response.Content.ReadFromJsonAsync<SiteVerifyAnswer>(cancellationToken);
            if (answer is not { Success: true })
            {
                return false;
            }

            // A widget on this site always names its form. A token for another form is refused;
            // Cloudflare's test keys answer with no action at all, which is let through.
            return string.IsNullOrEmpty(answer.Action) || answer.Action == action;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or System.Text.Json.JsonException or NotSupportedException)
        {
            if (cancellationToken.IsCancellationRequested)
            {
                throw;
            }

            LogUnreachable(logger, e);
            return false;
        }
    }

    private sealed record SiteVerifyAnswer(
        [property: JsonPropertyName("success")] bool Success,
        [property: JsonPropertyName("action")] string? Action);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Turnstile siteverify answered {Status}; the captcha check failed closed")]
    private static partial void LogUnavailable(ILogger logger, int status);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Turnstile siteverify could not be reached; the captcha check failed closed")]
    private static partial void LogUnreachable(ILogger logger, Exception exception);
}
