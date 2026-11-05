using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.Core.Identity;
using Runova.Website.Core.News;
using Runova.Website.Core.Releases;
using Runova.Website.Data;
using Runova.Website.Data.Accounts;
using Runova.Website.Data.Identity;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Reports;

// Each test gets a database of its own, since the report counts everything in it.
public sealed class ReportsTests(PostgresFixture postgres)
{
    private const string Report = "/api/v1/reports/current";
    private static readonly DateTimeOffset _now = new(2026, 11, 6, 12, 0, 0, TimeSpan.Zero);
    private static readonly DateTimeOffset _longAgo = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);

    private static readonly string[] _reportProperties =
    [
        "generatedAt", "days", "users", "signUps", "newestUsers", "sessions", "teams", "sync", "content", "apiClients", "latestRelease",
    ];

    [Fact]
    public async Task Anonymous_gets_401_and_an_editor_403()
    {
        using var factory = await FactoryAsync();
        var editor = await TestUsers.SignedInClientAsync(factory, await TestUsers.CreateAsync(factory.Services));

        await ProblemAssert.IsProblemAsync(await factory.CreateApiClient().GetAsync(Report), HttpStatusCode.Unauthorized, ProblemAssert.Type("unauthorized"), Report);
        await ProblemAssert.IsProblemAsync(await editor.GetAsync(Report), HttpStatusCode.Forbidden, ProblemAssert.Type("forbidden"), Report);
    }

    [Fact]
    public async Task An_account_with_no_staff_role_gets_403()
    {
        using var factory = await FactoryAsync();
        var account = await TestAccounts.SignedInClientAsync(factory, await TestAccounts.CreateAsync(factory.Services));

        await ProblemAssert.IsProblemAsync(await account.GetAsync(Report), HttpStatusCode.Forbidden, ProblemAssert.Type("forbidden"), Report);
    }

    [Theory]
    [InlineData("0")]
    [InlineData("366")]
    [InlineData("-5")]
    public async Task Days_out_of_range_answers_400(string days)
    {
        using var factory = await FactoryAsync();
        var admin = await AdminAsync(factory);

        var problem = await ProblemAssert.IsProblemAsync(
            await admin.GetAsync($"{Report}?days={days}"), HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Report);

        Assert.True(problem.GetProperty("errors").TryGetProperty("days", out _));
    }

    [Theory]
    [InlineData(null, 30)]
    [InlineData("1", 1)]
    [InlineData("7", 7)]
    [InlineData("365", 365)]
    public async Task There_is_one_sign_up_entry_per_day_of_the_period_ending_today(string? days, int expected)
    {
        using var factory = await FactoryAsync();
        var admin = await AdminAsync(factory);

        var report = await ReadAsync(admin, days is null ? Report : $"{Report}?days={days}");

        Assert.Equal(expected, report.GetProperty("days").GetInt32());
        var dates = report.GetProperty("signUps").EnumerateArray().Select(d => d.GetProperty("date").GetString()).ToList();
        Assert.Equal(expected, dates.Count);
        Assert.Equal("2026-11-06", dates[^1]);
        Assert.Equal(_now.AddDays(1 - expected).ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture), dates[0]);
    }

    [Fact]
    public async Task An_empty_site_reports_zeros_besides_the_admin_asking()
    {
        using var factory = await FactoryAsync();
        var admin = await AdminAsync(factory);

        var report = await ReadAsync(admin, Report);

        Assert.Equal(_reportProperties, report.EnumerateObject().Select(p => p.Name));
        Assert.Equal(_now, report.GetProperty("generatedAt").GetDateTimeOffset());
        var users = report.GetProperty("users");
        Assert.Equal(1, users.GetProperty("total").GetInt32());
        Assert.Equal(0, users.GetProperty("accounts").GetInt32());
        Assert.Equal(1, users.GetProperty("admins").GetInt32());
        Assert.Equal(0, report.GetProperty("teams").GetProperty("total").GetInt32());
        Assert.Equal(0L, report.GetProperty("sync").GetProperty("bytes").GetInt64());
        Assert.Equal(0, report.GetProperty("content").GetProperty("newsPublished").GetInt32());
        Assert.Equal(JsonValueKind.Null, report.GetProperty("latestRelease").ValueKind);
        Assert.Empty(report.GetProperty("sessions").GetProperty("platforms").EnumerateArray());
    }

    [Fact]
    public async Task The_report_counts_users_sessions_teams_sync_content_and_clients()
    {
        using var factory = await FactoryAsync();
        var adminUser = await TestUsers.CreateAsync(factory.Services, Roles.Admin, displayName: "The Admin");
        var editor = await TestUsers.CreateAsync(factory.Services, displayName: "The Editor");
        var both = await TestUsers.CreateAsync(factory.Services, Roles.Admin, displayName: "Admin And Editor");
        await AddRoleAsync(factory, both, Roles.Editor);
        var desktopUser = await TestAccounts.CreateAsync(factory.Services, "Desk Top");
        var unconfirmed = await TestAccounts.CreateAsync(factory.Services, "Not Yet", emailConfirmed: false);
        var disabled = await TestAccounts.CreateAsync(factory.Services, "Turned Off");

        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            await SetAsync(db, adminUser.Id, _longAgo);
            await SetAsync(db, both.Id, _longAgo);
            await SetAsync(db, editor.Id, new DateTimeOffset(2026, 11, 6, 8, 0, 0, TimeSpan.Zero));
            await SetAsync(db, desktopUser.Id, new DateTimeOffset(2026, 11, 5, 23, 59, 0, TimeSpan.Zero), twoFactor: true);
            // The first moment of the period counts; the moment before it does not.
            await SetAsync(db, unconfirmed.Id, new DateTimeOffset(2026, 10, 8, 0, 0, 0, TimeSpan.Zero));
            await SetAsync(db, disabled.Id, new DateTimeOffset(2026, 10, 7, 23, 59, 59, TimeSpan.Zero), disabledAt: _now, lastSignInAt: new DateTimeOffset(2026, 9, 1, 0, 0, 0, TimeSpan.Zero));

            db.AccountSessions.AddRange(
                Session(desktopUser.Id, AccountSessionKinds.Desktop, "windows", "3.3.0", _now.AddDays(-5)),
                Session(desktopUser.Id, AccountSessionKinds.Desktop, "macos", null, _now),
                // Ended, so not a session any more, though it shows its user was about.
                Session(disabled.Id, AccountSessionKinds.Desktop, "linux", "3.2.0", _now.AddDays(-1), revokedAt: _now),
                // Before the period.
                Session(disabled.Id, AccountSessionKinds.Web, "windows", null, new DateTimeOffset(2026, 9, 1, 0, 0, 0, TimeSpan.Zero)));

            var team = new Team { Name = "Ops", CreatedAt = _now, CreatedBy = desktopUser.Id };
            db.Teams.Add(team);
            await db.SaveChangesAsync(TestContext.Current.CancellationToken);
            db.TeamMembers.AddRange(
                new TeamMember { TeamId = team.Id, UserId = desktopUser.Id, Role = TeamRoles.Owner, JoinedAt = _now },
                new TeamMember { TeamId = team.Id, UserId = unconfirmed.Id, Role = TeamRoles.Member, JoinedAt = _now });
            db.TeamInvitations.AddRange(
                Invitation(team.Id, desktopUser.Id, "pending@example.test", _now.AddDays(3)),
                Invitation(team.Id, desktopUser.Id, "expired@example.test", _now.AddDays(-1)));

            var scopeRow = new SyncScope { Kind = SyncScopeKinds.Personal, UserId = desktopUser.Id, CreatedAt = _now };
            db.SyncScopes.Add(scopeRow);
            await db.SaveChangesAsync(TestContext.Current.CancellationToken);
            db.SyncRecords.AddRange(
                Record(scopeRow.Id, "a", 100, deleted: false),
                Record(scopeRow.Id, "b", 200, deleted: false),
                Record(scopeRow.Id, "c", 50, deleted: true));

            db.Releases.Add(new Release
            {
                Version = "3.2.0",
                TagName = "v3.2.0",
                Name = "Runova 3.2.0",
                PublishedAt = _longAgo,
                NotesUrl = "https://github.com/x/3.2.0",
                FetchedAt = _longAgo,
            });
            db.Releases.Add(new Release
            {
                Version = "3.3.0",
                TagName = "v3.3.0",
                Name = "Runova 3.3.0",
                PublishedAt = _now,
                NotesUrl = "https://github.com/x/3.3.0",
                FetchedAt = _now,
            });
            await db.SaveChangesAsync(TestContext.Current.CancellationToken);
        }

        await TestNews.AddAsync(
            factory.Services,
            TestNews.Item("n1", _longAgo),
            TestNews.Item("n2", _longAgo),
            TestNews.Item("n3", null, NewsStatus.Draft),
            TestNews.Item("n4", _now.AddDays(1), NewsStatus.Scheduled),
            TestNews.Item("n5", _longAgo, NewsStatus.Archived));
        await TestPosts.AddAsync(
            factory.Services,
            TestPosts.Item("p1", _longAgo),
            TestPosts.Item("p2", null, NewsStatus.Draft));
        await TestApiClients.AddAsync(factory.Services);
        await TestApiClients.AddAsync(factory.Services, revokedAt: _longAgo);
        await TestApiClients.AddAsync(factory.Services, expiresAt: _longAgo);

        // Signing in starts the one web session and makes the admin active.
        var admin = await TestUsers.SignedInClientAsync(factory, adminUser);
        var report = await ReadAsync(admin, Report);

        var users = report.GetProperty("users");
        Assert.Equal(
            (6, 3, 2, 1, 1, 1, 1, 3, 3),
            (Int(users, "total"), Int(users, "accounts"), Int(users, "admins"), Int(users, "editors"), Int(users, "disabled"),
                Int(users, "unconfirmed"), Int(users, "twoFactor"), Int(users, "joined"), Int(users, "active")));

        var signUps = report.GetProperty("signUps").EnumerateArray()
            .ToDictionary(d => d.GetProperty("date").GetString()!, d => d.GetProperty("count").GetInt32());
        Assert.Equal(30, signUps.Count);
        Assert.Equal(1, signUps["2026-10-08"]);
        Assert.Equal(1, signUps["2026-11-05"]);
        Assert.Equal(1, signUps["2026-11-06"]);
        Assert.Equal(3, signUps.Values.Sum());

        var newest = report.GetProperty("newestUsers").EnumerateArray()
            .Select(u => (u.GetProperty("id").GetInt64(), u.GetProperty("staff").GetBoolean())).ToList();
        Assert.Equal([(editor.Id, true), (desktopUser.Id, false), (unconfirmed.Id, false), (disabled.Id, false), (both.Id, true)], newest);
        Assert.Equal(["id", "displayName", "email", "staff", "createdAt"], report.GetProperty("newestUsers")[0].EnumerateObject().Select(p => p.Name));

        var sessions = report.GetProperty("sessions");
        Assert.Equal(1, Int(sessions, "web"));
        Assert.Equal(2, Int(sessions, "desktop"));
        Assert.Equal([("macos", 1), ("windows", 1)], Named(sessions, "platforms"));
        Assert.Equal([("", 1), ("3.3.0", 1)], Named(sessions, "appVersions"));

        var teams = report.GetProperty("teams");
        Assert.Equal((1, 2, 1), (Int(teams, "total"), Int(teams, "members"), Int(teams, "pendingInvitations")));

        var sync = report.GetProperty("sync");
        Assert.Equal((1, 2, 300L), (Int(sync, "scopes"), Int(sync, "items"), sync.GetProperty("bytes").GetInt64()));

        var content = report.GetProperty("content");
        Assert.Equal(
            (2, 1, 1, 1, 0, 1, 0),
            (Int(content, "newsPublished"), Int(content, "newsScheduled"), Int(content, "newsDrafts"),
                Int(content, "postsPublished"), Int(content, "postsScheduled"), Int(content, "postsDrafts"), Int(content, "media")));

        var clients = report.GetProperty("apiClients");
        Assert.Equal((1, 2), (Int(clients, "active"), Int(clients, "inactive")));
        Assert.Equal("3.3.0", report.GetProperty("latestRelease").GetString());
    }

    [Fact]
    public async Task A_shorter_period_counts_fewer_joined_and_active_users()
    {
        using var factory = await FactoryAsync();
        var adminUser = await TestUsers.CreateAsync(factory.Services, Roles.Admin);
        var recent = await TestAccounts.CreateAsync(factory.Services);
        var older = await TestAccounts.CreateAsync(factory.Services);
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            await SetAsync(db, adminUser.Id, _longAgo);
            await SetAsync(db, recent.Id, _now.AddDays(-2), lastSignInAt: _now.AddDays(-2));
            await SetAsync(db, older.Id, _now.AddDays(-20), lastSignInAt: _now.AddDays(-20));
        }

        var admin = await TestUsers.SignedInClientAsync(factory, adminUser);

        var week = (await ReadAsync(admin, $"{Report}?days=7")).GetProperty("users");
        var month = (await ReadAsync(admin, $"{Report}?days=30")).GetProperty("users");
        Assert.Equal((1, 2), (Int(week, "joined"), Int(week, "active")));
        Assert.Equal((2, 3), (Int(month, "joined"), Int(month, "active")));
    }

    private async Task<WebsiteApiFactory> FactoryAsync() =>
        new(await postgres.CreateDatabaseAsync(), time: new FakeTimeProvider(_now));

    private static async Task<ApiClient> AdminAsync(WebsiteApiFactory factory) =>
        await TestUsers.SignedInClientAsync(factory, await TestUsers.CreateAsync(factory.Services, Roles.Admin));

    private static async Task<JsonElement> ReadAsync(ApiClient admin, string path) =>
        await ApiClient.ReadJsonAsync(await admin.GetAsync(path), HttpStatusCode.OK);

    private static int Int(JsonElement element, string name) => element.GetProperty(name).GetInt32();

    private static List<(string, int)> Named(JsonElement element, string name) =>
        [.. element.GetProperty(name).EnumerateArray().Select(n => (n.GetProperty("name").GetString()!, n.GetProperty("count").GetInt32()))];

    private static async Task AddRoleAsync(WebsiteApiFactory factory, AppUser user, string role)
    {
        using var scope = factory.Services.CreateScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<AppUser>>();
        var stored = await users.FindByIdAsync(user.Id.ToString(System.Globalization.CultureInfo.InvariantCulture));
        Assert.True((await users.AddToRoleAsync(stored!, role)).Succeeded);
    }

    private static async Task SetAsync(
        AppDbContext db, long id, DateTimeOffset createdAt, bool twoFactor = false, DateTimeOffset? disabledAt = null, DateTimeOffset? lastSignInAt = null) =>
        await db.Users.Where(u => u.Id == id).ExecuteUpdateAsync(
            u => u.SetProperty(x => x.CreatedAt, createdAt)
                .SetProperty(x => x.TwoFactorEnabled, twoFactor)
                .SetProperty(x => x.DisabledAt, disabledAt)
                .SetProperty(x => x.LastSignInAt, lastSignInAt),
            TestContext.Current.CancellationToken);

    private static AccountSession Session(
        long userId, string kind, string platform, string? appVersion, DateTimeOffset lastSeenAt, DateTimeOffset? revokedAt = null) => new()
        {
            UserId = userId,
            Kind = kind,
            DeviceName = "Test computer",
            Platform = platform,
            AppVersion = appVersion,
            CreatedAt = lastSeenAt,
            LastSeenAt = lastSeenAt,
            RevokedAt = revokedAt,
        };

    private static TeamInvitation Invitation(long teamId, long invitedBy, string email, DateTimeOffset expiresAt) => new()
    {
        TeamId = teamId,
        Email = email,
        NormalizedEmail = email.ToUpperInvariant(),
        Role = TeamRoles.Member,
        InvitedBy = invitedBy,
        CreatedAt = _now.AddDays(-4),
        ExpiresAt = expiresAt,
    };

    private static SyncRecord Record(long scopeId, string itemId, int size, bool deleted) => new()
    {
        ScopeId = scopeId,
        Collection = "servers",
        ItemId = itemId,
        Revision = 1,
        Deleted = deleted,
        Payload = deleted ? null : "{}",
        Size = size,
        UpdatedAt = _now,
    };
}
