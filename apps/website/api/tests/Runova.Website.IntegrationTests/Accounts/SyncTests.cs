using System.Net;
using System.Text.Json;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Accounts;

public sealed class SyncTests(PostgresFixture postgres) : IDisposable
{
    private readonly WebsiteApiFactory _factory = new(postgres.ConnectionString);

    public void Dispose() => _factory.Dispose();

    private static object Record(string itemId, long baseRevision, string payload = """{"v":1,"shared":{"name":"Shop"},"sealed":null}""", string collection = "projects", bool deleted = false, string encryption = "none", int? keyVersion = null) =>
        new { collection, itemId, baseRevision, deleted, encryption, keyVersion, payload = deleted ? null : payload };

    private static async Task<long> PersonalScopeAsync(ApiClient client)
    {
        var scopes = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/sync-scopes"), HttpStatusCode.OK);
        return scopes.GetProperty("items").EnumerateArray().Single(s => s.GetProperty("kind").GetString() == "personal").GetProperty("id").GetInt64();
    }

    private static async Task<JsonElement> PushAsync(ApiClient client, long scope, params object[] records) =>
        await ApiClient.ReadJsonAsync(await client.SendAsync(HttpMethod.Post, $"/api/v1/sync-scopes/{scope}/records", new { records }), HttpStatusCode.OK);

    private static async Task<JsonElement> ChangesAsync(ApiClient client, long scope, long since = 0, int limit = 100) =>
        await ApiClient.ReadJsonAsync(await client.GetAsync($"/api/v1/sync-scopes/{scope}/changes?since={since}&limit={limit}"), HttpStatusCode.OK);

    [Fact]
    public async Task An_account_has_one_personal_scope_with_no_key_yet()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var client = await TestAccounts.SignedInClientAsync(_factory, user);

        var first = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/sync-scopes"), HttpStatusCode.OK);
        var again = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/sync-scopes"), HttpStatusCode.OK);

        var scope = Assert.Single(first.GetProperty("items").EnumerateArray());
        Assert.Equal("personal", scope.GetProperty("kind").GetString());
        Assert.True(scope.GetProperty("canWrite").GetBoolean());
        Assert.Equal(JsonValueKind.Null, scope.GetProperty("keyVersion").ValueKind);
        Assert.Equal(0, scope.GetProperty("latestRevision").GetInt64());
        Assert.False(scope.GetProperty("policy").GetProperty("everything").GetBoolean());
        Assert.Equal(scope.GetProperty("id").GetInt64(), Assert.Single(again.GetProperty("items").EnumerateArray()).GetProperty("id").GetInt64());
    }

    [Fact]
    public async Task Pushed_records_come_back_in_the_changes_feed_in_order()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var client = await TestAccounts.SignedInClientAsync(_factory, user);
        var scope = await PersonalScopeAsync(client);

        var pushed = await PushAsync(client, scope, Record("a", 0), Record("b", 0));
        var changes = await ChangesAsync(client, scope);

        Assert.Equal([1L, 2L], pushed.GetProperty("accepted").EnumerateArray().Select(a => a.GetProperty("revision").GetInt64()));
        Assert.Empty(pushed.GetProperty("conflicts").EnumerateArray());
        var records = changes.GetProperty("records").EnumerateArray().ToList();
        Assert.Equal(["a", "b"], records.Select(r => r.GetProperty("itemId").GetString()));
        Assert.Equal("""{"v":1,"shared":{"name":"Shop"},"sealed":null}""", records[0].GetProperty("payload").GetString());
        Assert.Equal(2, changes.GetProperty("next").GetInt64());
        Assert.False(changes.GetProperty("more").GetBoolean());
    }

    [Fact]
    public async Task The_feed_pages_with_a_cursor()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var client = await TestAccounts.SignedInClientAsync(_factory, user);
        var scope = await PersonalScopeAsync(client);
        await PushAsync(client, scope, Record("a", 0), Record("b", 0), Record("c", 0));

        var first = await ChangesAsync(client, scope, 0, 2);
        var second = await ChangesAsync(client, scope, first.GetProperty("next").GetInt64(), 2);

        Assert.True(first.GetProperty("more").GetBoolean());
        Assert.Equal(["c"], second.GetProperty("records").EnumerateArray().Select(r => r.GetProperty("itemId").GetString()));
        Assert.False(second.GetProperty("more").GetBoolean());
    }

    [Fact]
    public async Task A_stale_base_revision_comes_back_as_a_conflict_with_the_server_copy()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var client = await TestAccounts.SignedInClientAsync(_factory, user);
        var scope = await PersonalScopeAsync(client);
        await PushAsync(client, scope, Record("a", 0, """{"v":1,"shared":{"name":"First"},"sealed":null}"""));
        await PushAsync(client, scope, Record("a", 1, """{"v":1,"shared":{"name":"Second"},"sealed":null}"""));

        var stale = await PushAsync(client, scope, Record("a", 1, """{"v":1,"shared":{"name":"Late"},"sealed":null}"""), Record("b", 0));

        var conflict = Assert.Single(stale.GetProperty("conflicts").EnumerateArray());
        Assert.Equal(2, conflict.GetProperty("revision").GetInt64());
        Assert.Contains("Second", conflict.GetProperty("payload").GetString(), StringComparison.Ordinal);
        Assert.Equal(["b"], stale.GetProperty("accepted").EnumerateArray().Select(a => a.GetProperty("itemId").GetString()));
    }

    [Fact]
    public async Task A_delete_keeps_a_tombstone_in_the_feed()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var client = await TestAccounts.SignedInClientAsync(_factory, user);
        var scope = await PersonalScopeAsync(client);
        await PushAsync(client, scope, Record("a", 0));

        await PushAsync(client, scope, Record("a", 1, deleted: true));

        var record = Assert.Single((await ChangesAsync(client, scope, 1)).GetProperty("records").EnumerateArray());
        Assert.True(record.GetProperty("deleted").GetBoolean());
        Assert.Equal(JsonValueKind.Null, record.GetProperty("payload").ValueKind);
    }

    [Fact]
    public async Task Another_account_can_not_read_or_write_the_scope()
    {
        var owner = await TestAccounts.CreateAsync(_factory.Services);
        var stranger = await TestAccounts.CreateAsync(_factory.Services);
        var ownerClient = await TestAccounts.SignedInClientAsync(_factory, owner);
        var strangerClient = await TestAccounts.SignedInClientAsync(_factory, stranger);
        var scope = await PersonalScopeAsync(ownerClient);

        var read = await strangerClient.GetAsync($"/api/v1/sync-scopes/{scope}/changes?since=0");
        var write = await strangerClient.SendAsync(HttpMethod.Post, $"/api/v1/sync-scopes/{scope}/records", new { records = new[] { Record("x", 0) } });

        Assert.Equal(HttpStatusCode.NotFound, read.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, write.StatusCode);
    }

    [Theory]
    [InlineData("Projects", "a")]
    [InlineData("projects", "")]
    [InlineData("projects", "has spaces")]
    public async Task A_bad_collection_or_item_id_is_refused(string collection, string itemId)
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var client = await TestAccounts.SignedInClientAsync(_factory, user);
        var scope = await PersonalScopeAsync(client);

        var response = await client.SendAsync(HttpMethod.Post, $"/api/v1/sync-scopes/{scope}/records", new { records = new[] { Record(itemId, 0, collection: collection) } });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task A_record_over_a_megabyte_is_refused()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var client = await TestAccounts.SignedInClientAsync(_factory, user);
        var scope = await PersonalScopeAsync(client);
        var big = new string('x', 1_100_000);

        var response = await client.SendAsync(HttpMethod.Post, $"/api/v1/sync-scopes/{scope}/records", new { records = new[] { Record("a", 0, $$"""{"v":1,"shared":{"blob":"{{big}}"},"sealed":null}""") } });

        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
    }

    [Fact]
    public async Task A_key_is_set_once_its_passphrase_can_change_and_a_new_version_rotates_it()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var client = await TestAccounts.SignedInClientAsync(_factory, user);
        var scope = await PersonalScopeAsync(client);
        var envelope = new { version = 1, passphrase = new { iv = "a", authTag = "b", ciphertext = "c" }, recovery = new { iv = "d", authTag = "e", ciphertext = "f", salt = "g" } };

        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"/api/v1/sync-scopes/{scope}/keys/current")).StatusCode);
        var set = await client.SendAsync(HttpMethod.Put, $"/api/v1/sync-scopes/{scope}/keys/current", new { version = 1, envelope });
        var read = await ApiClient.ReadJsonAsync(await client.GetAsync($"/api/v1/sync-scopes/{scope}/keys/current"), HttpStatusCode.OK);
        var rewrap = await client.SendAsync(HttpMethod.Put, $"/api/v1/sync-scopes/{scope}/keys/current", new { version = 1, envelope });
        var skip = await client.SendAsync(HttpMethod.Put, $"/api/v1/sync-scopes/{scope}/keys/current", new { version = 3, envelope });
        var rotate = await client.SendAsync(HttpMethod.Put, $"/api/v1/sync-scopes/{scope}/keys/current", new { version = 2, envelope });

        Assert.Equal(HttpStatusCode.OK, set.StatusCode);
        Assert.Equal(1, read.GetProperty("version").GetInt32());
        Assert.Equal("c", read.GetProperty("envelope").GetProperty("passphrase").GetProperty("ciphertext").GetString());
        Assert.Equal(HttpStatusCode.OK, rewrap.StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, skip.StatusCode);
        Assert.Equal(HttpStatusCode.OK, rotate.StatusCode);
        var scopes = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/sync-scopes"), HttpStatusCode.OK);
        Assert.Equal(2, scopes.GetProperty("items")[0].GetProperty("keyVersion").GetInt32());
    }

    [Fact]
    public async Task A_sealed_record_must_use_the_current_key_version()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var client = await TestAccounts.SignedInClientAsync(_factory, user);
        var scope = await PersonalScopeAsync(client);
        await client.SendAsync(HttpMethod.Put, $"/api/v1/sync-scopes/{scope}/keys/current", new { version = 1, envelope = new { version = 1 } });

        var stale = await client.SendAsync(HttpMethod.Post, $"/api/v1/sync-scopes/{scope}/records", new { records = new[] { Record("a", 0, """{"v":1,"shared":null,"sealed":"v1.x.y.z"}""", encryption: "e2ee", keyVersion: 7) } });
        var current = await client.SendAsync(HttpMethod.Post, $"/api/v1/sync-scopes/{scope}/records", new { records = new[] { Record("a", 0, """{"v":1,"shared":null,"sealed":"v1.x.y.z"}""", encryption: "e2ee", keyVersion: 1) } });

        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
        Assert.Equal(HttpStatusCode.OK, current.StatusCode);
    }

    [Fact]
    public async Task Resetting_the_key_needs_a_step_up_drops_sealed_records_and_starts_a_new_epoch()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var client = await TestAccounts.SignedInClientAsync(_factory, user);
        var scope = await PersonalScopeAsync(client);
        await client.SendAsync(HttpMethod.Put, $"/api/v1/sync-scopes/{scope}/keys/current", new { version = 1, envelope = new { version = 1 } });
        await PushAsync(client, scope, Record("plain", 0), Record("sealed", 0, """{"v":1,"shared":null,"sealed":"v1.x.y.z"}""", encryption: "e2ee", keyVersion: 1));
        var before = (await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/sync-scopes"), HttpStatusCode.OK)).GetProperty("items")[0].GetProperty("epoch").GetInt32();

        var wrong = await client.SendAsync(HttpMethod.Delete, $"/api/v1/sync-scopes/{scope}/keys/current", new { password = "nope nope nope", code = (string?)null });
        var right = await client.SendAsync(HttpMethod.Delete, $"/api/v1/sync-scopes/{scope}/keys/current", new { password = TestAccounts.Password, code = (string?)null });

        Assert.Equal(HttpStatusCode.BadRequest, wrong.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, right.StatusCode);
        var after = (await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/sync-scopes"), HttpStatusCode.OK)).GetProperty("items")[0];
        Assert.Equal(JsonValueKind.Null, after.GetProperty("keyVersion").ValueKind);
        Assert.Equal(before + 1, after.GetProperty("epoch").GetInt32());
        Assert.Equal(["plain"], (await ChangesAsync(client, scope)).GetProperty("records").EnumerateArray().Select(r => r.GetProperty("itemId").GetString()));
    }

    [Fact]
    public async Task The_policy_can_be_changed_and_says_what_is_sealed()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var client = await TestAccounts.SignedInClientAsync(_factory, user);
        var scope = await PersonalScopeAsync(client);

        var response = await client.SendAsync(HttpMethod.Patch, $"/api/v1/sync-scopes/{scope}", new { policy = new { servers = true, environments = true, everything = false } });

        var body = await ApiClient.ReadJsonAsync(response, HttpStatusCode.OK);
        Assert.True(body.GetProperty("policy").GetProperty("servers").GetBoolean());
        Assert.True(body.GetProperty("policy").GetProperty("environments").GetBoolean());
    }

    [Fact]
    public async Task Wiping_the_cloud_copy_needs_a_step_up_and_empties_the_feed()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var client = await TestAccounts.SignedInClientAsync(_factory, user);
        var scope = await PersonalScopeAsync(client);
        await PushAsync(client, scope, Record("a", 0));

        var response = await client.SendAsync(HttpMethod.Delete, $"/api/v1/sync-scopes/{scope}/records", new { password = TestAccounts.Password, code = (string?)null });

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Empty((await ChangesAsync(client, scope)).GetProperty("records").EnumerateArray());
        var activity = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/activities?action=sync-reset"), HttpStatusCode.OK);
        Assert.Single(activity.GetProperty("items").EnumerateArray());
    }

    [Fact]
    public async Task The_scope_says_how_much_it_holds()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var client = await TestAccounts.SignedInClientAsync(_factory, user);
        var scope = await PersonalScopeAsync(client);
        await PushAsync(client, scope, Record("a", 0), Record("b", 0, collection: "ssh-servers"));

        var usage = await ApiClient.ReadJsonAsync(await client.GetAsync($"/api/v1/sync-scopes/{scope}/usage"), HttpStatusCode.OK);

        Assert.Equal(2, usage.GetProperty("records").GetInt32());
        Assert.True(usage.GetProperty("bytes").GetInt64() > 0);
        Assert.Equal(1, usage.GetProperty("collections").GetProperty("projects").GetInt32());
    }

    [Fact]
    public async Task Deleting_the_account_deletes_its_synced_data()
    {
        var user = await TestAccounts.CreateAsync(_factory.Services);
        var client = await TestAccounts.SignedInClientAsync(_factory, user);
        var scope = await PersonalScopeAsync(client);
        await PushAsync(client, scope, Record("a", 0));

        await client.SendAsync(HttpMethod.Delete, "/api/v1/accounts/me", new { password = TestAccounts.Password, code = (string?)null });

        using var serviceScope = Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.CreateScope(_factory.Services);
        var db = Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService<Data.AppDbContext>(serviceScope.ServiceProvider);
        Assert.False(db.SyncRecords.Any(r => r.ScopeId == scope));
        Assert.False(db.SyncScopes.Any(s => s.Id == scope));
    }
}
