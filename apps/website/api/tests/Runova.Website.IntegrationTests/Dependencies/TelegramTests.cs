using System.Net;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.Api.Dependencies;
using Runova.Website.Api.Telegram;
using Runova.Website.Data;
using Runova.Website.IntegrationTests.Infrastructure;
using static Runova.Website.IntegrationTests.Infrastructure.TestDependencies;

namespace Runova.Website.IntegrationTests.Dependencies;

/// <summary>Linking a Telegram chat to the RunovaHQ bot, and alerts that go there.</summary>
public sealed class TelegramTests(PostgresFixture postgres) : IAsyncLifetime
{
    private const long ChatId = 424242;

    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 11, 6, 9, 0, 0, TimeSpan.Zero));
    private readonly FakeTelegram _telegram = new();
    private readonly FakePackageRegistries _registries = new();
    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync()
    {
        _factory = new WebsiteApiFactory(await postgres.CreateDatabaseAsync(), time: _time, settings: FakeTelegram.Settings, services: services =>
        {
            _telegram.Register(services);
            _registries.Register(services);
            services.AddSingleton<CheckSchedule>(new FixedSchedule(_time, next: 0));
        });
        _registries.Has("npm", "lodash", "5.0.0");
    }

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    private Task<HttpResponseMessage> PostUpdateAsync(object update, string secret = FakeTelegram.Secret) =>
        _factory.CreateApiClient().SendAsync(HttpMethod.Post, "/api/v1/telegram-updates", update, headers: new Dictionary<string, string> { [TelegramEndpoints.SecretHeader] = secret });

    private async Task SendOutboxAsync()
    {
        using var scope = _factory.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<TelegramOutboxJob>().RunAsync(TestContext.Current.CancellationToken);
    }

    private static async Task<string> LinkCodeAsync(ApiClient client)
    {
        var created = await ApiClient.ReadJsonAsync(await client.SendAsync(HttpMethod.Post, "/api/v1/accounts/me/telegram-link-codes"), HttpStatusCode.Created);
        var url = created.GetProperty("url").GetString()!;
        Assert.StartsWith($"https://t.me/{FakeTelegram.Username}?start=", url, StringComparison.Ordinal);
        return url[(url.IndexOf('=', StringComparison.Ordinal) + 1)..];
    }

    private async Task<ApiClient> LinkedAccountAsync()
    {
        var (_, client) = await AccountAsync(_factory);
        var code = await LinkCodeAsync(client);
        Assert.Equal(HttpStatusCode.OK, (await PostUpdateAsync(FakeTelegram.Update(ChatId, "/start " + code))).StatusCode);
        return client;
    }

    private static async Task<JsonElement> LinkAsync(ApiClient client) =>
        await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/accounts/me/telegram-links/current"), HttpStatusCode.OK);

    [Fact]
    public async Task Start_with_the_code_links_the_chat_and_says_so()
    {
        var client = await LinkedAccountAsync();

        await SendOutboxAsync();

        var link = await LinkAsync(client);
        Assert.True(link.GetProperty("available").GetBoolean());
        Assert.True(link.GetProperty("linked").GetBoolean());
        Assert.Equal("@sam_dev", link.GetProperty("chatName").GetString());
        Assert.Equal(FakeTelegram.Username, link.GetProperty("botUsername").GetString());
        Assert.StartsWith("Linked.", Assert.Single(_telegram.SentTo(ChatId)), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_code_works_once_and_for_fifteen_minutes()
    {
        var (_, client) = await AccountAsync(_factory);
        var code = await LinkCodeAsync(client);
        _time.Advance(TimeSpan.FromMinutes(16));

        await PostUpdateAsync(FakeTelegram.Update(ChatId, "/start " + code));
        await SendOutboxAsync();

        Assert.False((await LinkAsync(client)).GetProperty("linked").GetBoolean());
        Assert.Contains("/account/notifications", Assert.Single(_telegram.SentTo(ChatId)), StringComparison.Ordinal);
    }

    [Fact]
    public async Task An_update_without_the_secret_is_refused()
    {
        var (_, client) = await AccountAsync(_factory);
        var code = await LinkCodeAsync(client);

        var response = await PostUpdateAsync(FakeTelegram.Update(ChatId, "/start " + code), secret: "guessed");

        await ProblemAssert.IsAsync(response, HttpStatusCode.Unauthorized, "unauthorized");
        Assert.False((await LinkAsync(client)).GetProperty("linked").GetBoolean());
    }

    [Fact]
    public async Task Stop_in_the_chat_or_unlinking_on_the_site_ends_the_link()
    {
        var client = await LinkedAccountAsync();

        await PostUpdateAsync(FakeTelegram.Update(ChatId, "/stop"));

        Assert.False((await LinkAsync(client)).GetProperty("linked").GetBoolean());
        await ProblemAssert.IsAsync(await client.SendAsync(HttpMethod.Delete, "/api/v1/accounts/me/telegram-links/current"), HttpStatusCode.NotFound, "not-found");
        await PostUpdateAsync(FakeTelegram.Update(ChatId, "/start " + await LinkCodeAsync(client)));
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(HttpMethod.Delete, "/api/v1/accounts/me/telegram-links/current")).StatusCode);
    }

    [Fact]
    public async Task An_alert_goes_to_the_linked_chat_unless_telegram_is_turned_off()
    {
        var client = await LinkedAccountAsync();
        var scope = await PersonalScopeAsync(client);
        await UploadedAsync(client, scope, "p-shop", Inventory("Shop", Package("lodash", "4.17.20")));

        await RunChecksAsync(_factory);
        await SendOutboxAsync();

        Assert.Equal("📦 lodash 5.0.0 is out for Shop\nlodash 4.17.20 to 5.0.0: major update", _telegram.SentTo(ChatId)[^1]);

        var settings = await client.GetAsync("/api/v1/accounts/me/dependency-alert-settings");
        await client.SendAsync(HttpMethod.Patch, "/api/v1/accounts/me/dependency-alert-settings", new { telegram = false }, ifMatch: settings.Headers.ETag!.Tag);
        _registries.Has("npm", "lodash", "6.0.0");
        _time.Advance(TimeSpan.FromHours(7)); // past the registry cache
        using (var due = _factory.Services.CreateScope())
        {
            await due.ServiceProvider.GetRequiredService<AppDbContext>().PackageInventories.ExecuteUpdateAsync(i => i.SetProperty(x => x.NextCheckAt, _time.GetUtcNow()), TestContext.Current.CancellationToken);
        }

        await RunChecksAsync(_factory);
        await SendOutboxAsync();

        Assert.Equal(2, _telegram.SentTo(ChatId).Count);
        Assert.Equal(2, (await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/notifications"), HttpStatusCode.OK)).GetProperty("totalItems").GetInt32());
    }

    [Fact]
    public async Task A_chat_that_blocked_the_bot_is_unlinked()
    {
        var client = await LinkedAccountAsync();
        _telegram.Replies(_ => (HttpStatusCode.Forbidden, """{"ok":false,"error_code":403,"description":"Forbidden: bot was blocked by the user"}"""));

        await SendOutboxAsync();

        Assert.False((await LinkAsync(client)).GetProperty("linked").GetBoolean());
    }

    [Fact]
    public async Task A_failure_waits_and_tries_again_without_ever_saying_the_token()
    {
        await LinkedAccountAsync();
        _telegram.Replies(_ => (HttpStatusCode.BadRequest, $$"""{"ok":false,"error_code":400,"description":"Bad Request: bot{{FakeTelegram.Token}} said no, fake-secret-half"}"""));

        await SendOutboxAsync();

        using var scope = _factory.Services.CreateScope();
        var message = await scope.ServiceProvider.GetRequiredService<AppDbContext>().TelegramMessages.SingleAsync(TestContext.Current.CancellationToken);
        Assert.Equal(1, message.Attempts);
        Assert.Null(message.SentAt);
        Assert.Equal(_time.GetUtcNow().AddMinutes(1), message.NextAttemptAt);
        Assert.DoesNotContain("fake-secret-half", message.LastError, StringComparison.Ordinal);
        Assert.Contains("[token]", message.LastError, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Starting_the_site_points_the_webhook_here()
    {
        _ = _factory.Services;

        var call = Assert.Single(_telegram.Calls, c => c.Method == "setWebhook");
        Assert.Equal("https://runovahq.com/api/v1/telegram-updates", call.Body["url"]!.GetValue<string>());
        Assert.Equal(FakeTelegram.Secret, call.Body["secret_token"]!.GetValue<string>());
    }
}

/// <summary>Without a bot token the site says Telegram is not available and makes no links.</summary>
public sealed class TelegramOffTests(PostgresFixture postgres) : IDisposable
{
    private readonly WebsiteApiFactory _factory = new(postgres.ConnectionString);

    public void Dispose() => _factory.Dispose();

    [Fact]
    public async Task No_bot_no_link()
    {
        var (_, client) = await AccountAsync(_factory);

        var link = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/accounts/me/telegram-links/current"), HttpStatusCode.OK);
        var code = await client.SendAsync(HttpMethod.Post, "/api/v1/accounts/me/telegram-link-codes");

        Assert.False(link.GetProperty("available").GetBoolean());
        await ProblemAssert.IsAsync(code, HttpStatusCode.ServiceUnavailable, "unavailable");
    }
}
