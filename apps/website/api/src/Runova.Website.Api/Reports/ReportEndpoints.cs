using System.Globalization;
using System.Linq.Expressions;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Identity;
using Runova.Website.Core.News;
using Runova.Website.Data;
using Runova.Website.Data.Accounts;

namespace Runova.Website.Api.Reports;

/// <summary>Who uses the site and what is on it, counted over the last <c>days</c> days.</summary>
public sealed record ReportDto(
    DateTimeOffset GeneratedAt,
    int Days,
    UserCountsDto Users,
    IReadOnlyList<DailyCountDto> SignUps,
    IReadOnlyList<NewUserDto> NewestUsers,
    SessionCountsDto Sessions,
    TeamCountsDto Teams,
    SyncCountsDto Sync,
    ContentCountsDto Content,
    ApiClientCountsDto ApiClients,
    string? LatestRelease);

/// <summary>
/// Every user, split into Runova accounts (no staff role) and staff. <c>Joined</c> and <c>Active</c>
/// count the period: made in it, and signed in or seen on a session in it.
/// </summary>
public sealed record UserCountsDto(
    int Total, int Accounts, int Admins, int Editors, int Disabled, int Unconfirmed, int TwoFactor, int Joined, int Active);

/// <summary>A UTC day as <c>yyyy-MM-dd</c>, and how many there were on it.</summary>
public sealed record DailyCountDto(string Date, int Count);

public sealed record NewUserDto(long Id, string DisplayName, string Email, bool Staff, DateTimeOffset CreatedAt);

/// <summary>A name (a platform or an app version) and how many sessions have it.</summary>
public sealed record NamedCountDto(string Name, int Count);

/// <summary>The sessions not ended and seen in the period, by kind, with the computers' platforms and app versions.</summary>
public sealed record SessionCountsDto(int Web, int Desktop, IReadOnlyList<NamedCountDto> Platforms, IReadOnlyList<NamedCountDto> AppVersions);

public sealed record TeamCountsDto(int Total, int Members, int PendingInvitations);

/// <summary>Synced items that are not deleted, and their size in bytes.</summary>
public sealed record SyncCountsDto(int Scopes, int Items, long Bytes);

public sealed record ContentCountsDto(
    int NewsPublished, int NewsScheduled, int NewsDrafts, int PostsPublished, int PostsScheduled, int PostsDrafts, int Media);

public sealed record ApiClientCountsDto(int Active, int Inactive);

/// <summary>The numbers behind the admin Reports page, for Admins only. Nothing here is written.</summary>
internal static class ReportEndpoints
{
    public const int DefaultDays = 30;
    public const int MaxDays = 365;
    private const int NewestUsers = 5;
    private const int TopNames = 8;

    public static RouteGroupBuilder MapReports(this RouteGroupBuilder api)
    {
        api.MapGet("/reports/current", GetAsync).RequireAuthorization(Policies.Admin);
        return api;
    }

    private static async Task<Results<Ok<ReportDto>, ValidationProblem>> GetAsync(int? days, AppDbContext db, TimeProvider time)
    {
        var period = days ?? DefaultDays;
        if (period is < 1 or > MaxDays)
        {
            return ApiProblems.Invalid("days", $"days is a whole number from 1 to {MaxDays}.");
        }

        var now = time.GetUtcNow();
        // Whole UTC days, today included, so the chart has one bar per day.
        var since = new DateTimeOffset(now.UtcDateTime.Date, TimeSpan.Zero).AddDays(1 - period);

        var adminRoleId = await db.Roles.Where(r => r.Name == Roles.Admin).Select(r => r.Id).SingleAsync();
        var editorRoleId = await db.Roles.Where(r => r.Name == Roles.Editor).Select(r => r.Id).SingleAsync();
        var users = db.Users.AsNoTracking();
        var accounts = users.Where(u => !db.UserRoles.Any(ur => ur.UserId == u.Id));

        var userCounts = new UserCountsDto(
            Total: await users.CountAsync(),
            Accounts: await accounts.CountAsync(),
            Admins: await db.UserRoles.CountAsync(ur => ur.RoleId == adminRoleId),
            Editors: await db.UserRoles.CountAsync(ur => ur.RoleId == editorRoleId && !db.UserRoles.Any(a => a.UserId == ur.UserId && a.RoleId == adminRoleId)),
            Disabled: await users.CountAsync(u => u.DisabledAt != null),
            Unconfirmed: await users.CountAsync(u => !u.EmailConfirmed),
            TwoFactor: await users.CountAsync(u => u.TwoFactorEnabled),
            Joined: await users.CountAsync(u => u.CreatedAt >= since),
            Active: await users.CountAsync(u => u.LastSignInAt >= since || db.AccountSessions.Any(s => s.UserId == u.Id && s.LastSeenAt >= since)));

        // Grouped here rather than in SQL: a year of sign-up times is small, and the UTC day is exact.
        var joinedAt = await users.Where(u => u.CreatedAt >= since).Select(u => u.CreatedAt).ToListAsync();
        var perDay = joinedAt.GroupBy(at => at.UtcDateTime.Date).ToDictionary(g => g.Key, g => g.Count());
        var signUps = Enumerable.Range(0, period)
            .Select(offset => since.UtcDateTime.Date.AddDays(offset))
            .Select(day => new DailyCountDto(day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), perDay.GetValueOrDefault(day)))
            .ToList();

        var newest = await users
            .OrderByDescending(u => u.CreatedAt).ThenByDescending(u => u.Id)
            .Take(NewestUsers)
            .Select(u => new NewUserRow { User = u, Staff = db.UserRoles.Any(ur => ur.UserId == u.Id) })
            .ProjectToDto()
            .ToListAsync();

        var live = db.AccountSessions.AsNoTracking().Where(s => s.RevokedAt == null && s.LastSeenAt >= since);
        var desktop = live.Where(s => s.Kind == AccountSessionKinds.Desktop);
        var sessions = new SessionCountsDto(
            Web: await live.CountAsync(s => s.Kind == AccountSessionKinds.Web),
            Desktop: await desktop.CountAsync(),
            Platforms: await TopAsync(desktop, s => s.Platform),
            AppVersions: await TopAsync(desktop, s => s.AppVersion ?? ""));

        var teams = new TeamCountsDto(
            Total: await db.Teams.CountAsync(),
            Members: await db.TeamMembers.CountAsync(),
            PendingInvitations: await db.TeamInvitations.CountAsync(i => i.ExpiresAt > now));

        var items = db.SyncRecords.AsNoTracking().Where(r => !r.Deleted);
        var sync = new SyncCountsDto(
            Scopes: await db.SyncScopes.CountAsync(),
            Items: await items.CountAsync(),
            Bytes: await items.SumAsync(r => (long)r.Size));

        var content = new ContentCountsDto(
            NewsPublished: await db.NewsItems.CountAsync(n => n.Status == NewsStatus.Published),
            NewsScheduled: await db.NewsItems.CountAsync(n => n.Status == NewsStatus.Scheduled),
            NewsDrafts: await db.NewsItems.CountAsync(n => n.Status == NewsStatus.Draft),
            PostsPublished: await db.Posts.CountAsync(p => p.Status == NewsStatus.Published),
            PostsScheduled: await db.Posts.CountAsync(p => p.Status == NewsStatus.Scheduled),
            PostsDrafts: await db.Posts.CountAsync(p => p.Status == NewsStatus.Draft),
            Media: await db.Media.CountAsync());

        var activeClients = await db.ApiClients.CountAsync(c => c.RevokedAt == null && (c.ExpiresAt == null || c.ExpiresAt > now));
        var apiClients = new ApiClientCountsDto(activeClients, await db.ApiClients.CountAsync() - activeClients);

        var latest = await db.Releases.AsNoTracking().OrderByDescending(r => r.FetchedAt).Select(r => r.Version).FirstOrDefaultAsync();

        return TypedResults.Ok(new ReportDto(now, period, userCounts, signUps, newest, sessions, teams, sync, content, apiClients, latest));
    }

    /// <summary>The most common names first, then by name, so the order never changes between calls.</summary>
    private static async Task<IReadOnlyList<NamedCountDto>> TopAsync(
        IQueryable<AccountSession> sessions, Expression<Func<AccountSession, string>> name) =>
        [.. (await sessions.GroupBy(name)
                .Select(g => new { Name = g.Key, Count = g.Count() })
                .OrderByDescending(c => c.Count).ThenBy(c => c.Name)
                .Take(TopNames)
                .ToListAsync())
            .Select(c => new NamedCountDto(c.Name, c.Count))];
}
