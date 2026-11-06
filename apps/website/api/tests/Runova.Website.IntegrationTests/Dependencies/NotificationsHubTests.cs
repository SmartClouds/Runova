using System.Net;
using System.Net.Http.Headers;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.Api.Dependencies;
using Runova.Website.Api.Notifications;
using Runova.Website.IntegrationTests.Infrastructure;
using static Runova.Website.IntegrationTests.Infrastructure.TestDependencies;

namespace Runova.Website.IntegrationTests.Dependencies;

/// <summary>The desktop app connects to the hub with its device token and hears each new message at once.</summary>
public sealed class NotificationsHubTests(PostgresFixture postgres) : IAsyncLifetime
{
    private readonly FakeTimeProvider _time = new(DateTimeOffset.UtcNow);
    private readonly FakePackageRegistries _registries = new();
    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync()
    {
        _factory = new WebsiteApiFactory(await postgres.CreateDatabaseAsync(), time: _time, services: services =>
        {
            _registries.Register(services);
            // Due at once, so the clock need not move while the app is connected.
            services.AddSingleton<CheckSchedule>(new FixedSchedule(_time, next: 0));
        });
        _registries.Has("npm", "lodash", "5.0.0");
    }

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    private HubConnection Connect(string? token) =>
        new HubConnectionBuilder()
            .WithUrl(new Uri(_factory.Server.BaseAddress, NotificationsHub.Path), options =>
            {
                options.HttpMessageHandlerFactory = _ => _factory.Server.CreateHandler();
                options.Transports = HttpTransportType.LongPolling;
                if (token is not null)
                {
                    options.AccessTokenProvider = () => Task.FromResult<string?>(token);
                }
            })
            .Build();

    [Fact]
    public async Task A_connected_app_hears_a_new_message_and_the_new_count()
    {
        var (_, browser) = await AccountAsync(_factory);
        var token = await DeviceTokenAsync(_factory, browser);
        await using var hub = Connect(token);
        var created = new TaskCompletionSource<UserNotificationDto>(TaskCreationOptions.RunContinuationsAsynchronously);
        var summary = new TaskCompletionSource<DependencySummaryDto>(TaskCreationOptions.RunContinuationsAsynchronously);
        hub.On<UserNotificationDto>(nameof(INotificationsClient.NotificationCreated), n => created.TrySetResult(n));
        hub.On<DependencySummaryDto>(nameof(INotificationsClient.DependencySummaryChanged), s => summary.TrySetResult(s));
        await hub.StartAsync(TestContext.Current.CancellationToken);
        await UploadedAsync(browser, await PersonalScopeAsync(browser), "p-shop", Inventory("Shop", Package("lodash", "4.17.20")));

        await RunChecksAsync(_factory);

        var notification = await created.Task.WaitAsync(TimeSpan.FromSeconds(20), TestContext.Current.CancellationToken);
        Assert.Equal("lodash 5.0.0 is out for Shop", notification.Title);
        Assert.Equal("p-shop", notification.ItemId);
        var counts = await summary.Task.WaitAsync(TimeSpan.FromSeconds(20), TestContext.Current.CancellationToken);
        Assert.Equal((1, 1), (counts.Total, counts.Projects));
    }

    [Fact]
    public async Task Another_accounts_app_hears_nothing()
    {
        var (_, sam) = await AccountAsync(_factory);
        var (_, kim) = await AccountAsync(_factory, "Kim");
        await using var hub = Connect(await DeviceTokenAsync(_factory, kim));
        var heard = 0;
        hub.On<UserNotificationDto>(nameof(INotificationsClient.NotificationCreated), _ => Interlocked.Increment(ref heard));
        await hub.StartAsync(TestContext.Current.CancellationToken);
        await UploadedAsync(sam, await PersonalScopeAsync(sam), "p-shop", Inventory("Shop", Package("lodash", "4.17.20")));

        await RunChecksAsync(_factory);
        await Task.Delay(500, TestContext.Current.CancellationToken);

        Assert.Equal(0, heard);
    }

    [Fact]
    public async Task No_token_or_a_made_up_one_can_not_connect()
    {
        await using var anonymous = Connect(null);
        await using var forged = Connect("rd1.not-a-real-token");

        await Assert.ThrowsAnyAsync<HttpRequestException>(() => anonymous.StartAsync(TestContext.Current.CancellationToken));
        await Assert.ThrowsAnyAsync<HttpRequestException>(() => forged.StartAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task The_token_may_come_in_the_query_on_the_hub_path_only()
    {
        var (_, browser) = await AccountAsync(_factory);
        var token = await DeviceTokenAsync(_factory, browser);
        var client = _factory.CreateClient();

        var negotiate = await client.PostAsync($"{NotificationsHub.Path}/negotiate?negotiateVersion=1&access_token={Uri.EscapeDataString(token)}", null, TestContext.Current.CancellationToken);
        var elsewhere = await client.GetAsync($"/api/v1/dependency-findings?access_token={Uri.EscapeDataString(token)}", TestContext.Current.CancellationToken);
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var withHeader = await client.GetAsync("/api/v1/dependency-findings", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, negotiate.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, elsewhere.StatusCode);
        Assert.Equal(HttpStatusCode.OK, withHeader.StatusCode);
    }

    [Fact]
    public async Task A_signed_out_computer_is_refused_at_once()
    {
        var (_, browser) = await AccountAsync(_factory);
        var token = await DeviceTokenAsync(_factory, browser);
        var bearer = _factory.CreateClient();
        bearer.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        Assert.Equal(HttpStatusCode.NoContent, (await bearer.DeleteAsync("/api/v1/sessions/current", TestContext.Current.CancellationToken)).StatusCode);

        await using var hub = Connect(token);

        await Assert.ThrowsAnyAsync<HttpRequestException>(() => hub.StartAsync(TestContext.Current.CancellationToken));
    }
}
