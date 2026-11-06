using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Runova.Website.Api.Dependencies;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Problems;
using Runova.Website.Data;
using Runova.Website.Data.Dependencies;

namespace Runova.Website.Api.Telegram;

public sealed record TelegramLinkCodeDto(string Url, DateTimeOffset ExpiresAt);

public sealed record TelegramLinkDto(bool Available, bool Linked, string? BotUsername, string? ChatName, DateTimeOffset? LinkedAt);

/// <summary>
/// Linking a Telegram chat to an account (E51): the account page asks for a one-time link, the
/// person opens it and presses Start, and the bot's <c>/start &lt;code&gt;</c> arrives at the
/// webhook, which links the chat. <c>/stop</c> in the chat unlinks it, as does the account page.
/// </summary>
internal static class TelegramEndpoints
{
    public const string UpdatesPath = "/telegram-updates";
    public const string SecretHeader = "X-Telegram-Bot-Api-Secret-Token";
    public static readonly TimeSpan CodeLifetime = TimeSpan.FromMinutes(15);

    public static RouteGroupBuilder MapTelegram(this RouteGroupBuilder api)
    {
        var me = api.MapGroup("/accounts/me").RequireAuthorization(Policies.Account);
        me.MapGet("/telegram-links/current", GetAsync);
        me.MapDelete("/telegram-links/current", UnlinkAsync);
        me.MapPost("/telegram-link-codes", CreateCodeAsync);
        api.MapPost(UpdatesPath, UpdateAsync).AllowAnonymous().Accepts<JsonObject>("application/json");
        return api;
    }

    private static async Task<Ok<TelegramLinkDto>> GetAsync(HttpContext http, AppDbContext db, IOptions<TelegramOptions> options)
    {
        var userId = CurrentAccount.Id(http);
        var link = await db.TelegramLinks.AsNoTracking().SingleOrDefaultAsync(l => l.UserId == userId);
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(new TelegramLinkDto(options.Value.IsConfigured, link is not null, options.Value.IsConfigured ? options.Value.BotUsername : null, link?.ChatName, link?.LinkedAt));
    }

    private static async Task<Results<NoContent, ProblemHttpResult>> UnlinkAsync(HttpContext http, AppDbContext db)
    {
        var userId = CurrentAccount.Id(http);
        var deleted = await db.TelegramLinks.Where(l => l.UserId == userId).ExecuteDeleteAsync();
        return deleted == 0 ? ApiProblems.Of(ProblemTypes.NotFound, "No Telegram chat is linked to this account.") : TypedResults.NoContent();
    }

    private static async Task<Results<Created<TelegramLinkCodeDto>, ProblemHttpResult>> CreateCodeAsync(
        HttpContext http, AppDbContext db, IOptions<TelegramOptions> options, TimeProvider time)
    {
        if (!options.Value.IsConfigured)
        {
            return ApiProblems.Of(ProblemTypes.Unavailable, "Telegram alerts are not set up on this site.");
        }

        var userId = CurrentAccount.Id(http);
        var now = time.GetUtcNow();
        var code = Base64Url(RandomNumberGenerator.GetBytes(24));
        await db.TelegramLinkCodes.Where(c => c.UserId == userId || c.ExpiresAt < now).ExecuteDeleteAsync();
        var row = new TelegramLinkCode { UserId = userId, CodeHash = Hash(code), ExpiresAt = now + CodeLifetime };
        db.TelegramLinkCodes.Add(row);
        await db.SaveChangesAsync();
        return TypedResults.Created((string?)null, new TelegramLinkCodeDto($"https://t.me/{options.Value.BotUsername}?start={code}", row.ExpiresAt));
    }

    /// <summary>
    /// An update from Telegram. Anything that is not a command this bot knows is answered 200 and
    /// ignored, since Telegram sends an update again until it gets a 200.
    /// </summary>
    private static async Task<Results<Ok, ProblemHttpResult>> UpdateAsync(
        HttpContext http, AppDbContext db, IOptions<TelegramOptions> options, TelegramOutbox outbox, TimeProvider time)
    {
        var settings = options.Value;
        if (!settings.IsConfigured)
        {
            return ApiProblems.Of(ProblemTypes.NotFound, "Telegram alerts are not set up on this site.");
        }

        var sent = Encoding.UTF8.GetBytes(http.Request.Headers[SecretHeader].ToString());
        if (!CryptographicOperations.FixedTimeEquals(sent, Encoding.UTF8.GetBytes(settings.WebhookSecret!)))
        {
            return ApiProblems.Of(ProblemTypes.Unauthorized, "The update did not carry the webhook secret.");
        }

        JsonNode? update;
        try
        {
            update = await JsonNode.ParseAsync(http.Request.Body, cancellationToken: http.RequestAborted);
        }
        catch (JsonException)
        {
            return TypedResults.Ok();
        }

        var message = update?["message"];
        var text = message?["text"]?.ToString()?.Trim() ?? "";
        if (message?["chat"]?["id"] is not JsonValue id || !id.TryGetValue<long>(out var chatId) || !text.StartsWith('/'))
        {
            return TypedResults.Ok();
        }

        var parts = text.Split(' ', 2, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var command = parts[0].Split('@')[0].ToLowerInvariant();
        var site = SiteUrl.From(http.RequestServices.GetRequiredService<IConfiguration>());
        if (command == "/start")
        {
            var now = time.GetUtcNow();
            var hash = parts.Length > 1 ? Hash(parts[1]) : null;
            var code = hash is null ? null : await db.TelegramLinkCodes.SingleOrDefaultAsync(c => c.CodeHash == hash && c.ExpiresAt > now);
            if (code is null)
            {
                outbox.Add(chatId, $"To get Runova alerts here, open {site}/account/notifications and press Link Telegram.");
            }
            else
            {
                await db.TelegramLinks.Where(l => l.UserId == code.UserId || l.ChatId == chatId).ExecuteDeleteAsync();
                db.TelegramLinks.Add(new TelegramLink { UserId = code.UserId, ChatId = chatId, ChatName = Clip(TelegramChats.Name(message["chat"]), 100), LinkedAt = now });
                db.TelegramLinkCodes.Remove(code);
                outbox.Add(chatId, "Linked. Runova will send your dependency alerts here. Send /stop to stop them.");
            }
        }
        else if (command == "/stop")
        {
            var removed = await db.TelegramLinks.Where(l => l.ChatId == chatId).ExecuteDeleteAsync();
            outbox.Add(chatId, removed > 0 ? "Unlinked. Runova will not send alerts here any more." : "This chat is not linked to a Runova account.");
        }
        else
        {
            return TypedResults.Ok();
        }

        await db.SaveChangesAsync();
        outbox.SendSoon();
        return TypedResults.Ok();
    }

    private static string? Clip(string? text, int length) => text is null || text.Length <= length ? text : text[..length];

    private static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    internal static string Hash(string code) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(code)));
}
