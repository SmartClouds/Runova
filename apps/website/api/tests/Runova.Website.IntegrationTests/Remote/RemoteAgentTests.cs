using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Microsoft.AspNetCore.SignalR;
using Runova.Website.Api.Remote;
using Runova.Website.IntegrationTests.Infrastructure;
using static Runova.Website.IntegrationTests.Infrastructure.TestDependencies;
using static Runova.Website.IntegrationTests.Infrastructure.TestRemote;

namespace Runova.Website.IntegrationTests.Remote;

/// <summary>
/// The background agent that keeps a computer reachable when no one is signed in to it (E64): its
/// owner turns it on from the app, it trades a one-time secret for a short token that reaches the
/// remote hub only, and it answers requests for its computer when the app is not there.
/// </summary>
public sealed class RemoteAgentTests(PostgresFixture postgres) : IAsyncLifetime
{
    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync() => _factory = new WebsiteApiFactory(await postgres.CreateDatabaseAsync());

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private async Task<(ApiClient Owner, System.Text.Json.JsonElement Device, string AgentKey, string Secret)> AgentOnAsync()
    {
        var (_, sam) = await AccountAsync(_factory);
        var device = await RegisterAsync(sam);
        var agentKey = NewIdentityKey();
        var created = await ApiClient.ReadJsonAsync(
            await sam.SendAsync(HttpMethod.Post, $"/api/v1/remote-devices/{device.GetProperty("id").GetInt64()}/agents", new { identityKey = agentKey }),
            HttpStatusCode.Created);
        return (sam, device, agentKey, created.GetProperty("agentSecret").GetString()!);
    }

    private async Task<HttpResponseMessage> TokenAsync(string remoteId, string secret) =>
        await _factory.CreateClient().PostAsJsonAsync("/api/v1/remote-agent-tokens", new { remoteId, secret }, Ct);

    private async Task<string> AgentTokenAsync(string remoteId, string secret) =>
        (await ApiClient.ReadJsonAsync(await TokenAsync(remoteId, secret), HttpStatusCode.OK)).GetProperty("accessToken").GetString()!;

    [Fact]
    public async Task The_owner_turns_the_agent_on_and_gets_its_secret_once()
    {
        var (sam, device, agentKey, secret) = await AgentOnAsync();

        var list = await ApiClient.ReadJsonAsync(await sam.GetAsync("/api/v1/remote-devices"), HttpStatusCode.OK);

        Assert.Matches("^ras1\\.[A-Za-z0-9_-]{43}$", secret);
        var listed = Assert.Single(list.GetProperty("items").EnumerateArray());
        Assert.Equal(agentKey, listed.GetProperty("agentIdentityKey").GetString());
        Assert.DoesNotContain(secret, list.GetRawText(), StringComparison.Ordinal);
        Assert.Equal(device.GetProperty("id").GetInt64(), listed.GetProperty("id").GetInt64());
    }

    [Fact]
    public async Task Someone_else_can_not_turn_on_an_agent_for_a_computer_that_is_not_theirs()
    {
        var (_, sam) = await AccountAsync(_factory);
        var (_, kim) = await AccountAsync(_factory, "Kim");
        var device = await RegisterAsync(sam);

        var response = await kim.SendAsync(HttpMethod.Post, $"/api/v1/remote-devices/{device.GetProperty("id").GetInt64()}/agents", new { identityKey = NewIdentityKey() });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task The_secret_buys_a_token_and_a_wrong_or_old_one_does_not()
    {
        var (sam, device, _, secret) = await AgentOnAsync();
        var remoteId = device.GetProperty("remoteId").GetString()!;

        var good = await TokenAsync(remoteId, secret);
        var wrong = await TokenAsync(remoteId, "ras1.not-the-secret");
        var otherId = await TokenAsync("999999999", secret);
        await sam.SendAsync(HttpMethod.Delete, $"/api/v1/remote-devices/{device.GetProperty("id").GetInt64()}/agents");
        var afterOff = await TokenAsync(remoteId, secret);

        var body = await ApiClient.ReadJsonAsync(good, HttpStatusCode.OK);
        Assert.StartsWith("ra1.", body.GetProperty("accessToken").GetString(), StringComparison.Ordinal);
        Assert.Equal(3600, body.GetProperty("expiresIn").GetInt32());
        Assert.Equal(HttpStatusCode.Unauthorized, wrong.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, otherId.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, afterOff.StatusCode);
    }

    [Fact]
    public async Task An_agent_token_opens_nothing_but_the_remote_hub()
    {
        var (_, device, _, secret) = await AgentOnAsync();
        var token = await AgentTokenAsync(device.GetProperty("remoteId").GetString()!, secret);
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);

        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/v1/remote-devices", Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/v1/accounts/me", Ct)).StatusCode);
        await using var agent = await ConnectAsync(_factory, token);
        await agent.GoOnlineAsync(device.GetProperty("id").GetInt64());
    }

    [Fact]
    public async Task An_agent_can_only_host_its_own_computer()
    {
        var (sam, device, _, secret) = await AgentOnAsync();
        var other = await RegisterAsync(sam, name: "Second computer");
        await using var agent = await ConnectAsync(_factory, await AgentTokenAsync(device.GetProperty("remoteId").GetString()!, secret));

        await Assert.ThrowsAsync<HubException>(() => agent.GoOnlineAsync(other.GetProperty("id").GetInt64()));
        await Assert.ThrowsAsync<HubException>(() => agent.RequestAsync(other.GetProperty("remoteId").GetString()!));
    }

    [Fact]
    public async Task With_the_app_away_the_agent_answers_with_its_own_key()
    {
        var (sam, device, agentKey, secret) = await AgentOnAsync();
        await UpdateAsync(sam, device.GetProperty("id").GetInt64(), new { allowOwnDevices = true });
        var laptop = await RegisterAsync(sam, name: "Laptop");
        await using var agent = await ConnectAsync(_factory, await AgentTokenAsync(device.GetProperty("remoteId").GetString()!, secret));
        await agent.GoOnlineAsync(device.GetProperty("id").GetInt64());
        await using var controller = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, sam));

        var result = await controller.RequestAsync(device.GetProperty("remoteId").GetString()!, "ask", laptop.GetProperty("id").GetInt64());
        var incoming = await RemoteApp.NextAsync(agent.Incoming);

        Assert.Equal("ringing", result.Status);
        Assert.Equal("agent", result.Host!.Kind);
        Assert.Equal(agentKey, result.Host.IdentityKey);
        Assert.Equal("own", incoming.Relation);
    }

    [Fact]
    public async Task With_the_app_online_the_app_answers()
    {
        var (sam, device, _, secret) = await AgentOnAsync();
        var laptop = await RegisterAsync(sam, name: "Laptop");
        await using var agent = await ConnectAsync(_factory, await AgentTokenAsync(device.GetProperty("remoteId").GetString()!, secret));
        await agent.GoOnlineAsync(device.GetProperty("id").GetInt64());
        await using var app = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, sam));
        await app.GoOnlineAsync(device.GetProperty("id").GetInt64());
        await using var controller = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, sam));

        var result = await controller.RequestAsync(device.GetProperty("remoteId").GetString()!, "ask", laptop.GetProperty("id").GetInt64());

        Assert.Equal("app", result.Host!.Kind);
        Assert.Equal(device.GetProperty("identityKey").GetString(), result.Host.IdentityKey);
        Assert.NotNull(await RemoteApp.NextAsync(app.Incoming));
        await RemoteApp.NothingAsync(agent.Incoming);
    }

    [Fact]
    public async Task Turning_the_agent_off_takes_it_offline()
    {
        var (sam, device, _, secret) = await AgentOnAsync();
        var laptop = await RegisterAsync(sam, name: "Laptop");
        await using var agent = await ConnectAsync(_factory, await AgentTokenAsync(device.GetProperty("remoteId").GetString()!, secret));
        await agent.GoOnlineAsync(device.GetProperty("id").GetInt64());

        Assert.Equal(HttpStatusCode.NoContent, (await sam.SendAsync(HttpMethod.Delete, $"/api/v1/remote-devices/{device.GetProperty("id").GetInt64()}/agents")).StatusCode);
        await using var controller = await ConnectAsync(_factory, await DeviceTokenAsync(_factory, sam));
        var result = await controller.RequestAsync(device.GetProperty("remoteId").GetString()!, "ask", laptop.GetProperty("id").GetInt64());

        Assert.Equal("offline", result.Status);
    }
}
