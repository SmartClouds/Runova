using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Hangfire;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Runova.Website.Data;
using Runova.Website.Data.Dependencies;

namespace Runova.Website.Api.Telegram;

/// <summary>
/// The RunovaHQ bot, from <c>Telegram:*</c> (E51). Without a token the bot is off: nothing is sent
/// and the account page says Telegram is not available.
/// </summary>
internal sealed class TelegramOptions
{
    public string? BotToken { get; set; }

    /// <summary>The bot's name without the @, for the <c>t.me</c> link.</summary>
    public string? BotUsername { get; set; }

    /// <summary>What Telegram sends back in <c>X-Telegram-Bot-Api-Secret-Token</c> on every update.</summary>
    public string? WebhookSecret { get; set; }

    /// <summary>Where Telegram posts updates; the site's <c>/api/v1/telegram-updates</c> unless set.</summary>
    public string? WebhookUrl { get; set; }

    public Uri ApiBase { get; set; } = new("https://api.telegram.org/");

    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(BotToken) && !string.IsNullOrWhiteSpace(BotUsername) && !string.IsNullOrWhiteSpace(WebhookSecret);
}

/// <summary>A send Telegram refused. <see cref="Blocked"/> means the person blocked the bot or left: stop sending there.</summary>
internal sealed class TelegramException(string message, bool blocked = false) : Exception(message)
{
    public bool Blocked { get; } = blocked;
}

/// <summary>
/// The Bot API in plain text with link previews off. The token is part of every address, so it is
/// scrubbed from anything said about a failure. A <c>retry_after</c> of up to 30 seconds is waited
/// out once.
/// </summary>
internal sealed class TelegramBotClient(HttpClient http, IOptions<TelegramOptions> options, TimeProvider time)
{
    public const int MaxRetryAfterSeconds = 30;

    public Task SendMessageAsync(long chatId, string text, CancellationToken cancellationToken) =>
        CallAsync("sendMessage", new JsonObject
        {
            ["chat_id"] = chatId,
            ["text"] = text,
            ["link_preview_options"] = new JsonObject { ["is_disabled"] = true },
        }, cancellationToken);

    public Task SetWebhookAsync(string url, string secret, CancellationToken cancellationToken) =>
        CallAsync("setWebhook", new JsonObject
        {
            ["url"] = url,
            ["secret_token"] = secret,
            ["allowed_updates"] = new JsonArray("message"),
        }, cancellationToken);

    private async Task CallAsync(string method, JsonObject body, CancellationToken cancellationToken)
    {
        var token = options.Value.BotToken ?? throw new TelegramException("The Telegram bot is not set up.");
        for (var attempt = 0; ; attempt++)
        {
            HttpResponseMessage response;
            try
            {
                response = await http.PostAsync(
                    new Uri(options.Value.ApiBase, $"./bot{token}/{method}"),
                    new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
                    cancellationToken);
            }
            catch (HttpRequestException e)
            {
                throw new TelegramException("Telegram could not be reached: " + Scrub(e.Message, token));
            }

            using (response)
            {
                var reply = await ReadAsync(response, cancellationToken);
                if (response.IsSuccessStatusCode && reply?["ok"] is JsonValue ok && ok.TryGetValue<bool>(out var success) && success)
                {
                    return;
                }

                var description = Scrub(reply?["description"]?.ToString() ?? $"HTTP {(int)response.StatusCode}", token);
                var retryAfter = reply?["parameters"]?["retry_after"] is JsonValue wait && wait.TryGetValue<int>(out var seconds) ? seconds : (int?)null;
                if (response.StatusCode == HttpStatusCode.TooManyRequests && attempt == 0 && retryAfter is > 0 and <= MaxRetryAfterSeconds)
                {
                    await Task.Delay(TimeSpan.FromSeconds(retryAfter.Value), time, cancellationToken);
                    continue;
                }

                throw new TelegramException(
                    response.StatusCode switch
                    {
                        HttpStatusCode.Unauthorized or HttpStatusCode.NotFound => "Telegram did not accept the bot token.",
                        HttpStatusCode.Forbidden => "The person blocked the bot or deleted the chat.",
                        HttpStatusCode.TooManyRequests => "Telegram asked to slow down: too many messages.",
                        _ => "Telegram refused the message: " + description,
                    },
                    blocked: response.StatusCode == HttpStatusCode.Forbidden);
            }
        }
    }

    private static async Task<JsonNode?> ReadAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        try
        {
            return await JsonNode.ParseAsync(await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
        }
        catch (System.Text.Json.JsonException)
        {
            return null;
        }
    }

    /// <summary>Removes the token, whole and its secret half after the colon, from a text.</summary>
    internal static string Scrub(string text, string token)
    {
        var scrubbed = text.Replace(token, "[token]", StringComparison.Ordinal);
        var colon = token.IndexOf(':', StringComparison.Ordinal);
        if (colon >= 0 && colon < token.Length - 1)
        {
            scrubbed = scrubbed.Replace(token[(colon + 1)..], "[token]", StringComparison.Ordinal);
        }

        return scrubbed;
    }
}

/// <summary>Queues Telegram messages in the request's or job's context, sent by <see cref="TelegramOutboxJob"/> once committed.</summary>
internal sealed class TelegramOutbox(AppDbContext db, TimeProvider time, IOptions<TelegramOptions> options, IServiceProvider services)
{
    private bool _added;

    public void Add(long chatId, string text)
    {
        if (!options.Value.IsConfigured)
        {
            return;
        }

        var now = time.GetUtcNow();
        db.TelegramMessages.Add(new TelegramMessage { ChatId = chatId, Text = text, CreatedAt = now, NextAttemptAt = now });
        _added = true;
    }

    /// <summary>Starts the outbox now rather than at its next minute. Call after the commit.</summary>
    public void SendSoon()
    {
        if (!_added)
        {
            return;
        }

        try
        {
            services.GetService<IBackgroundJobClient>()?.Enqueue<TelegramOutboxJob>(job => job.RunAsync(CancellationToken.None));
        }
        catch (Exception e) when (e is InvalidOperationException or ObjectDisposedException or Npgsql.NpgsqlException)
        {
            // The recurring run picks it up within a minute.
        }
    }
}

/// <summary>
/// Sends what the Telegram outbox holds, oldest first, with the same growing wait as email (1, 2,
/// 4 minutes, up to an hour, ten tries). A chat that blocked the bot is unlinked and its messages
/// dropped. A sent message loses its text.
/// </summary>
internal sealed partial class TelegramOutboxJob(AppDbContext db, TelegramBotClient bot, TimeProvider time, ILogger<TelegramOutboxJob> logger)
{
    public const int MaxAttempts = 10;
    private const int Batch = 50;

    [DisableConcurrentExecution(timeoutInSeconds: 60)]
    public async Task RunAsync(CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var due = await db.TelegramMessages
            .Where(m => m.SentAt == null && m.Attempts < MaxAttempts && m.NextAttemptAt <= now)
            .OrderBy(m => m.Id)
            .Take(Batch)
            .ToListAsync(cancellationToken);

        foreach (var message in due)
        {
            try
            {
                await bot.SendMessageAsync(message.ChatId, message.Text ?? "", cancellationToken);
                message.SentAt = time.GetUtcNow();
                message.Text = null;
                message.LastError = null;
            }
            catch (TelegramException e)
            {
                message.Attempts = e.Blocked ? MaxAttempts : message.Attempts + 1;
                message.LastError = e.Message.Length > 400 ? e.Message[..400] : e.Message;
                message.NextAttemptAt = time.GetUtcNow() + TimeSpan.FromMinutes(Math.Min(60, Math.Pow(2, message.Attempts - 1)));
                if (e.Blocked)
                {
                    message.Text = null;
                    await db.TelegramLinks.Where(l => l.ChatId == message.ChatId).ExecuteDeleteAsync(cancellationToken);
                }

                LogFailed(logger, message.Id, message.Attempts, e.Message);
            }

            await db.SaveChangesAsync(cancellationToken);
        }
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Telegram message {Id} failed on attempt {Attempt}: {Reason}")]
    private static partial void LogFailed(ILogger logger, long id, int attempt, string reason);
}

/// <summary>Points the bot's webhook at this site on start, when the bot is set up. A failure is logged and the API starts anyway.</summary>
internal sealed partial class TelegramWebhookSetup(
    IServiceScopeFactory scopes, IOptions<TelegramOptions> options, IConfiguration configuration, ILogger<TelegramWebhookSetup> logger) : IHostedService
{
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        var settings = options.Value;
        if (!settings.IsConfigured)
        {
            return;
        }

        var url = settings.WebhookUrl ?? Http.SiteUrl.From(configuration) + ApiV1.Prefix + TelegramEndpoints.UpdatesPath;
        try
        {
            using var scope = scopes.CreateScope();
            await scope.ServiceProvider.GetRequiredService<TelegramBotClient>().SetWebhookAsync(url, settings.WebhookSecret!, cancellationToken);
            LogWebhookSet(logger, url);
        }
        catch (TelegramException e)
        {
            LogWebhookFailed(logger, e.Message);
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    [LoggerMessage(Level = LogLevel.Information, Message = "The Telegram bot's webhook points at {Url}")]
    private static partial void LogWebhookSet(ILogger logger, string url);

    [LoggerMessage(Level = LogLevel.Warning, Message = "The Telegram bot's webhook could not be set: {Reason}")]
    private static partial void LogWebhookFailed(ILogger logger, string reason);
}

internal static class TelegramChats
{
    public static string? Name(JsonNode? chat)
    {
        var username = chat?["username"]?.ToString();
        if (!string.IsNullOrWhiteSpace(username))
        {
            return "@" + username;
        }

        var name = string.Join(' ', new[] { chat?["first_name"]?.ToString(), chat?["last_name"]?.ToString() }.Where(n => !string.IsNullOrWhiteSpace(n)));
        return name.Length == 0 ? chat?["title"]?.ToString() : name;
    }

    public static string Format(long chatId) => chatId.ToString(CultureInfo.InvariantCulture);
}
