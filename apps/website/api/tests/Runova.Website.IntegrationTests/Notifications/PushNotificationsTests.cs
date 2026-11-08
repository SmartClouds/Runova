using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.Api.Dependencies;
using Runova.Website.Api.Notifications;
using Runova.Website.Data;
using Runova.Website.Data.Identity;
using Runova.Website.IntegrationTests.Infrastructure;
using static Runova.Website.IntegrationTests.Infrastructure.TestDependencies;

namespace Runova.Website.IntegrationTests.Notifications;

/// <summary>Push notifications end to end, with the push services replaced by a fake (E82).</summary>
public sealed class PushNotificationsTests(PostgresFixture postgres) : IAsyncLifetime
{
    private readonly FakeTimeProvider _time = new(DateTimeOffset.UtcNow);
    private readonly FakePackageRegistries _registries = new();
    private readonly FakePush _push = new();
    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync()
    {
        _factory = new WebsiteApiFactory(await postgres.CreateDatabaseAsync(), time: _time, services: services =>
        {
            _registries.Register(services);
            services.AddSingleton<CheckSchedule>(new FixedSchedule(_time, next: 0));
            _push.Register(services);
        });
        _registries.Has("npm", "lodash", "5.0.0");
    }

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    private async Task<(AppUser User, ApiClient Browser, HttpClient Desktop, TestPhones.Phone Phone)> SetUpAsync(string pushToken = "fcm-token-1")
    {
        var (user, browser) = await AccountAsync(_factory);
        var desktop = TestPhones.BearerClient(_factory, await DeviceTokenAsync(_factory, browser));
        var phone = await TestPhones.SignInAsync(_factory, browser);
        await RegisterAsync(phone, pushToken);
        return (user, browser, desktop, phone);
    }

    private static async Task RegisterAsync(TestPhones.Phone phone, string token, string platform = "android")
    {
        var response = await phone.Client.PutAsJsonAsync("/api/v1/accounts/me/push-devices/current", new { platform, pushToken = token }, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    private static object Finished(string project = "Shop") => new { category = "agent-finished", agent = "Claude Code", project };

    private static async Task<JsonElement> ForwardAsync(HttpClient desktop, object body)
    {
        var response = await desktop.PostAsJsonAsync("/api/v1/notification-events", body, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return await response.Content.ReadFromJsonAsync<JsonElement>(TestContext.Current.CancellationToken);
    }

    private static async Task SetPreferenceAsync(HttpClient client, string category, bool enabled)
    {
        var response = await client.PutAsJsonAsync($"/api/v1/accounts/me/notification-preferences/{category}", new { enabled }, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    private HubConnection Connect(string token) =>
        new HubConnectionBuilder()
            .WithUrl(new Uri(_factory.Server.BaseAddress, NotificationsHub.Path), options =>
            {
                options.HttpMessageHandlerFactory = _ => _factory.Server.CreateHandler();
                options.Transports = HttpTransportType.LongPolling;
                options.AccessTokenProvider = () => Task.FromResult<string?>(token);
            })
            .Build();

    [Fact]
    public async Task A_phone_registers_its_token_and_the_answer_never_shows_it()
    {
        var (_, browser) = await AccountAsync(_factory);
        var phone = await TestPhones.SignInAsync(_factory, browser, "ios");

        var response = await phone.Client.PutAsJsonAsync("/api/v1/accounts/me/push-devices/current", new { platform = "ios", pushToken = "abc123" }, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        Assert.DoesNotContain("abc123", body, StringComparison.Ordinal);
        Assert.Contains("ios", body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Only_a_phones_own_sign_in_can_register_a_token()
    {
        var (_, browser) = await AccountAsync(_factory);
        var desktop = TestPhones.BearerClient(_factory, await DeviceTokenAsync(_factory, browser));

        var response = await desktop.PutAsJsonAsync("/api/v1/accounts/me/push-devices/current", new { platform = "android", pushToken = "abc" }, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task A_token_with_spaces_or_an_unknown_platform_is_refused()
    {
        var (_, browser) = await AccountAsync(_factory);
        var phone = await TestPhones.SignInAsync(_factory, browser);

        Assert.Equal(HttpStatusCode.BadRequest, (await phone.Client.PutAsJsonAsync("/api/v1/accounts/me/push-devices/current", new { platform = "android", pushToken = "a b" }, TestContext.Current.CancellationToken)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await phone.Client.PutAsJsonAsync("/api/v1/accounts/me/push-devices/current", new { platform = "windows", pushToken = "abc" }, TestContext.Current.CancellationToken)).StatusCode);
    }

    [Fact]
    public async Task Preferences_start_on_and_a_change_is_kept()
    {
        var (_, _, _, phone) = await SetUpAsync();

        var before = await ApiClient.ReadJsonAsync(await phone.Client.GetAsync("/api/v1/accounts/me/notification-preferences", TestContext.Current.CancellationToken), HttpStatusCode.OK);
        var off = await phone.Client.PutAsJsonAsync("/api/v1/accounts/me/notification-preferences/pipelines", new { enabled = false }, TestContext.Current.CancellationToken);
        var after = await ApiClient.ReadJsonAsync(await phone.Client.GetAsync("/api/v1/accounts/me/notification-preferences", TestContext.Current.CancellationToken), HttpStatusCode.OK);
        var unknown = await phone.Client.PutAsJsonAsync("/api/v1/accounts/me/notification-preferences/nope", new { enabled = false }, TestContext.Current.CancellationToken);

        Assert.All(before.GetProperty("items").EnumerateArray(), item => Assert.True(item.GetProperty("enabled").GetBoolean()));
        Assert.Equal(NotificationCategories.All.Count, before.GetProperty("items").GetArrayLength());
        Assert.Equal(HttpStatusCode.OK, off.StatusCode);
        Assert.False(after.GetProperty("items").EnumerateArray().Single(i => i.GetProperty("category").GetString() == "pipelines").GetProperty("enabled").GetBoolean());
        Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
    }

    [Fact]
    public async Task Each_forwarded_category_reaches_a_closed_phone_and_an_open_one()
    {
        var (_, _, desktop, phone) = await SetUpAsync();
        await using var hub = Connect(phone.AccessToken);
        var live = new List<UserNotificationDto>();
        hub.On<UserNotificationDto>(nameof(INotificationsClient.NotificationCreated), n => { lock (live) { live.Add(n); } });
        await hub.StartAsync(TestContext.Current.CancellationToken);

        object[] events =
        [
            new { category = "agent-needs-input", agent = "Claude Code", project = "Shop" },
            new { category = "agent-finished", agent = "Claude Code", project = "Shop" },
            new { category = "tasks", status = "finished", project = "Shop", subject = "Nightly" },
            new { category = "pipelines", status = "failed", project = "Shop", subject = "Build" },
            new { category = "deploys", status = "critical", subject = "web-1" },
            new { category = "monitors", status = "failed", subject = "Shop API" },
            new { category = "relay", status = "finished", project = "Shop" },
            new { category = "ai-limits", status = "threshold", subject = "Claude" },
            new { category = "security-news", subject = "OpenSSL" },
            new { category = "tool-updates", subject = "Node" },
            new { category = "remote", status = "connected", subject = "Kim" },
        ];
        foreach (var body in events)
        {
            await ForwardAsync(desktop, body);
        }

        var pushed = await _push.WaitForAsync(events.Length);
        Assert.Equal(events.Length, pushed.Count);
        Assert.Contains(pushed, p => p.Line == "Claude Code needs your input in Shop");
        Assert.Contains(pushed, p => p.Line == "Build failed in Shop" && p.Category == "pipelines");
        Assert.All(pushed, p => Assert.Equal("fcm-token-1", p.Token));

        await WaitUntilAsync(() => { lock (live) { return live.Count == events.Length; } });
        lock (live)
        {
            Assert.Equal(events.Length, live.Select(n => n.Id).Distinct().Count());
            Assert.Contains(live, n => n is { Kind: "pipelines", Title: "Build failed in Shop" });
        }
    }

    [Fact]
    public async Task A_category_turned_off_is_neither_pushed_nor_stored()
    {
        var (_, _, desktop, phone) = await SetUpAsync();
        await SetPreferenceAsync(phone.Client, "pipelines", false);

        var off = await ForwardAsync(desktop, new { category = "pipelines", status = "failed", project = "Shop", subject = "Build" });
        await ForwardAsync(desktop, Finished());

        var pushed = await _push.WaitForAsync(1);
        Assert.Equal(JsonValueKind.Null, off.GetProperty("notificationId").ValueKind);
        Assert.Single(pushed);
        Assert.Equal("Claude Code finished in Shop", pushed[0].Line);
    }

    [Fact]
    public async Task A_category_turned_back_on_is_pushed_again()
    {
        var (_, _, desktop, phone) = await SetUpAsync();
        await SetPreferenceAsync(phone.Client, "agent-finished", false);
        await ForwardAsync(desktop, Finished());
        await SetPreferenceAsync(phone.Client, "agent-finished", true);

        await ForwardAsync(desktop, Finished("Web"));

        var pushed = await _push.WaitForAsync(1);
        Assert.Single(pushed);
        Assert.Equal("Claude Code finished in Web", pushed[0].Line);
    }

    [Theory]
    [InlineData("\u001b[31mfatal\u001b[0m")]
    [InlineData("line one\nline two")]
    [InlineData("npm ERR! code ELIFECYCLE")]
    public async Task Terminal_text_in_a_field_never_reaches_a_payload(string terminal)
    {
        var (_, _, desktop, _) = await SetUpAsync();

        var response = await desktop.PostAsJsonAsync("/api/v1/notification-events", new { category = "agent-finished", agent = "Claude Code", project = terminal }, TestContext.Current.CancellationToken);
        await ForwardAsync(desktop, Finished());

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var pushed = await _push.WaitForAsync(1);
        Assert.Single(pushed);
        Assert.DoesNotContain(pushed, p => p.Line.Contains(terminal, StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_message_field_is_refused_outright()
    {
        var (_, _, desktop, _) = await SetUpAsync();

        var response = await desktop.PostAsJsonAsync(
            "/api/v1/notification-events",
            new { category = "agent-finished", agent = "Claude Code", project = "Shop", message = "npm ERR! the whole terminal" },
            TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task A_value_too_long_is_refused_and_a_phone_can_not_forward()
    {
        var (_, _, desktop, phone) = await SetUpAsync();

        var tooLong = await desktop.PostAsJsonAsync("/api/v1/notification-events", new { category = "agent-finished", agent = "Claude Code", project = new string('x', 500) }, TestContext.Current.CancellationToken);
        var fromPhone = await phone.Client.PostAsJsonAsync("/api/v1/notification-events", Finished(), TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.BadRequest, tooLong.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, fromPhone.StatusCode);
    }

    [Fact]
    public async Task Signing_out_stops_pushes_to_that_phone_only()
    {
        var (_, browser, desktop, firstPhone) = await SetUpAsync();
        var secondPhone = await TestPhones.SignInAsync(_factory, browser);
        await RegisterAsync(secondPhone, "fcm-token-2");

        Assert.Equal(HttpStatusCode.NoContent, (await firstPhone.Client.DeleteAsync("/api/v1/sessions/current", TestContext.Current.CancellationToken)).StatusCode);
        await ForwardAsync(desktop, Finished());

        var pushed = await _push.WaitForAsync(1);
        Assert.Equal("fcm-token-2", Assert.Single(pushed).Token);
        Assert.Equal(1, await DeviceCountAsync());
    }

    [Fact]
    public async Task Ending_a_session_from_the_account_page_stops_its_pushes()
    {
        var (_, browser, desktop, phone) = await SetUpAsync();

        Assert.Equal(HttpStatusCode.NoContent, (await browser.SendAsync(HttpMethod.Delete, $"/api/v1/sessions/{phone.SessionId}")).StatusCode);
        var secondPhone = await TestPhones.SignInAsync(_factory, browser);
        await RegisterAsync(secondPhone, "fcm-token-2");
        await ForwardAsync(desktop, Finished());

        var pushed = await _push.WaitForAsync(1);
        Assert.Equal("fcm-token-2", Assert.Single(pushed).Token);
    }

    [Fact]
    public async Task Ending_a_session_closes_the_phones_hub_connection()
    {
        var (_, browser, _, phone) = await SetUpAsync();
        var hub = Connect(phone.AccessToken);
        await using (hub)
        {
            var closed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            hub.Closed += _ =>
            {
                closed.TrySetResult();
                return Task.CompletedTask;
            };
            await hub.StartAsync(TestContext.Current.CancellationToken);

            await browser.SendAsync(HttpMethod.Delete, $"/api/v1/sessions/{phone.SessionId}");

            await closed.Task.WaitAsync(TimeSpan.FromSeconds(20), TestContext.Current.CancellationToken);
            Assert.Equal(HubConnectionState.Disconnected, hub.State);
        }
    }

    [Fact]
    public async Task A_token_seen_again_under_another_sign_in_moves_to_it()
    {
        var (_, browser, desktop, firstPhone) = await SetUpAsync();
        var secondPhone = await TestPhones.SignInAsync(_factory, browser);

        await RegisterAsync(secondPhone, "fcm-token-1");
        await ForwardAsync(desktop, Finished());

        var pushed = await _push.WaitForAsync(1);
        Assert.Single(pushed);
        Assert.Equal(1, await DeviceCountAsync());
        Assert.NotNull(firstPhone);
    }

    [Fact]
    public async Task A_token_the_push_service_no_longer_knows_is_forgotten()
    {
        var (_, _, desktop, _) = await SetUpAsync();
        _push.Result = PushSendResult.Unregistered;

        await ForwardAsync(desktop, Finished());
        await _push.WaitForAsync(1);

        await WaitUntilAsync(async () => await DeviceCountAsync() == 0);
    }

    [Fact]
    public async Task Nothing_is_kept_for_an_account_with_no_phone()
    {
        var (_, browser) = await AccountAsync(_factory);
        var desktop = TestPhones.BearerClient(_factory, await DeviceTokenAsync(_factory, browser));

        var listeners = await ApiClient.ReadJsonAsync(await desktop.GetAsync("/api/v1/accounts/me/notification-listeners", TestContext.Current.CancellationToken), HttpStatusCode.OK);
        var forwarded = await ForwardAsync(desktop, Finished());

        Assert.Equal(0, listeners.GetProperty("count").GetInt32());
        Assert.Equal(JsonValueKind.Null, forwarded.GetProperty("notificationId").ValueKind);
        using var scope = _factory.Services.CreateScope();
        Assert.Equal(0, await scope.ServiceProvider.GetRequiredService<AppDbContext>().UserNotifications.CountAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Forwarded_events_stay_off_the_desktop_and_the_website()
    {
        var (_, browser, desktop, phone) = await SetUpAsync();
        var phoneToken = phone.AccessToken;
        await using var hubDesktop = Connect(await DeviceTokenAsync(_factory, browser));
        var heard = 0;
        hubDesktop.On<UserNotificationDto>(nameof(INotificationsClient.NotificationCreated), _ => Interlocked.Increment(ref heard));
        await hubDesktop.StartAsync(TestContext.Current.CancellationToken);

        await ForwardAsync(desktop, Finished());
        await _push.WaitForAsync(1);

        var phoneInbox = await ApiClient.ReadJsonAsync(await phone.Client.GetAsync("/api/v1/notifications", TestContext.Current.CancellationToken), HttpStatusCode.OK);
        var websiteInbox = await ApiClient.ReadJsonAsync(await browser.GetAsync("/api/v1/notifications"), HttpStatusCode.OK);
        var desktopInbox = await ApiClient.ReadJsonAsync(await desktop.GetAsync("/api/v1/notifications", TestContext.Current.CancellationToken), HttpStatusCode.OK);

        Assert.Equal(1, phoneInbox.GetProperty("totalItems").GetInt32());
        Assert.Equal("agent-finished", phoneInbox.GetProperty("items")[0].GetProperty("category").GetString());
        Assert.Equal(0, websiteInbox.GetProperty("totalItems").GetInt32());
        Assert.Equal(0, desktopInbox.GetProperty("totalItems").GetInt32());
        Assert.Equal(0, heard);
        Assert.False(string.IsNullOrEmpty(phoneToken));
    }

    [Fact]
    public async Task A_server_alert_reaches_a_phone_with_its_category_on()
    {
        var (_, browser, _, phone) = await SetUpAsync();
        await using var hub = Connect(phone.AccessToken);
        var created = new TaskCompletionSource<UserNotificationDto>(TaskCreationOptions.RunContinuationsAsynchronously);
        hub.On<UserNotificationDto>(nameof(INotificationsClient.NotificationCreated), n => created.TrySetResult(n));
        await hub.StartAsync(TestContext.Current.CancellationToken);
        await UploadedAsync(browser, await PersonalScopeAsync(browser), "p-shop", Inventory("Shop", Package("lodash", "4.17.20")));

        await RunChecksAsync(_factory);

        var notification = await created.Task.WaitAsync(TimeSpan.FromSeconds(20), TestContext.Current.CancellationToken);
        Assert.Equal("dependencies", notification.Category);
        var pushed = await _push.WaitForAsync(1);
        Assert.Equal("lodash 5.0.0 is out for Shop", pushed[0].Line);
        Assert.Equal("dependencies", pushed[0].Category);
    }

    [Fact]
    public async Task A_server_alert_in_a_category_turned_off_is_quiet_on_the_phone_but_not_the_desktop()
    {
        var (_, browser, desktop, phone) = await SetUpAsync();
        await SetPreferenceAsync(phone.Client, "dependencies", false);
        await using var phoneHub = Connect(phone.AccessToken);
        var phoneHeard = new List<string>();
        phoneHub.On<UserNotificationDto>(nameof(INotificationsClient.NotificationCreated), n => { lock (phoneHeard) { phoneHeard.Add(n.Category); } });
        await phoneHub.StartAsync(TestContext.Current.CancellationToken);
        await using var desktopHub = Connect(await DeviceTokenAsync(_factory, browser));
        var desktopHeard = new TaskCompletionSource<UserNotificationDto>(TaskCreationOptions.RunContinuationsAsynchronously);
        desktopHub.On<UserNotificationDto>(nameof(INotificationsClient.NotificationCreated), n => desktopHeard.TrySetResult(n));
        await desktopHub.StartAsync(TestContext.Current.CancellationToken);
        await UploadedAsync(browser, await PersonalScopeAsync(browser), "p-shop", Inventory("Shop", Package("lodash", "4.17.20")));

        await RunChecksAsync(_factory);

        await desktopHeard.Task.WaitAsync(TimeSpan.FromSeconds(20), TestContext.Current.CancellationToken);
        await ForwardAsync(desktop, Finished());
        var pushed = await _push.WaitForAsync(1);
        Assert.Equal("Claude Code finished in Shop", Assert.Single(pushed).Line);
        // The event sent after the alert has arrived, so the alert would have by now too.
        await WaitUntilAsync(() => { lock (phoneHeard) { return phoneHeard.Contains("agent-finished"); } });
        lock (phoneHeard)
        {
            Assert.DoesNotContain("dependencies", phoneHeard);
        }

        var phoneInbox = await ApiClient.ReadJsonAsync(await phone.Client.GetAsync("/api/v1/notifications", TestContext.Current.CancellationToken), HttpStatusCode.OK);
        Assert.DoesNotContain(phoneInbox.GetProperty("items").EnumerateArray(), i => i.GetProperty("category").GetString() == "dependencies");
    }

    [Fact]
    public async Task A_desktop_that_sends_too_much_is_slowed_down()
    {
        var (_, _, desktop, _) = await SetUpAsync();
        for (var i = 0; i < NotificationSettingsEndpoints.MaxForwardedPerMinute; i++)
        {
            await ForwardAsync(desktop, Finished());
        }

        var refused = await desktop.PostAsJsonAsync("/api/v1/notification-events", Finished(), TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.TooManyRequests, refused.StatusCode);
    }

    private async Task<int> DeviceCountAsync()
    {
        using var scope = _factory.Services.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<AppDbContext>().PushDevices.CountAsync(TestContext.Current.CancellationToken);
    }

    private static async Task WaitUntilAsync(Func<bool> condition)
    {
        for (var waited = 0; waited < 200 && !condition(); waited++)
        {
            await Task.Delay(50, TestContext.Current.CancellationToken);
        }

        Assert.True(condition());
    }

    private static async Task WaitUntilAsync(Func<Task<bool>> condition)
    {
        for (var waited = 0; waited < 200 && !await condition(); waited++)
        {
            await Task.Delay(50, TestContext.Current.CancellationToken);
        }

        Assert.True(await condition());
    }
}
