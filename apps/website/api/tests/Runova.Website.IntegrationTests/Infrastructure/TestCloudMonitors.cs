using System.Net;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.Monitoring.Contracts;
using Runova.Website.Api.Monitoring;
using Runova.Website.Core.Identity;
using Runova.Website.Data;
using Runova.Website.Data.Dependencies;
using Runova.Website.Data.Monitoring;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>Nodes, online monitors and results for the E55 tests.</summary>
internal static class TestCloudMonitors
{
    public const string Url = "https://api.example.com/health";

    public static object Monitor(
        long scopeId,
        string itemId = "t-api",
        int intervalSec = 300,
        bool paused = false,
        string url = Url,
        bool notifyTelegram = false,
        string name = "API") => new
        {
            scopeId,
            itemId,
            name,
            projectName = "Storefront",
            environmentName = "Production",
            url,
            intervalSec,
            timeoutSec = 10,
            authMode = "bearer",
            secret = "s3cret-bearer-key",
            allowInsecure = false,
            paused,
            notifyInApp = true,
            notifyTelegram,
        };

    public static async Task<HttpResponseMessage> CreateAsync(ApiClient client, object monitor) =>
        await client.SendAsync(HttpMethod.Post, "/api/v1/cloud-monitors", monitor);

    /// <summary>Creates and returns the monitor's id.</summary>
    public static async Task<long> CreatedAsync(ApiClient client, object monitor)
    {
        var response = await CreateAsync(client, monitor);
        var body = await ApiClient.ReadJsonAsync(response, HttpStatusCode.Created);
        return body.GetProperty("id").GetInt64();
    }

    public static async Task<(JsonElement Body, string ETag)> ReadAsync(ApiClient client, long id)
    {
        var response = await client.GetAsync($"/api/v1/cloud-monitors/{id}");
        var body = await ApiClient.ReadJsonAsync(response, HttpStatusCode.OK);
        return (body, response.Headers.ETag!.Tag);
    }

    public static async Task<HttpResponseMessage> PatchAsync(ApiClient client, long id, object patch)
    {
        var (_, etag) = await ReadAsync(client, id);
        return await client.SendAsync(HttpMethod.Patch, $"/api/v1/cloud-monitors/{id}", patch, ifMatch: etag);
    }

    /// <summary>A node that is online now, as if it had enrolled and connected.</summary>
    public static async Task<long> OnlineNodeAsync(WebsiteApiFactory factory, string name, string region, DateTimeOffset now, int capacity = 100)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var node = new MonitoringNode
        {
            Name = name,
            Region = region,
            Capacity = capacity,
            Status = NodeStatuses.Online,
            EnrolledAt = now,
            ConnectedAt = now,
            LastSeenAt = now,
            GatewayId = "gw-1",
            CreatedAt = now,
        };
        db.MonitoringNodes.Add(node);
        await db.SaveChangesAsync();
        return node.Id;
    }

    public static async Task<T> WithDbAsync<T>(WebsiteApiFactory factory, Func<AppDbContext, Task<T>> run)
    {
        using var scope = factory.Services.CreateScope();
        return await run(scope.ServiceProvider.GetRequiredService<AppDbContext>());
    }

    public static Task<CloudMonitor> MonitorRowAsync(WebsiteApiFactory factory, long id) =>
        WithDbAsync(factory, db => db.CloudMonitors.AsNoTracking().SingleAsync(m => m.Id == id));

    public static Task<long?> AssignedNodeAsync(WebsiteApiFactory factory, long id) =>
        WithDbAsync(factory, db => db.CloudMonitorStatuses.AsNoTracking().Where(s => s.MonitorId == id).Select(s => s.NodeId).SingleAsync());

    public static CheckResultRecord Result(
        long monitorId,
        string state,
        DateTimeOffset at,
        long version = 1,
        string? confirmId = null,
        int? latencyMs = 120,
        string? problem = null,
        Guid? id = null) =>
        new(
            id ?? Guid.CreateVersion7(at),
            monitorId,
            version,
            at,
            state,
            state is "unreachable" ? null : state is "pass" or "warn" ? 200 : 503,
            state is "unreachable" ? null : latencyMs,
            problem ?? (state is "pass" ? null : "Connection refused"),
            [],
            confirmId);

    /// <summary>Hands a node's batch to the API as the Wolverine handler does.</summary>
    public static async Task<BatchStored> IngestAsync(WebsiteApiFactory factory, long nodeId, params CheckResultRecord[] results)
    {
        using var scope = factory.Services.CreateScope();
        var events = scope.ServiceProvider.GetRequiredService<NodeEvents>();
        return await events.ResultsAsync(new CheckResultBatch(nodeId, Guid.NewGuid().ToString(), results), TestContext.Current.CancellationToken);
    }

    public static async Task LinkTelegramAsync(WebsiteApiFactory factory, long userId, long chatId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        db.TelegramLinks.Add(new TelegramLink { UserId = userId, ChatId = chatId, ChatName = "sam", LinkedAt = DateTimeOffset.UtcNow });
        await db.SaveChangesAsync();
    }

    public static async Task<JsonElement[]> NotificationsAsync(ApiClient client) =>
        [.. (await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/notifications"), HttpStatusCode.OK)).GetProperty("items").EnumerateArray()];

    /// <summary>Gives the account a type, as an Admin does on its page.</summary>
    public static async Task GrantAsync(WebsiteApiFactory factory, long userId, long? accountTypeId)
    {
        var admin = await TestUsers.SignedInClientAsync(factory, await TestUsers.CreateAsync(factory.Services, Roles.Admin));
        var response = accountTypeId is null
            ? await admin.SendAsync(HttpMethod.Delete, $"/api/v1/users/{userId}/subscriptions/current")
            : await admin.SendAsync(HttpMethod.Put, $"/api/v1/users/{userId}/subscriptions/current", new { accountTypeId, endsAt = (DateTimeOffset?)null });
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
    }

    /// <summary>What a node connecting, a node going quiet or the minute job does: monitors move to where they should be.</summary>
    public static async Task RebalanceAsync(WebsiteApiFactory factory)
    {
        using var scope = factory.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<INodeRebalancer>().NodesChangedAsync(TestContext.Current.CancellationToken);
    }

    public const long Go = 2;
    public const long Pro = 3;
    public const long Ultra = 4;
}
