using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR.Client;
using Runova.Website.Api.CloudMonitoring;
using Runova.Website.Api.Notifications;
using Runova.Website.IntegrationTests.Infrastructure;
using static Runova.Website.IntegrationTests.Infrastructure.TestCloudMonitors;
using static Runova.Website.IntegrationTests.Infrastructure.TestDependencies;

namespace Runova.Website.IntegrationTests.Monitoring;

/// <summary>An open app hears each result of its online monitors at once, and when their list changes (E55).</summary>
public sealed class CloudMonitorHubTests(PostgresFixture postgres) : IAsyncLifetime
{
    private readonly FakeNodeBus _bus = new();
    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync() => _factory = new(await postgres.CreateDatabaseAsync(), services: _bus.Register);

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
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
    public async Task A_result_and_a_new_monitor_reach_the_open_app()
    {
        var node = await OnlineNodeAsync(_factory, "eu-1", "eu-central", DateTimeOffset.UtcNow);
        var (_, browser) = await AccountAsync(_factory);
        var scope = await PersonalScopeAsync(browser);
        await using var hub = Connect(await DeviceTokenAsync(_factory, browser));
        var changed = new TaskCompletionSource<CloudMonitorsChangedDto>(TaskCreationOptions.RunContinuationsAsynchronously);
        var updated = new TaskCompletionSource<CloudMonitorLiveDto>(TaskCreationOptions.RunContinuationsAsynchronously);
        hub.On<CloudMonitorsChangedDto>(nameof(INotificationsClient.CloudMonitorsChanged), c => changed.TrySetResult(c));
        hub.On<CloudMonitorLiveDto>(nameof(INotificationsClient.CloudMonitorUpdated), m => updated.TrySetResult(m));
        await hub.StartAsync(TestContext.Current.CancellationToken);

        var id = await CreatedAsync(browser, Monitor(scope));
        Assert.Equal(scope, (await changed.Task.WaitAsync(TimeSpan.FromSeconds(15), TestContext.Current.CancellationToken)).ScopeId);

        await IngestAsync(_factory, node, Result(id, "pass", DateTimeOffset.UtcNow, latencyMs: 87));

        var live = await updated.Task.WaitAsync(TimeSpan.FromSeconds(15), TestContext.Current.CancellationToken);
        Assert.Equal(id, live.Id);
        Assert.Equal("t-api", live.ItemId);
        Assert.Equal("up", live.Status.Verdict);
        Assert.Equal(87, live.Status.LatencyMs);
        Assert.Equal("eu-central", live.Status.Region);
    }
}
