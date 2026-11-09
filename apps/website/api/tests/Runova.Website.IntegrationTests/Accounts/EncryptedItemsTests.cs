using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.Api.Notifications;
using Runova.Website.Core.Identity;
using Runova.Website.Data;
using Runova.Website.Data.Identity;
using Runova.Website.IntegrationTests.Infrastructure;
using static Runova.Website.IntegrationTests.Infrastructure.TestDependencies;

namespace Runova.Website.IntegrationTests.Accounts;

/// <summary>Sealing notifications and sync on paid plans, across the real tables and endpoints (E92).</summary>
public sealed class EncryptedItemsTests(PostgresFixture postgres) : IAsyncLifetime
{
    private const string Encryption = "/api/v1/accounts/me/encryption-preferences";
    private const string PhoneKey = "AbCdEfGhIjKl";

    private readonly FakeTimeProvider _time = new(DateTimeOffset.UtcNow);
    private readonly FakePush _push = new();
    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync() =>
        _factory = new WebsiteApiFactory(await postgres.CreateDatabaseAsync(), time: _time, services: _push.Register);

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    private async Task<ApiClient> AdminAsync() => await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services, Roles.Admin));

    private static async Task GrantProAsync(ApiClient admin, AppUser user) =>
        Assert.Equal(HttpStatusCode.OK, (await admin.SendAsync(HttpMethod.Put, $"/api/v1/users/{user.Id}/subscriptions/current", new { accountTypeId = TestBilling.ProId })).StatusCode);

    private static Task<HttpResponseMessage> SwitchAsync(ApiClient client, string item, bool enabled) =>
        client.SendAsync(HttpMethod.Put, $"{Encryption}/{item}", new { enabled });

    private static async Task<JsonElement> StatusAsync(ApiClient client) =>
        await ApiClient.ReadJsonAsync(await client.GetAsync(Encryption), HttpStatusCode.OK);

    private static JsonElement Item(JsonElement status, string item) =>
        status.GetProperty("items").EnumerateArray().Single(i => i.GetProperty("item").GetString() == item);

    private static async Task SetKeyAsync(ApiClient client, long scope) =>
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(HttpMethod.Put, $"/api/v1/sync-scopes/{scope}/keys/current", new { version = 1, envelope = new { wrapped = "x" } })).StatusCode);

    private static async Task<bool> SealsEverythingAsync(ApiClient client)
    {
        var scopes = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/sync-scopes"), HttpStatusCode.OK);
        return scopes.GetProperty("items").EnumerateArray().Single(s => s.GetProperty("kind").GetString() == "personal").GetProperty("policy").GetProperty("everything").GetBoolean();
    }

    private static Task<HttpResponseMessage> PatchEverythingAsync(ApiClient client, long scope, bool everything) =>
        client.SendAsync(HttpMethod.Patch, $"/api/v1/sync-scopes/{scope}", new { policy = new { everything } });

    private static async Task<JsonElement> ForwardAsync(HttpClient desktop, object body, HttpStatusCode expected)
    {
        var response = await desktop.PostAsJsonAsync("/api/v1/notification-events", body, TestContext.Current.CancellationToken);
        return await ApiClient.ReadJsonAsync(response, expected);
    }

    [Fact]
    public async Task The_switches_follow_the_plan_and_the_key()
    {
        var admin = await AdminAsync();
        var (user, client) = await AccountAsync(_factory);
        var scope = await PersonalScopeAsync(client);

        var free = await StatusAsync(client);
        Assert.False(free.GetProperty("entitled").GetBoolean());
        Assert.Equal("Free", free.GetProperty("planName").GetString());
        Assert.True(Item(free, "sync").GetProperty("needsKey").GetBoolean());

        var refused = await ApiClient.ReadJsonAsync(await SwitchAsync(client, "notifications", true), HttpStatusCode.Forbidden);
        Assert.Equal("plan-required", refused.GetProperty("code").GetString());
        Assert.Equal("free", refused.GetProperty("accountType").GetString());
        Assert.Equal(HttpStatusCode.Forbidden, (await PatchEverythingAsync(client, scope, true)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await SwitchAsync(client, "nope", true)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await SwitchAsync(client, "notifications", false)).StatusCode);

        await GrantProAsync(admin, user);

        var on = await ApiClient.ReadJsonAsync(await SwitchAsync(client, "notifications", true), HttpStatusCode.OK);
        Assert.True(on.GetProperty("entitled").GetBoolean());
        Assert.Equal("Pro", on.GetProperty("planName").GetString());
        Assert.True(Item(on, "notifications").GetProperty("active").GetBoolean());

        var noKey = await ApiClient.ReadJsonAsync(await SwitchAsync(client, "sync", true), HttpStatusCode.Conflict);
        Assert.Equal("needs-key", noKey.GetProperty("code").GetString());

        await SetKeyAsync(client, scope);
        var sync = await ApiClient.ReadJsonAsync(await SwitchAsync(client, "sync", true), HttpStatusCode.OK);
        Assert.True(Item(sync, "sync").GetProperty("active").GetBoolean());
        Assert.False(Item(sync, "sync").GetProperty("needsKey").GetBoolean());
        Assert.True(await SealsEverythingAsync(client));

        // The other way in keeps the switch honest.
        Assert.Equal(HttpStatusCode.OK, (await PatchEverythingAsync(client, scope, false)).StatusCode);
        Assert.False(Item(await StatusAsync(client), "sync").GetProperty("enabled").GetBoolean());
    }

    [Fact]
    public async Task A_sealed_event_needs_the_plan_and_each_phone_gets_its_own_copy()
    {
        var admin = await AdminAsync();
        var (user, browser) = await AccountAsync(_factory);
        var desktop = TestPhones.BearerClient(_factory, await DeviceTokenAsync(_factory, browser));
        var phone = await TestPhones.SignInAsync(_factory, browser);
        Assert.Equal(
            HttpStatusCode.OK,
            (await phone.Client.PutAsJsonAsync("/api/v1/accounts/me/push-devices/current", new { platform = "android", pushToken = "fcm-1", sealKeyId = PhoneKey }, TestContext.Current.CancellationToken)).StatusCode);

        var sealedEvent = new { category = "deploys", itemId = "p1", sealedFor = new[] { new { keyId = PhoneKey, @sealed = "c2VhbGVk" } } };
        var refused = await ForwardAsync(desktop, sealedEvent, HttpStatusCode.Forbidden);
        Assert.Equal("plan-required", refused.GetProperty("code").GetString());
        using (var scope = _factory.Services.CreateScope())
        {
            Assert.Equal(0, await scope.ServiceProvider.GetRequiredService<AppDbContext>().UserNotifications.CountAsync(TestContext.Current.CancellationToken));
        }

        await GrantProAsync(admin, user);
        Assert.Equal(HttpStatusCode.OK, (await SwitchAsync(browser, "notifications", true)).StatusCode);
        var listeners = await ApiClient.ReadJsonAsync(await desktop.GetAsync("/api/v1/accounts/me/notification-listeners", TestContext.Current.CancellationToken), HttpStatusCode.OK);
        Assert.True(listeners.GetProperty("sealing").GetBoolean());

        await ForwardAsync(desktop, new { category = "deploys", subject = "web-1", sealedFor = Array.Empty<object>() }, HttpStatusCode.BadRequest);
        await ForwardAsync(desktop, sealedEvent, HttpStatusCode.Created);

        // The first push is the notice that the account is on Pro now.
        var withCopy = Assert.Single(await _push.WaitForAsync(2), d => d.Category == "deploys");
        Assert.Equal(PushContent.SealedLine, withCopy.Line);
        Assert.Equal("c2VhbGVk", withCopy.Sealed);

        // An empty list is still sealed: no copies kept, and every phone gets the generic line.
        await ForwardAsync(desktop, new { category = "deploys", sealedFor = Array.Empty<object>() }, HttpStatusCode.Created);
        var generic = (await _push.WaitForAsync(3)).Last(d => d.Category == "deploys");
        Assert.Equal(PushContent.SealedLine, generic.Line);
        Assert.Null(generic.Sealed);

        var inbox = await ApiClient.ReadJsonAsync(await phone.Client.GetAsync("/api/v1/notifications", TestContext.Current.CancellationToken), HttpStatusCode.OK);
        var items = inbox.GetProperty("items").EnumerateArray().Where(i => i.GetProperty("kind").GetString() == "deploys").ToList();
        Assert.Equal(2, items.Count);
        Assert.All(items, item =>
        {
            Assert.Equal(PushContent.SealedLine, item.GetProperty("title").GetString());
            Assert.Equal("", item.GetProperty("body").GetString());
            Assert.Equal(JsonValueKind.Null, item.GetProperty("severity").ValueKind);
        });
        Assert.Equal(0, items[0].GetProperty("sealed").GetArrayLength());
        Assert.Equal(PhoneKey, items[1].GetProperty("sealed")[0].GetProperty("keyId").GetString());
    }

    [Fact]
    public async Task A_downgrade_stops_sealing_and_keeps_the_choice_until_the_plan_is_back()
    {
        var admin = await AdminAsync();
        var (user, client) = await AccountAsync(_factory);
        await GrantProAsync(admin, user);
        await SetKeyAsync(client, await PersonalScopeAsync(client));
        Assert.Equal(HttpStatusCode.OK, (await SwitchAsync(client, "sync", true)).StatusCode);

        Assert.Equal(HttpStatusCode.NoContent, (await admin.SendAsync(HttpMethod.Delete, $"/api/v1/users/{user.Id}/subscriptions/current")).StatusCode);

        var lapsed = Item(await StatusAsync(client), "sync");
        Assert.True(lapsed.GetProperty("enabled").GetBoolean());
        Assert.False(lapsed.GetProperty("active").GetBoolean());
        Assert.True(lapsed.GetProperty("lapsed").GetBoolean());
        Assert.False(await SealsEverythingAsync(client));

        await GrantProAsync(admin, user);
        Assert.True(Item(await StatusAsync(client), "sync").GetProperty("active").GetBoolean());
        Assert.True(await SealsEverythingAsync(client));
    }
}
