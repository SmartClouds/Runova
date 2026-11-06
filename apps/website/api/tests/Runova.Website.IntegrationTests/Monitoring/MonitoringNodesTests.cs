using System.Net;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Runova.Monitoring.Contracts;
using Runova.Monitoring.Contracts.Grpc;
using Runova.Website.Core.Identity;
using Runova.Website.Data;
using Runova.Website.Data.Monitoring;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Monitoring;

/// <summary>Monitoring nodes (E54): Admins add and revoke them; a node enrolls with its one-time token.</summary>
public sealed class MonitoringNodesTests(PostgresFixture postgres) : IAsyncLifetime
{
    private const string Path = "/api/v1/monitoring-nodes";
    private const string Enrollments = "/api/v1/monitoring-node-enrollments";

    private readonly FakeTimeProvider _clock = new(new DateTimeOffset(2026, 11, 6, 12, 0, 0, TimeSpan.Zero));
    private readonly FakeNodeBus _bus = new();
    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync() => _factory = await FactoryAsync(withGateway: true);

    private async Task<WebsiteApiFactory> FactoryAsync(bool withGateway) => new(
        await postgres.CreateDatabaseAsync(),
        time: _clock,
        settings: withGateway ? new Dictionary<string, string> { ["Monitoring:GatewayAddress"] = "https://nodes.runovahq.test" } : null,
        services: _bus.Register);

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    private async Task<ApiClient> AdminAsync() =>
        await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services, Roles.Admin));

    private static async Task<(long Id, string Token)> CreateNodeAsync(ApiClient admin, string name = "eu-1", string region = "eu-central")
    {
        var response = await admin.SendAsync(HttpMethod.Post, Path, new { name, region });
        var body = await ApiClient.ReadJsonAsync(response, HttpStatusCode.Created);
        return (body.GetProperty("node").GetProperty("id").GetInt64(), body.GetProperty("enrollment").GetProperty("token").GetString()!);
    }

    private Task<HttpResponseMessage> EnrollAsync(string token, byte[] csr) =>
        _factory.CreateApiClient().SendAsync(HttpMethod.Post, Enrollments, new { token, csr = Convert.ToBase64String(csr) });

    private async Task<T> InDbAsync<T>(Func<AppDbContext, Task<T>> read)
    {
        using var scope = _factory.Services.CreateScope();
        return await read(scope.ServiceProvider.GetRequiredService<AppDbContext>());
    }

    [Fact]
    public async Task An_admin_adds_a_node_and_gets_a_one_time_token_once()
    {
        var admin = await AdminAsync();

        var response = await admin.SendAsync(HttpMethod.Post, Path, new { name = "eu-1", region = "eu-central", capacity = 200 });
        var body = await ApiClient.ReadJsonAsync(response, HttpStatusCode.Created);

        var node = body.GetProperty("node");
        Assert.Equal("pending", node.GetProperty("status").GetString());
        Assert.Equal(200, node.GetProperty("capacity").GetInt32());
        Assert.StartsWith("rnn_", body.GetProperty("enrollment").GetProperty("token").GetString(), StringComparison.Ordinal);
        Assert.Equal(_clock.GetUtcNow().AddHours(24), body.GetProperty("enrollment").GetProperty("expiresAt").GetDateTimeOffset());

        var listed = await ApiClient.ReadJsonAsync(await admin.GetAsync(Path), HttpStatusCode.OK);
        var row = Assert.Single(listed.EnumerateArray());
        Assert.False(row.TryGetProperty("token", out _));
        Assert.False(row.TryGetProperty("enrollmentTokenHash", out _));
        Assert.True(await InDbAsync(db => db.AuditEntries.AnyAsync(e => e.Action == "monitoring-node.create")));
    }

    [Fact]
    public async Task Only_admins_see_nodes()
    {
        var editor = await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services, Roles.Editor));
        var account = await TestAccounts.SignedInClientAsync(_factory, await TestAccounts.CreateAsync(_factory.Services));

        Assert.Equal(HttpStatusCode.Forbidden, (await editor.GetAsync(Path)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await account.GetAsync(Path)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await _factory.CreateApiClient().GetAsync(Path)).StatusCode);
    }

    [Theory]
    [InlineData("""{ "region": "eu" }""", "name")]
    [InlineData("""{ "name": "x" }""", "region")]
    [InlineData("""{ "name": "x", "region": "EU Central" }""", "region")]
    [InlineData("""{ "name": "x", "region": "eu", "capacity": 0 }""", "capacity")]
    [InlineData("""{ "name": "x", "region": "eu", "allowedAddresses": ["not-an-ip"] }""", "allowedAddresses")]
    public async Task A_bad_node_is_refused_with_the_field(string json, string field)
    {
        var admin = await AdminAsync();

        var response = await admin.SendAsync(HttpMethod.Post, Path, JsonDocument.Parse(json).RootElement);

        var problem = await ApiClient.ReadJsonAsync(response, HttpStatusCode.BadRequest);
        Assert.True(problem.GetProperty("errors").TryGetProperty(field, out _));
    }

    [Fact]
    public async Task A_node_enrolls_with_its_token_and_gets_a_seven_day_client_certificate()
    {
        var (id, token) = await CreateNodeAsync(await AdminAsync());
        var (key, csr) = TestNodeKeys.NewCsr();

        var body = await ApiClient.ReadJsonAsync(await EnrollAsync(token, csr), HttpStatusCode.Created);

        Assert.Equal(id, body.GetProperty("nodeId").GetInt64());
        Assert.Equal("https://nodes.runovahq.test", body.GetProperty("gatewayAddress").GetString());
        using var certificate = X509CertificateLoader.LoadCertificate(Convert.FromBase64String(body.GetProperty("certificate").GetString()!));
        using var ca = X509CertificateLoader.LoadCertificate(Convert.FromBase64String(body.GetProperty("caCertificates")[0].GetString()!));
        Assert.Equal(id, NodeCertificates.NodeIdOf(certificate));
        Assert.Equal(_clock.GetUtcNow().AddDays(7).UtcDateTime, certificate.NotAfter.ToUniversalTime(), TimeSpan.FromSeconds(1));
        Assert.Contains(certificate.Extensions.OfType<X509EnhancedKeyUsageExtension>().Single().EnhancedKeyUsages.Cast<System.Security.Cryptography.Oid>(),
            oid => oid.Value == "1.3.6.1.5.5.7.3.2");
        Assert.True(certificate.Extensions.OfType<X509BasicConstraintsExtension>().Single() is { CertificateAuthority: false });
        Assert.Equal(key.ExportSubjectPublicKeyInfo(), certificate.PublicKey.ExportSubjectPublicKeyInfo());

        using var chain = new X509Chain();
        chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
        chain.ChainPolicy.CustomTrustStore.Add(ca);
        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        chain.ChainPolicy.VerificationTime = _clock.GetUtcNow().UtcDateTime;
        Assert.True(chain.Build(certificate));

        var node = await InDbAsync(db => db.MonitoringNodes.SingleAsync(n => n.Id == id));
        Assert.Equal(NodeStatuses.Offline, node.Status);
        Assert.Null(node.EnrollmentTokenHash);
        Assert.Equal(certificate.SerialNumber, (await InDbAsync(db => db.NodeCertificates.SingleAsync())).Serial);
    }

    [Fact]
    public async Task An_enrollment_token_works_once()
    {
        var (_, token) = await CreateNodeAsync(await AdminAsync());

        Assert.Equal(HttpStatusCode.Created, (await EnrollAsync(token, TestNodeKeys.NewCsr().Csr)).StatusCode);
        var again = await EnrollAsync(token, TestNodeKeys.NewCsr().Csr);

        await ProblemAssert.IsProblemAsync(again, HttpStatusCode.Unauthorized, ProblemAssert.Type("unauthorized"), Enrollments);
    }

    [Fact]
    public async Task An_enrollment_token_runs_out_after_24_hours()
    {
        var (_, token) = await CreateNodeAsync(await AdminAsync());

        _clock.Advance(TimeSpan.FromHours(24) + TimeSpan.FromSeconds(1));
        var response = await EnrollAsync(token, TestNodeKeys.NewCsr().Csr);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task A_weak_key_or_a_request_that_is_not_one_is_refused_and_keeps_the_token()
    {
        var (_, token) = await CreateNodeAsync(await AdminAsync());

        var weak = await ApiClient.ReadJsonAsync(await EnrollAsync(token, TestNodeKeys.WeakRsaCsr()), HttpStatusCode.BadRequest);
        var junk = await ApiClient.ReadJsonAsync(await EnrollAsync(token, [1, 2, 3, 4]), HttpStatusCode.BadRequest);

        Assert.Contains("too weak", weak.GetProperty("errors").GetProperty("csr")[0].GetString(), StringComparison.Ordinal);
        Assert.True(junk.GetProperty("errors").TryGetProperty("csr", out _));
        Assert.Equal(HttpStatusCode.Created, (await EnrollAsync(token, TestNodeKeys.NewCsr().Csr)).StatusCode);
    }

    [Fact]
    public async Task Enrollment_is_off_without_a_gateway_address()
    {
        _factory.Dispose();
        _factory = await FactoryAsync(withGateway: false);
        var (_, token) = await CreateNodeAsync(await AdminAsync());

        var response = await EnrollAsync(token, TestNodeKeys.NewCsr().Csr);

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
    }

    [Fact]
    public async Task Enrolling_again_gives_up_the_old_certificate()
    {
        var admin = await AdminAsync();
        var (id, token) = await CreateNodeAsync(admin);
        await EnrollAsync(token, TestNodeKeys.NewCsr().Csr);
        var first = await InDbAsync(db => db.NodeCertificates.SingleAsync());

        var fresh = await ApiClient.ReadJsonAsync(await admin.SendAsync(HttpMethod.Post, $"{Path}/{id}/enrollment-tokens"), HttpStatusCode.Created);
        await EnrollAsync(fresh.GetProperty("token").GetString()!, TestNodeKeys.NewCsr().Csr);

        var old = await InDbAsync(db => db.NodeCertificates.SingleAsync(c => c.Serial == first.Serial));
        Assert.NotNull(old.RevokedAt);
        var (nodeId, serials) = Assert.Single(_bus.Revoked);
        Assert.Equal(id, nodeId);
        Assert.Equal([first.Serial], serials);
    }

    [Fact]
    public async Task Revoking_refuses_the_certificates_closes_the_stream_and_stops_new_tokens()
    {
        var admin = await AdminAsync();
        var (id, token) = await CreateNodeAsync(admin);
        await EnrollAsync(token, TestNodeKeys.NewCsr().Csr);

        var body = await ApiClient.ReadJsonAsync(await admin.SendAsync(HttpMethod.Post, $"{Path}/{id}/revocations"), HttpStatusCode.OK);

        Assert.Equal("revoked", body.GetProperty("status").GetString());
        Assert.NotNull(await InDbAsync(db => db.NodeCertificates.Select(c => c.RevokedAt).SingleAsync()));
        var (nodeId, serials) = Assert.Single(_bus.Revoked);
        Assert.Equal(id, nodeId);
        Assert.Single(serials);
        Assert.Equal(HttpStatusCode.Conflict, (await admin.SendAsync(HttpMethod.Post, $"{Path}/{id}/enrollment-tokens")).StatusCode);
        Assert.True(await InDbAsync(db => db.AuditEntries.AnyAsync(e => e.Action == "monitoring-node.revoke")));
    }

    [Fact]
    public async Task A_token_made_before_a_revoke_no_longer_works()
    {
        var admin = await AdminAsync();
        var (id, token) = await CreateNodeAsync(admin);

        await admin.SendAsync(HttpMethod.Post, $"{Path}/{id}/revocations");

        Assert.Equal(HttpStatusCode.Unauthorized, (await EnrollAsync(token, TestNodeKeys.NewCsr().Csr)).StatusCode);
    }

    [Fact]
    public async Task Draining_an_online_node_tells_it_to_stop_and_undraining_sends_its_monitors()
    {
        var admin = await AdminAsync();
        var (id, _) = await CreateNodeAsync(admin);
        await InDbAsync(async db =>
        {
            var node = await db.MonitoringNodes.SingleAsync(n => n.Id == id);
            node.Status = NodeStatuses.Online;
            node.LastSeenAt = _clock.GetUtcNow();
            return await db.SaveChangesAsync();
        });
        var etag = (await admin.GetAsync($"{Path}/{id}")).Headers.ETag!.Tag;

        var drained = await admin.SendAsync(HttpMethod.Patch, $"{Path}/{id}", new { draining = true }, ifMatch: etag);
        var drainedBody = await ApiClient.ReadJsonAsync(drained, HttpStatusCode.OK);
        var undrained = await admin.SendAsync(HttpMethod.Patch, $"{Path}/{id}", new { draining = false }, ifMatch: drained.Headers.ETag!.Tag);

        Assert.True(drainedBody.GetProperty("draining").GetBoolean());
        Assert.Equal(HttpStatusCode.OK, undrained.StatusCode);
        var kinds = _bus.Sent.Select(s => s.Message.BodyCase).ToList();
        Assert.Equal([ServerMessage.BodyOneofCase.Drain, ServerMessage.BodyOneofCase.Snapshot], kinds);
        Assert.True(await InDbAsync(db => db.AuditEntries.AnyAsync(e => e.Action == "monitoring-node.drain")));
    }

    [Fact]
    public async Task A_change_needs_the_current_version()
    {
        var admin = await AdminAsync();
        var (id, _) = await CreateNodeAsync(admin);

        var missing = await admin.SendAsync(HttpMethod.Patch, $"{Path}/{id}", new { name = "eu-2" });
        var stale = await admin.SendAsync(HttpMethod.Patch, $"{Path}/{id}", new { name = "eu-2" }, ifMatch: "\"1\"");

        Assert.Equal(HttpStatusCode.PreconditionRequired, missing.StatusCode);
        Assert.Equal(HttpStatusCode.PreconditionFailed, stale.StatusCode);
    }

    [Fact]
    public async Task Only_a_node_that_never_enrolled_or_was_revoked_can_be_removed()
    {
        var admin = await AdminAsync();
        var (pending, _) = await CreateNodeAsync(admin, "pending");
        var (enrolled, token) = await CreateNodeAsync(admin, "enrolled");
        await EnrollAsync(token, TestNodeKeys.NewCsr().Csr);

        var refused = await admin.SendAsync(HttpMethod.Delete, $"{Path}/{enrolled}", ifMatch: (await admin.GetAsync($"{Path}/{enrolled}")).Headers.ETag!.Tag);
        var removed = await admin.SendAsync(HttpMethod.Delete, $"{Path}/{pending}", ifMatch: (await admin.GetAsync($"{Path}/{pending}")).Headers.ETag!.Tag);

        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, removed.StatusCode);
    }

    [Fact]
    public async Task A_node_silent_for_45_seconds_shows_offline()
    {
        var admin = await AdminAsync();
        var (id, _) = await CreateNodeAsync(admin);
        await InDbAsync(async db =>
        {
            var node = await db.MonitoringNodes.SingleAsync(n => n.Id == id);
            node.Status = NodeStatuses.Online;
            node.LastSeenAt = _clock.GetUtcNow();
            return await db.SaveChangesAsync();
        });

        _clock.Advance(TimeSpan.FromSeconds(44));
        var before = await ApiClient.ReadJsonAsync(await admin.GetAsync($"{Path}/{id}"), HttpStatusCode.OK);
        _clock.Advance(TimeSpan.FromSeconds(2));
        var after = await ApiClient.ReadJsonAsync(await admin.GetAsync($"{Path}/{id}"), HttpStatusCode.OK);

        Assert.Equal("online", before.GetProperty("status").GetString());
        Assert.Equal("offline", after.GetProperty("status").GetString());
    }
}
