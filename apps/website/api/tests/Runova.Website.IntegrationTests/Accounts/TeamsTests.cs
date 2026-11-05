using System.Net;
using System.Text.Json;
using Runova.Website.Data.Identity;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Accounts;

public sealed class TeamsTests(PostgresFixture postgres) : IDisposable
{
    private readonly WebsiteApiFactory _factory = new(postgres.ConnectionString);

    public void Dispose() => _factory.Dispose();

    private async Task<(AppUser User, ApiClient Client)> AccountAsync(string name = "Sam")
    {
        var user = await TestAccounts.CreateAsync(_factory.Services, name);
        return (user, await TestAccounts.SignedInClientAsync(_factory, user));
    }

    private static async Task<JsonElement> CreateTeamAsync(ApiClient owner, string name = "Platform") =>
        await ApiClient.ReadJsonAsync(await owner.SendAsync(HttpMethod.Post, "/api/v1/teams", new { name }), HttpStatusCode.Created);

    /// <summary>Invites the account and accepts as it, and returns the team.</summary>
    private static async Task<long> JoinAsync(ApiClient owner, long teamId, AppUser member, ApiClient memberClient, string role = "member")
    {
        var invited = await owner.SendAsync(HttpMethod.Post, $"/api/v1/teams/{teamId}/invitations", new { email = member.Email, role });
        Assert.Equal(HttpStatusCode.Created, invited.StatusCode);
        var pending = await ApiClient.ReadJsonAsync(await memberClient.GetAsync("/api/v1/invitations"), HttpStatusCode.OK);
        var invitation = pending.GetProperty("items").EnumerateArray().Single(i => i.GetProperty("teamId").GetInt64() == teamId);
        var accepted = await memberClient.SendAsync(HttpMethod.Post, $"/api/v1/invitations/{invitation.GetProperty("id").GetInt64()}/acceptances");
        Assert.Equal(HttpStatusCode.Created, accepted.StatusCode);
        return teamId;
    }

    private static async Task<JsonElement> TeamScopeAsync(ApiClient client, long teamId)
    {
        var scopes = await ApiClient.ReadJsonAsync(await client.GetAsync("/api/v1/sync-scopes"), HttpStatusCode.OK);
        return scopes.GetProperty("items").EnumerateArray().Single(s => s.GetProperty("teamId").ValueKind == JsonValueKind.Number && s.GetProperty("teamId").GetInt64() == teamId);
    }

    private static object Record(string itemId, long baseRevision = 0) =>
        new { collection = "ssh-servers", itemId, baseRevision, deleted = false, encryption = "none", keyVersion = (int?)null, payload = """{"v":1,"shared":{"host":"example.com"},"sealed":null}""" };

    [Fact]
    public async Task Making_a_team_makes_its_owner_and_its_sync_scope()
    {
        var (_, owner) = await AccountAsync();

        var team = await CreateTeamAsync(owner);

        Assert.Equal("Platform", team.GetProperty("name").GetString());
        Assert.Equal("owner", team.GetProperty("role").GetString());
        Assert.Equal(1, team.GetProperty("memberCount").GetInt32());
        var scope = await TeamScopeAsync(owner, team.GetProperty("id").GetInt64());
        Assert.Equal("Platform", scope.GetProperty("name").GetString());
        Assert.True(scope.GetProperty("canManage").GetBoolean());
        var list = await ApiClient.ReadJsonAsync(await owner.GetAsync("/api/v1/teams"), HttpStatusCode.OK);
        Assert.Single(list.GetProperty("items").EnumerateArray());
    }

    [Fact]
    public async Task An_invitation_goes_by_email_and_only_that_address_can_accept_it()
    {
        var (_, owner) = await AccountAsync();
        var (kim, kimClient) = await AccountAsync("Kim");
        var (_, strangerClient) = await AccountAsync("Lee");
        var team = (await CreateTeamAsync(owner)).GetProperty("id").GetInt64();

        await owner.SendAsync(HttpMethod.Post, $"/api/v1/teams/{team}/invitations", new { email = kim.Email, role = "member" });

        var mail = await TestAccounts.LatestEmailAsync(_factory.Services, kim.Email!);
        Assert.Contains("Platform", mail.Subject, StringComparison.Ordinal);
        Assert.Contains("/account/invitations", mail.TextBody, StringComparison.Ordinal);
        Assert.Empty((await ApiClient.ReadJsonAsync(await strangerClient.GetAsync("/api/v1/invitations"), HttpStatusCode.OK)).GetProperty("items").EnumerateArray());
        var invitation = (await ApiClient.ReadJsonAsync(await kimClient.GetAsync("/api/v1/invitations"), HttpStatusCode.OK)).GetProperty("items")[0];
        var stolen = await strangerClient.SendAsync(HttpMethod.Post, $"/api/v1/invitations/{invitation.GetProperty("id").GetInt64()}/acceptances");
        Assert.Equal(HttpStatusCode.NotFound, stolen.StatusCode);

        var accepted = await kimClient.SendAsync(HttpMethod.Post, $"/api/v1/invitations/{invitation.GetProperty("id").GetInt64()}/acceptances");

        Assert.Equal(HttpStatusCode.Created, accepted.StatusCode);
        var members = await ApiClient.ReadJsonAsync(await owner.GetAsync($"/api/v1/teams/{team}/members"), HttpStatusCode.OK);
        Assert.Equal(2, members.GetProperty("items").GetArrayLength());
    }

    [Fact]
    public async Task Members_share_the_team_scope_and_a_viewer_reads_but_never_writes()
    {
        var (_, owner) = await AccountAsync();
        var (member, memberClient) = await AccountAsync("Kim");
        var (viewer, viewerClient) = await AccountAsync("Lee");
        var team = (await CreateTeamAsync(owner)).GetProperty("id").GetInt64();
        await JoinAsync(owner, team, member, memberClient);
        await JoinAsync(owner, team, viewer, viewerClient, "viewer");
        var scope = (await TeamScopeAsync(owner, team)).GetProperty("id").GetInt64();

        var pushed = await memberClient.SendAsync(HttpMethod.Post, $"/api/v1/sync-scopes/{scope}/records", new { records = new[] { Record("s1") } });
        var read = await ApiClient.ReadJsonAsync(await viewerClient.GetAsync($"/api/v1/sync-scopes/{scope}/changes?since=0"), HttpStatusCode.OK);
        var viewerPush = await viewerClient.SendAsync(HttpMethod.Post, $"/api/v1/sync-scopes/{scope}/records", new { records = new[] { Record("s2") } });

        Assert.Equal(HttpStatusCode.OK, pushed.StatusCode);
        Assert.Single(read.GetProperty("records").EnumerateArray());
        Assert.Equal(HttpStatusCode.Forbidden, viewerPush.StatusCode);
        Assert.False((await TeamScopeAsync(viewerClient, team)).GetProperty("canWrite").GetBoolean());
    }

    [Fact]
    public async Task A_removed_member_loses_the_team_scope_at_once()
    {
        var (_, owner) = await AccountAsync();
        var (member, memberClient) = await AccountAsync("Kim");
        var team = (await CreateTeamAsync(owner)).GetProperty("id").GetInt64();
        await JoinAsync(owner, team, member, memberClient);
        var scope = (await TeamScopeAsync(owner, team)).GetProperty("id").GetInt64();

        var removed = await owner.SendAsync(HttpMethod.Delete, $"/api/v1/teams/{team}/members/{member.Id}", new { password = TestAccounts.Password, code = (string?)null });

        Assert.Equal(HttpStatusCode.NoContent, removed.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await memberClient.GetAsync($"/api/v1/sync-scopes/{scope}/changes?since=0")).StatusCode);
        var scopes = await ApiClient.ReadJsonAsync(await memberClient.GetAsync("/api/v1/sync-scopes"), HttpStatusCode.OK);
        Assert.Single(scopes.GetProperty("items").EnumerateArray());
    }

    [Fact]
    public async Task Only_owners_and_admins_manage_and_an_admin_can_not_touch_an_owner()
    {
        var (ownerUser, owner) = await AccountAsync();
        var (admin, adminClient) = await AccountAsync("Kim");
        var (member, memberClient) = await AccountAsync("Lee");
        var team = (await CreateTeamAsync(owner)).GetProperty("id").GetInt64();
        await JoinAsync(owner, team, admin, adminClient, "admin");
        await JoinAsync(owner, team, member, memberClient);

        var memberInvites = await memberClient.SendAsync(HttpMethod.Post, $"/api/v1/teams/{team}/invitations", new { email = TestAccounts.NewEmail(), role = "member" });
        var adminInvitesOwner = await adminClient.SendAsync(HttpMethod.Post, $"/api/v1/teams/{team}/invitations", new { email = TestAccounts.NewEmail(), role = "owner" });
        var adminDemotesOwner = await adminClient.SendAsync(HttpMethod.Patch, $"/api/v1/teams/{team}/members/{ownerUser.Id}", new { role = "member", password = TestAccounts.Password });
        var adminMakesViewer = await adminClient.SendAsync(HttpMethod.Patch, $"/api/v1/teams/{team}/members/{member.Id}", new { role = "viewer", password = TestAccounts.Password });

        Assert.Equal(HttpStatusCode.Forbidden, memberInvites.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, adminInvitesOwner.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, adminDemotesOwner.StatusCode);
        Assert.Equal(HttpStatusCode.OK, adminMakesViewer.StatusCode);
    }

    [Fact]
    public async Task The_last_owner_can_not_leave_or_be_demoted()
    {
        var (ownerUser, owner) = await AccountAsync();
        var (member, memberClient) = await AccountAsync("Kim");
        var team = (await CreateTeamAsync(owner)).GetProperty("id").GetInt64();
        await JoinAsync(owner, team, member, memberClient);

        var leave = await owner.SendAsync(HttpMethod.Delete, $"/api/v1/teams/{team}/members/{ownerUser.Id}", new { password = TestAccounts.Password, code = (string?)null });
        var demote = await owner.SendAsync(HttpMethod.Patch, $"/api/v1/teams/{team}/members/{ownerUser.Id}", new { role = "admin", password = TestAccounts.Password });

        Assert.Equal(HttpStatusCode.Conflict, leave.StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, demote.StatusCode);
    }

    [Fact]
    public async Task A_member_can_leave()
    {
        var (_, owner) = await AccountAsync();
        var (member, memberClient) = await AccountAsync("Kim");
        var team = (await CreateTeamAsync(owner)).GetProperty("id").GetInt64();
        await JoinAsync(owner, team, member, memberClient);

        var left = await memberClient.SendAsync(HttpMethod.Delete, $"/api/v1/teams/{team}/members/{member.Id}", new { password = TestAccounts.Password, code = (string?)null });

        Assert.Equal(HttpStatusCode.NoContent, left.StatusCode);
        Assert.Empty((await ApiClient.ReadJsonAsync(await memberClient.GetAsync("/api/v1/teams"), HttpStatusCode.OK)).GetProperty("items").EnumerateArray());
    }

    [Fact]
    public async Task Deleting_a_team_needs_the_owner_and_a_step_up_and_takes_its_data()
    {
        var (_, owner) = await AccountAsync();
        var (member, memberClient) = await AccountAsync("Kim");
        var team = (await CreateTeamAsync(owner)).GetProperty("id").GetInt64();
        await JoinAsync(owner, team, member, memberClient, "admin");
        var scope = (await TeamScopeAsync(owner, team)).GetProperty("id").GetInt64();
        await owner.SendAsync(HttpMethod.Post, $"/api/v1/sync-scopes/{scope}/records", new { records = new[] { Record("s1") } });

        var byAdmin = await memberClient.SendAsync(HttpMethod.Delete, $"/api/v1/teams/{team}", new { password = TestAccounts.Password, code = (string?)null });
        var byOwner = await owner.SendAsync(HttpMethod.Delete, $"/api/v1/teams/{team}", new { password = TestAccounts.Password, code = (string?)null });

        Assert.Equal(HttpStatusCode.Forbidden, byAdmin.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, byOwner.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.GetAsync($"/api/v1/teams/{team}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.GetAsync($"/api/v1/sync-scopes/{scope}/changes?since=0")).StatusCode);
    }

    [Fact]
    public async Task Team_activity_is_for_owners_and_admins()
    {
        var (_, owner) = await AccountAsync();
        var (member, memberClient) = await AccountAsync("Kim");
        var team = (await CreateTeamAsync(owner)).GetProperty("id").GetInt64();
        await JoinAsync(owner, team, member, memberClient);

        var forOwner = await ApiClient.ReadJsonAsync(await owner.GetAsync($"/api/v1/teams/{team}/activities"), HttpStatusCode.OK);
        var forMember = await memberClient.GetAsync($"/api/v1/teams/{team}/activities");

        var actions = forOwner.GetProperty("items").EnumerateArray().Select(a => a.GetProperty("action").GetString()).ToList();
        Assert.Contains("team-created", actions);
        Assert.Contains("member-invited", actions);
        Assert.Contains("member-joined", actions);
        Assert.Equal(HttpStatusCode.Forbidden, forMember.StatusCode);
    }

    [Fact]
    public async Task A_team_key_is_set_by_an_owner_and_read_by_members()
    {
        var (_, owner) = await AccountAsync();
        var (member, memberClient) = await AccountAsync("Kim");
        var team = (await CreateTeamAsync(owner)).GetProperty("id").GetInt64();
        await JoinAsync(owner, team, member, memberClient);
        var scope = (await TeamScopeAsync(owner, team)).GetProperty("id").GetInt64();

        var byMember = await memberClient.SendAsync(HttpMethod.Put, $"/api/v1/sync-scopes/{scope}/keys/current", new { version = 1, envelope = new { version = 1 } });
        var byOwner = await owner.SendAsync(HttpMethod.Put, $"/api/v1/sync-scopes/{scope}/keys/current", new { version = 1, envelope = new { version = 1 } });

        Assert.Equal(HttpStatusCode.Forbidden, byMember.StatusCode);
        Assert.Equal(HttpStatusCode.OK, byOwner.StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await memberClient.GetAsync($"/api/v1/sync-scopes/{scope}/keys/current")).StatusCode);
    }

    [Fact]
    public async Task An_account_that_alone_owns_a_team_with_others_can_not_be_deleted()
    {
        var (owner, ownerClient) = await AccountAsync();
        var (member, memberClient) = await AccountAsync("Kim");
        var team = (await CreateTeamAsync(ownerClient)).GetProperty("id").GetInt64();
        await JoinAsync(ownerClient, team, member, memberClient);

        var response = await ownerClient.SendAsync(HttpMethod.Delete, "/api/v1/accounts/me", new { password = TestAccounts.Password, code = (string?)null });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.NotNull(await TestAccounts.FindAsync(_factory.Services, owner.Email!));
    }

    [Fact]
    public async Task A_team_of_one_goes_with_its_deleted_owner()
    {
        var (owner, ownerClient) = await AccountAsync();
        var team = (await CreateTeamAsync(ownerClient)).GetProperty("id").GetInt64();

        var response = await ownerClient.SendAsync(HttpMethod.Delete, "/api/v1/accounts/me", new { password = TestAccounts.Password, code = (string?)null });

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        using var scope = Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.CreateScope(_factory.Services);
        var db = Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService<Data.AppDbContext>(scope.ServiceProvider);
        Assert.False(db.Teams.Any(t => t.Id == team));
        _ = owner;
    }

    [Fact]
    public async Task Inviting_someone_already_in_the_team_is_a_conflict_and_a_bad_role_is_refused()
    {
        var (_, owner) = await AccountAsync();
        var (member, memberClient) = await AccountAsync("Kim");
        var team = (await CreateTeamAsync(owner)).GetProperty("id").GetInt64();
        await JoinAsync(owner, team, member, memberClient);

        var again = await owner.SendAsync(HttpMethod.Post, $"/api/v1/teams/{team}/invitations", new { email = member.Email, role = "member" });
        var badRole = await owner.SendAsync(HttpMethod.Post, $"/api/v1/teams/{team}/invitations", new { email = TestAccounts.NewEmail(), role = "god" });

        Assert.Equal(HttpStatusCode.Conflict, again.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, badRole.StatusCode);
    }

    [Fact]
    public async Task A_stranger_does_not_see_a_team()
    {
        var (_, owner) = await AccountAsync();
        var (_, stranger) = await AccountAsync("Lee");
        var team = (await CreateTeamAsync(owner)).GetProperty("id").GetInt64();

        Assert.Equal(HttpStatusCode.NotFound, (await stranger.GetAsync($"/api/v1/teams/{team}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await stranger.GetAsync($"/api/v1/teams/{team}/members")).StatusCode);
    }

    [Fact]
    public async Task An_invitation_can_be_declined_or_taken_back()
    {
        var (_, owner) = await AccountAsync();
        var (kim, kimClient) = await AccountAsync("Kim");
        var team = (await CreateTeamAsync(owner)).GetProperty("id").GetInt64();
        await owner.SendAsync(HttpMethod.Post, $"/api/v1/teams/{team}/invitations", new { email = kim.Email, role = "member" });
        var invitation = (await ApiClient.ReadJsonAsync(await kimClient.GetAsync("/api/v1/invitations"), HttpStatusCode.OK)).GetProperty("items")[0].GetProperty("id").GetInt64();

        var declined = await kimClient.SendAsync(HttpMethod.Delete, $"/api/v1/invitations/{invitation}");

        Assert.Equal(HttpStatusCode.NoContent, declined.StatusCode);
        Assert.Empty((await ApiClient.ReadJsonAsync(await owner.GetAsync($"/api/v1/teams/{team}/invitations"), HttpStatusCode.OK)).GetProperty("items").EnumerateArray());

        await owner.SendAsync(HttpMethod.Post, $"/api/v1/teams/{team}/invitations", new { email = kim.Email, role = "member" });
        var pending = (await ApiClient.ReadJsonAsync(await owner.GetAsync($"/api/v1/teams/{team}/invitations"), HttpStatusCode.OK)).GetProperty("items")[0].GetProperty("id").GetInt64();
        var withdrawn = await owner.SendAsync(HttpMethod.Delete, $"/api/v1/teams/{team}/invitations/{pending}");
        Assert.Equal(HttpStatusCode.NoContent, withdrawn.StatusCode);
        Assert.Empty((await ApiClient.ReadJsonAsync(await kimClient.GetAsync("/api/v1/invitations"), HttpStatusCode.OK)).GetProperty("items").EnumerateArray());
    }
}
