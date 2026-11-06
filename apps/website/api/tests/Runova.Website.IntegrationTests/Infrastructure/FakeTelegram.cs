using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using Runova.Website.Api.Telegram;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>
/// Stands in for api.telegram.org behind the RunovaHQ bot's client. It answers as the Bot API
/// does (ok, or a description with an error code) and keeps every call it saw.
/// </summary>
internal sealed class FakeTelegram
{
    public const string Token = "123456:fake-secret-half";
    public const string Username = "RunovaTestBot";
    public const string Secret = "webhook-secret-for-tests";

    public static readonly IReadOnlyDictionary<string, string> Settings = new Dictionary<string, string>
    {
        ["Telegram:BotToken"] = Token,
        ["Telegram:BotUsername"] = Username,
        ["Telegram:WebhookSecret"] = Secret,
    };

    public sealed record Call(string Method, JsonNode Body);

    private readonly ConcurrentQueue<Call> _calls = new();
    private Func<Call, (HttpStatusCode Status, string Json)> _reply = _ => (HttpStatusCode.OK, """{"ok":true,"result":{}}""");

    public IReadOnlyList<Call> Calls => [.. _calls];

    /// <summary>The texts sent to a chat, oldest first.</summary>
    public IReadOnlyList<string> SentTo(long chatId) =>
        [.. _calls.Where(c => c.Method == "sendMessage" && c.Body["chat_id"]!.GetValue<long>() == chatId).Select(c => c.Body["text"]!.GetValue<string>())];

    public void Replies(Func<Call, (HttpStatusCode Status, string Json)> reply) => _reply = reply;

    public void Register(IServiceCollection services) =>
        services.AddHttpClient<TelegramBotClient>().ConfigurePrimaryHttpMessageHandler(() => new Handler(this));

    /// <summary>An update as Telegram posts it to the webhook when someone writes to the bot.</summary>
    public static object Update(long chatId, string text, string username = "sam_dev") => new
    {
        update_id = Random.Shared.Next(),
        message = new
        {
            message_id = 1,
            date = 1793534400,
            text,
            chat = new { id = chatId, type = "private", first_name = "Sam", username },
            from = new { id = chatId, is_bot = false, first_name = "Sam" },
        },
    };

    private sealed class Handler(FakeTelegram telegram) : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            Assert.StartsWith($"/bot{Token}/", path, StringComparison.Ordinal);
            var call = new Call(path.Split('/')[^1], JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!);
            telegram._calls.Enqueue(call);
            var (status, json) = telegram._reply(call);
            return new HttpResponseMessage(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
        }
    }
}
