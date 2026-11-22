using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.Api.Accounts;
using Runova.Website.Api.CloudMonitoring;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Notifications;
using Runova.Website.Api.Remote;
using Runova.Website.Core.Accounts;
using Runova.Website.Core.Paging;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Accounts;

/// <summary>
/// What the demo account gets on every route the phone calls: mock data built from the real DTOs,
/// writes that answer as if they worked and change nothing, and a 403 everywhere else.
/// </summary>
public sealed class DemoAnswersTests(PostgresFixture postgres) : IAsyncLifetime
{
    private const string Team = "/api/v1/teams/-21";

    // Strict, so a mock that drifts from the real DTO fails here and not on the phone.
    private static readonly JsonSerializerOptions _strict = new(JsonSerializerOptions.Web)
    {
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };

    private readonly FakeTimeProvider _time = new(DateTimeOffset.UtcNow);
    private readonly DatabaseWrites _writes = new();
    private WebsiteApiFactory _factory = null!;
    private DemoDatabase _db = null!;
    private HttpClient _phone = null!;

    public async ValueTask InitializeAsync()
    {
        var database = await postgres.CreateDatabaseAsync();
        _factory = new WebsiteApiFactory(database, time: _time, services: _writes.Register);
        _db = new DemoDatabase(database, _writes);
        await _db.ReadyAsync(_factory);
        var tokens = await ApiClient.ReadJsonAsync(
            await _factory.CreateClient().PostAsJsonAsync(DemoRequests.Tokens, DemoRequests.Grant(), TestContext.Current.CancellationToken),
            HttpStatusCode.OK);
        _phone = DemoRequests.Bearer(_factory, tokens.GetProperty("accessToken").GetString()!);
        await _db.MarkAsync();
    }

    public ValueTask DisposeAsync()
    {
        _phone.Dispose();
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    /// <summary>Every read the phone makes, with the DTO it reads the answer as on the server.</summary>
    private static readonly (string Path, Type Dto)[] _reads =
    [
        ("/api/v1/accounts/me", typeof(AccountDto)),
        ("/api/v1/sessions", typeof(SessionListDto)),
        ("/api/v1/teams", typeof(TeamListDto)),
        (Team, typeof(TeamDto)),
        ($"{Team}/members", typeof(TeamMemberListDto)),
        ($"{Team}/invitations", typeof(TeamInvitationListDto)),
        ("/api/v1/invitations", typeof(MyInvitationListDto)),
        ("/api/v1/activities?page=1&pageSize=20", typeof(Page<ActivityDto>)),
        ("/api/v1/accounts/me/encryption-preferences", typeof(EncryptionDto)),
        ("/api/v1/notifications?page=1&pageSize=50", typeof(NotificationPageDto)),
        ("/api/v1/accounts/me/notification-preferences", typeof(NotificationPreferencesDto)),
        ("/api/v1/cloud-monitors", typeof(CloudMonitorListDto)),
        ("/api/v1/reachable-devices", typeof(RemoteDirectoryDto)),
    ];

    /// <summary>Every change the phone makes, as it sends it, with the status and DTO the real route answers.</summary>
    private static readonly (string Method, string Path, object? Body, HttpStatusCode Status, Type? Dto)[] _writesThePhoneMakes =
    [
        ("PATCH", "/api/v1/accounts/me", new { displayName = "Demo Reviewer" }, HttpStatusCode.OK, typeof(AccountDto)),
        ("DELETE", "/api/v1/sessions/-2", new { }, HttpStatusCode.NoContent, null),
        ("DELETE", "/api/v1/sessions", new { password = "anything" }, HttpStatusCode.NoContent, null),
        ("POST", $"{Team}/invitations", new { email = "kim@example.com", role = "member" }, HttpStatusCode.Created, typeof(TeamInvitationDto)),
        ("DELETE", $"{Team}/invitations/-41", new { }, HttpStatusCode.NoContent, null),
        ("PATCH", $"{Team}/members/-3", new { role = "viewer", password = "anything" }, HttpStatusCode.OK, typeof(TeamMemberDto)),
        ("DELETE", $"{Team}/members/-4", new { code = "123456" }, HttpStatusCode.NoContent, null),
        ("POST", "/api/v1/invitations/-42/acceptances", new { }, HttpStatusCode.Created, typeof(TeamDto)),
        ("DELETE", "/api/v1/invitations/-42", new { }, HttpStatusCode.NoContent, null),
        ("PUT", "/api/v1/accounts/me/encryption-preferences/sync", new { enabled = true }, HttpStatusCode.OK, typeof(EncryptionDto)),
        ("PATCH", "/api/v1/notifications/-101", new { read = true }, HttpStatusCode.OK, typeof(UserNotificationDto)),
        ("POST", "/api/v1/notification-read-markers", new { before = (DateTimeOffset?)null }, HttpStatusCode.Created, typeof(NotificationReadMarkerDto)),
        ("PUT", "/api/v1/accounts/me/notification-preferences/monitors", new { enabled = false }, HttpStatusCode.OK, typeof(NotificationPreferenceDto)),
        ("PUT", "/api/v1/accounts/me/push-devices/current", new { platform = "android", pushToken = "fcm-token-for-the-demo-phone", sealKeyId = (string?)null, accountTag = (string?)null }, HttpStatusCode.OK, typeof(PushDeviceDto)),
        ("PATCH", "/api/v1/cloud-monitors/-204", new { paused = false }, HttpStatusCode.OK, typeof(CloudMonitorDto)),
        ("POST", "/api/v1/remote-devices", new { deviceId = Guid.NewGuid(), name = "Pixel 9", platform = "android", identityKey = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" }, HttpStatusCode.Created, typeof(RemoteDeviceDto)),
        ("DELETE", "/api/v1/sessions/current", new { }, HttpStatusCode.NoContent, null),
    ];

    /// <summary>Sends as the phone does: <c>If-Match: *</c>, and a PATCH as a JSON merge patch.</summary>
    private Task<HttpResponseMessage> SendAsync(string method, string path, object? body, string? idempotencyKey = null)
    {
        var request = new HttpRequestMessage(new HttpMethod(method), path);
        if (body is not null)
        {
            request.Content = method == "PATCH"
                ? JsonContent.Create(body, new MediaTypeHeaderValue("application/merge-patch+json"))
                : JsonContent.Create(body);
        }

        request.Headers.TryAddWithoutValidation("If-Match", "*");
        if (idempotencyKey is not null)
        {
            request.Headers.Add("Idempotency-Key", idempotencyKey);
        }

        return _phone.SendAsync(request, TestContext.Current.CancellationToken);
    }

    private static async Task<object> ReadAsync(HttpResponseMessage response, HttpStatusCode status, Type dto, string what)
    {
        var body = await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        Assert.True(status == response.StatusCode, $"{what}: expected {(int)status}, got {(int)response.StatusCode}: {body}");
        Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);
        return JsonSerializer.Deserialize(body, dto, _strict) ?? throw new InvalidOperationException($"{what} answered null.");
    }

    [Fact]
    public async Task Every_read_the_phone_makes_answers_mock_data_in_the_real_shape()
    {
        foreach (var (path, dto) in _reads)
        {
            var response = await _phone.GetAsync(path, TestContext.Current.CancellationToken);

            await ReadAsync(response, HttpStatusCode.OK, dto, path);
            Assert.True(response.Headers.CacheControl is { Private: true, NoStore: true }, $"{path} is cached");
        }

        await _db.AssertUnchangedAsync();
    }

    [Fact]
    public async Task Every_change_the_phone_makes_answers_as_the_real_route_and_is_dropped()
    {
        foreach (var (method, path, body, status, dto) in _writesThePhoneMakes)
        {
            var response = await SendAsync(method, path, body);

            if (dto is null)
            {
                Assert.True(status == response.StatusCode, $"{method} {path}: expected {(int)status}, got {(int)response.StatusCode}: {await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken)}");
            }
            else
            {
                await ReadAsync(response, status, dto, $"{method} {path}");
            }
        }

        await _db.AssertUnchangedAsync();
    }

    [Fact]
    public async Task An_idempotency_key_keeps_nothing_either()
    {
        foreach (var (method, path, body, status, _) in _writesThePhoneMakes.Where(w => w.Method == "POST"))
        {
            var response = await SendAsync(method, path, body, idempotencyKey: Guid.NewGuid().ToString());

            Assert.Equal(status, response.StatusCode);
        }

        await _db.AssertUnchangedAsync();
    }

    [Fact]
    public async Task A_change_is_not_kept()
    {
        var renamed = (AccountDto)await ReadAsync(await SendAsync("PATCH", "/api/v1/accounts/me", new { displayName = "Demo Reviewer" }), HttpStatusCode.OK, typeof(AccountDto), "rename");
        var after = (AccountDto)await ReadAsync(await _phone.GetAsync("/api/v1/accounts/me", TestContext.Current.CancellationToken), HttpStatusCode.OK, typeof(AccountDto), "me");

        Assert.Equal("Demo Reviewer", renamed.DisplayName);
        Assert.Equal("Demo", after.DisplayName);
        await _db.AssertUnchangedAsync();
    }

    [Fact]
    public async Task A_bad_change_gets_the_real_route_s_validation_problem()
    {
        await ProblemAssert.IsAsync(await SendAsync("PATCH", "/api/v1/accounts/me", new { displayName = "" }), HttpStatusCode.BadRequest);
        await ProblemAssert.IsAsync(await SendAsync("POST", $"{Team}/invitations", new { email = "not an email", role = "member" }), HttpStatusCode.BadRequest);
        await ProblemAssert.IsAsync(await SendAsync("PATCH", $"{Team}/members/-3", new { role = "boss" }), HttpStatusCode.BadRequest);
        await ProblemAssert.IsAsync(await SendAsync("PUT", "/api/v1/accounts/me/notification-preferences/nothing", new { enabled = true }), HttpStatusCode.NotFound);
        await ProblemAssert.IsAsync(await _phone.GetAsync("/api/v1/teams/5/members", TestContext.Current.CancellationToken), HttpStatusCode.NotFound);
        await _db.AssertUnchangedAsync();
    }

    [Fact]
    public async Task The_account_and_the_computers_are_the_demo_ones()
    {
        var me = (AccountDto)await ReadAsync(await _phone.GetAsync("/api/v1/accounts/me", TestContext.Current.CancellationToken), HttpStatusCode.OK, typeof(AccountDto), "me");
        var reachable = (RemoteDirectoryDto)await ReadAsync(await _phone.GetAsync("/api/v1/reachable-devices", TestContext.Current.CancellationToken), HttpStatusCode.OK, typeof(RemoteDirectoryDto), "reachable");

        Assert.Equal((-1L, "Demo", "demo@runovahq.com", false), (me.Id, me.DisplayName, me.Email, me.Staff));
        Assert.Equal(["000000001", "000000002"], reachable.Mine.Select(d => d.RemoteId));
        Assert.Equal("000000003", Assert.Single(reachable.Teammates).RemoteId);
    }

    [Theory]
    [InlineData("POST", "/api/v1/teams")]
    [InlineData("GET", "/api/v1/users/me/passkeys")]
    [InlineData("DELETE", "/api/v1/accounts/me")]
    [InlineData("POST", "/api/v1/qr-sign-ins")]
    public async Task Any_other_account_route_is_refused_with_a_demo_problem(string method, string path)
    {
        var response = await SendAsync(method, path, new { name = "Something", password = "anything" });

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Forbidden, ProblemAssert.Type("demo-read-only"), path);
        Assert.Contains("demo", problem.GetProperty("detail").GetString(), StringComparison.OrdinalIgnoreCase);
        await _db.AssertUnchangedAsync();
    }

    [Fact]
    public void Every_account_route_is_either_answered_or_refused_for_the_demo()
    {
        var accountRoutes = _factory.Services.GetRequiredService<EndpointDataSource>().Endpoints
            .OfType<RouteEndpoint>()
            .Where(e => e.RoutePattern.RawText?.StartsWith("/api/v1/", StringComparison.Ordinal) == true)
            .Where(e => e.Metadata.GetMetadata<IAllowAnonymous>() is null)
            .Where(e => e.Metadata.GetOrderedMetadata<IAuthorizeData>().Any(a => a.Policy == Policies.Account))
            .SelectMany(e => (e.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods ?? ["*"]).Select(m => (m, e.RoutePattern.RawText!)))
            .ToHashSet();
        var answered = DemoAnswers.Answered.Keys.ToHashSet();
        var refused = DemoAnswers.Refused.ToHashSet();

        static string List(IEnumerable<(string, string)> routes) => string.Join(Environment.NewLine, routes.Order().Select(r => $"{r.Item1} {r.Item2}"));
        var unclassified = accountRoutes.Except(answered).Except(refused).ToList();
        var stale = answered.Union(refused).Except(accountRoutes).ToList();

        Assert.Empty(answered.Intersect(refused));
        Assert.True(unclassified.Count == 0, "Put each in DemoAnswers.Answered or DemoAnswers.Refused:" + Environment.NewLine + List(unclassified));
        Assert.True(stale.Count == 0, "No such account route:" + Environment.NewLine + List(stale));
    }
}
