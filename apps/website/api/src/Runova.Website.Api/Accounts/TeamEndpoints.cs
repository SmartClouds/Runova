using System.Globalization;
using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Api.Email;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Paging;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Accounts;
using Runova.Website.Core.Email;
using Runova.Website.Core.Paging;
using Runova.Website.Core.Problems;
using Runova.Website.Data;
using Runova.Website.Data.Accounts;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Accounts;

public sealed record TeamDto(long Id, string Name, string Role, int MemberCount, long ScopeId, DateTimeOffset CreatedAt);

public sealed record TeamListDto(IReadOnlyList<TeamDto> Items);

public sealed record TeamRequest(string? Name);

public sealed record TeamMemberDto(long UserId, string Email, string DisplayName, string Role, DateTimeOffset JoinedAt);

public sealed record TeamMemberListDto(IReadOnlyList<TeamMemberDto> Items);

public sealed record TeamInvitationRequest(string? Email, string? Role);

public sealed record TeamInvitationDto(long Id, string Email, string Role, DateTimeOffset CreatedAt, DateTimeOffset ExpiresAt);

public sealed record TeamInvitationListDto(IReadOnlyList<TeamInvitationDto> Items);

public sealed record MyInvitationDto(long Id, long TeamId, string TeamName, string Role, string InvitedBy, DateTimeOffset ExpiresAt);

public sealed record MyInvitationListDto(IReadOnlyList<MyInvitationDto> Items);

/// <summary>
/// Teams (E48.7): Owners, Admins, Members and Viewers sharing a sync scope. Owners do everything
/// and are the only ones who touch other Owners and Admins or delete the team; Admins invite and
/// manage Members and Viewers; Members read and write the team's items; Viewers only read them.
/// A team always keeps an Owner. A team an account is not in is "not found".
/// </summary>
internal static class TeamEndpoints
{
    public const int NameMax = 80;
    public static readonly TimeSpan InvitationLifetime = TimeSpan.FromDays(7);

    public static RouteGroupBuilder MapTeams(this RouteGroupBuilder api)
    {
        var teams = api.MapGroup("/teams").RequireAuthorization(Policies.Account);
        teams.MapGet("", ListAsync);
        teams.MapPost("", CreateAsync);
        teams.MapGet("/{id:long}", GetAsync);
        teams.MapPatch("/{id:long}", RenameAsync).Accepts<TeamRequest>("application/merge-patch+json");
        teams.MapDelete("/{id:long}", DeleteAsync);
        teams.MapGet("/{id:long}/members", MembersAsync);
        teams.MapPatch("/{id:long}/members/{userId:long}", ChangeRoleAsync).Accepts<JsonObject>("application/merge-patch+json");
        teams.MapDelete("/{id:long}/members/{userId:long}", RemoveMemberAsync);
        teams.MapGet("/{id:long}/invitations", InvitationsAsync);
        teams.MapPost("/{id:long}/invitations", InviteAsync).RequireRateLimiting(AuthRateLimits.Policy);
        teams.MapDelete("/{id:long}/invitations/{invitationId:long}", WithdrawAsync);
        teams.MapGet("/{id:long}/activities", ActivityAsync);

        var mine = api.MapGroup("/invitations").RequireAuthorization(Policies.Account);
        mine.MapGet("", MyInvitationsAsync);
        mine.MapPost("/{id:long}/acceptances", AcceptAsync);
        mine.MapDelete("/{id:long}", DeclineAsync);
        return api;
    }

    private static long Me(HttpContext http) => long.Parse(http.User.FindFirstValue(ClaimTypes.NameIdentifier)!, CultureInfo.InvariantCulture);

    private static ProblemHttpResult NotFound() => ApiProblems.Of(ProblemTypes.NotFound, "There is no such team for this account.");

    private static ProblemHttpResult Forbidden(string detail) => ApiProblems.Of(ProblemTypes.Forbidden, detail);

    private static async Task<(Team Team, string Role)?> MembershipAsync(AppDbContext db, long teamId, long userId)
    {
        var row = await db.TeamMembers.Where(m => m.TeamId == teamId && m.UserId == userId)
            .Join(db.Teams, m => m.TeamId, t => t.Id, (m, t) => new { Team = t, m.Role })
            .SingleOrDefaultAsync();
        return row is null ? null : (row.Team, row.Role);
    }

    private static async Task<TeamDto> ToDtoAsync(AppDbContext db, Team team, string role)
    {
        var count = await db.TeamMembers.CountAsync(m => m.TeamId == team.Id);
        var scope = await db.SyncScopes.Where(s => s.TeamId == team.Id).Select(s => s.Id).SingleAsync();
        return TeamMapper.ToDto(team, role, count, scope);
    }

    private static string? NameProblem(string? name) =>
        string.IsNullOrWhiteSpace(name) || name.Trim().Length > NameMax ? $"Name the team, up to {NameMax} characters." : null;

    private static async Task<Ok<TeamListDto>> ListAsync(HttpContext http, AppDbContext db)
    {
        var me = Me(http);
        var rows = await db.TeamMembers.Where(m => m.UserId == me)
            .Join(db.Teams, m => m.TeamId, t => t.Id, (m, t) => new { Team = t, m.Role })
            .OrderBy(r => r.Team.Name)
            .ToListAsync();
        var items = new List<TeamDto>();
        foreach (var row in rows)
        {
            items.Add(await ToDtoAsync(db, row.Team, row.Role));
        }

        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(new TeamListDto(items));
    }

    private static async Task<Results<Created<TeamDto>, ValidationProblem>> CreateAsync(
        TeamRequest request, HttpContext http, AppDbContext db, ActivityLog activity, TimeProvider time)
    {
        if (NameProblem(request.Name) is { } problem)
        {
            return ApiProblems.Invalid("name", problem);
        }

        var me = Me(http);
        var now = time.GetUtcNow();
        await using var transaction = await db.Database.BeginTransactionAsync();
        var team = new Team { Name = request.Name!.Trim(), CreatedAt = now, CreatedBy = me };
        db.Teams.Add(team);
        await db.SaveChangesAsync();
        db.TeamMembers.Add(new TeamMember { TeamId = team.Id, UserId = me, Role = TeamRoles.Owner, JoinedAt = now });
        db.SyncScopes.Add(new SyncScope { Kind = SyncScopeKinds.Team, TeamId = team.Id, CreatedAt = now });
        activity.Add(me, ActivityActions.TeamCreated, new { name = team.Name }, team.Id);
        await db.SaveChangesAsync();
        await transaction.CommitAsync();
        return TypedResults.Created($"/api/v1/teams/{team.Id}", await ToDtoAsync(db, team, TeamRoles.Owner));
    }

    private static async Task<Results<Ok<TeamDto>, ProblemHttpResult>> GetAsync(long id, HttpContext http, AppDbContext db)
    {
        if (await MembershipAsync(db, id, Me(http)) is not { } membership)
        {
            return NotFound();
        }

        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(await ToDtoAsync(db, membership.Team, membership.Role));
    }

    private static async Task<Results<Ok<TeamDto>, ValidationProblem, ProblemHttpResult>> RenameAsync(
        long id, HttpContext http, AppDbContext db, ActivityLog activity)
    {
        var me = Me(http);
        if (await MembershipAsync(db, id, me) is not { } membership)
        {
            return NotFound();
        }

        if (!TeamRoles.CanManage(membership.Role))
        {
            return Forbidden("Only the team's Owners and Admins can rename it.");
        }

        var body = await ReadObjectAsync(http);
        var name = body?["name"] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
        if (body is null || body.Any(p => p.Key != "name") || NameProblem(name) is not null)
        {
            return ApiProblems.Invalid("name", $"Name the team, up to {NameMax} characters.");
        }

        membership.Team.Name = name!.Trim();
        activity.Add(me, ActivityActions.TeamUpdated, new { name = membership.Team.Name }, id);
        await db.SaveChangesAsync();
        return TypedResults.Ok(await ToDtoAsync(db, membership.Team, membership.Role));
    }

    private static async Task<Results<NoContent, ValidationProblem, ProblemHttpResult>> DeleteAsync(
        long id,
        [FromBody] StepUpRequest request,
        HttpContext http,
        AppDbContext db,
        UserManager<AppUser> users,
        AccountSessions sessions,
        ActivityLog activity,
        TimeProvider time)
    {
        var me = Me(http);
        if (await MembershipAsync(db, id, me) is not { } membership)
        {
            return NotFound();
        }

        if (membership.Role != TeamRoles.Owner)
        {
            return Forbidden("Only an Owner can delete the team.");
        }

        if (await StepUp.ProblemsAsync(users, (await users.GetUserAsync(http.User))!, request, sessions, http, time) is { } problems)
        {
            return ApiProblems.Invalid(problems);
        }

        await using var transaction = await db.Database.BeginTransactionAsync();
        activity.Add(me, ActivityActions.TeamDeleted, new { name = membership.Team.Name });
        await db.SaveChangesAsync();
        await TeamRemoval.DeleteTeamAsync(db, id);
        await transaction.CommitAsync();
        return TypedResults.NoContent();
    }

    private static async Task<Results<Ok<TeamMemberListDto>, ProblemHttpResult>> MembersAsync(long id, HttpContext http, AppDbContext db)
    {
        if (await MembershipAsync(db, id, Me(http)) is null)
        {
            return NotFound();
        }

        var members = await db.TeamMembers.Where(m => m.TeamId == id)
            .Join(db.Users, m => m.UserId, u => u.Id, (m, u) => new TeamMemberRow { Member = m, User = u })
            .ProjectToDto()
            .ToListAsync();
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(new TeamMemberListDto([.. members.OrderBy(m => TeamRoles.All.ToList().IndexOf(m.Role)).ThenBy(m => m.DisplayName, StringComparer.OrdinalIgnoreCase)]));
    }

    /// <summary>
    /// Whether <paramref name="actorRole"/> may change or remove someone who is or would become
    /// <paramref name="targetRole"/>: Owners anyone, Admins only Members and Viewers.
    /// </summary>
    private static bool MayManage(string actorRole, string targetRole) =>
        actorRole == TeamRoles.Owner || (actorRole == TeamRoles.Admin && targetRole is TeamRoles.Member or TeamRoles.Viewer);

    private static async Task<bool> IsLastOwnerAsync(AppDbContext db, long teamId, long userId) =>
        !await db.TeamMembers.AnyAsync(m => m.TeamId == teamId && m.UserId != userId && m.Role == TeamRoles.Owner);

    private static async Task<Results<Ok<TeamMemberDto>, ValidationProblem, ProblemHttpResult>> ChangeRoleAsync(
        long id,
        long userId,
        HttpContext http,
        AppDbContext db,
        UserManager<AppUser> users,
        AccountSessions sessions,
        ActivityLog activity,
        Billing.IPlanEnforcement enforcement,
        TimeProvider time)
    {
        var me = Me(http);
        if (await MembershipAsync(db, id, me) is not { } mine)
        {
            return NotFound();
        }

        var body = await ReadObjectAsync(http);
        var role = body?["role"] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
        if (body is null || body.Any(p => p.Key is not ("role" or "password" or "code")) || role is null || !TeamRoles.All.Contains(role))
        {
            return ApiProblems.Invalid("role", "role is owner, admin, member or viewer.");
        }

        var target = await db.TeamMembers.SingleOrDefaultAsync(m => m.TeamId == id && m.UserId == userId);
        if (target is null)
        {
            return ApiProblems.Of(ProblemTypes.NotFound, "That account is not in the team.");
        }

        if (!MayManage(mine.Role, target.Role) || !MayManage(mine.Role, role))
        {
            return Forbidden("Admins manage Members and Viewers; only Owners change Owners and Admins.");
        }

        var stepUp = new StepUpRequest(body["password"]?.GetValue<string>(), body["code"]?.GetValue<string>());
        if (await StepUp.ProblemsAsync(users, (await users.GetUserAsync(http.User))!, stepUp, sessions, http, time) is { } problems)
        {
            return ApiProblems.Invalid(problems);
        }

        if (target.Role == TeamRoles.Owner && role != TeamRoles.Owner && await IsLastOwnerAsync(db, id, userId))
        {
            return ApiProblems.Of(ProblemTypes.Conflict, "A team needs an Owner. Make someone else an Owner first.");
        }

        var before = target.Role;
        target.Role = role;
        activity.Add(me, ActivityActions.MemberRoleChanged, new { userId, from = before, to = role }, id);
        await db.SaveChangesAsync();
        if (before == TeamRoles.Owner || role == TeamRoles.Owner)
        {
            // The team's online monitors use its owners' account type.
            await enforcement.TeamChangedAsync(id);
        }

        var user = await db.Users.SingleAsync(u => u.Id == userId);
        return TypedResults.Ok(TeamMapper.ToDto(new TeamMemberRow { Member = target, User = user }));
    }

    /// <summary>Removes a member, or leaves when it is the caller. Their access to the team's items ends at once.</summary>
    private static async Task<Results<NoContent, ValidationProblem, ProblemHttpResult>> RemoveMemberAsync(
        long id,
        long userId,
        [FromBody] StepUpRequest request,
        HttpContext http,
        AppDbContext db,
        UserManager<AppUser> users,
        AccountSessions sessions,
        ActivityLog activity,
        Billing.IPlanEnforcement enforcement,
        TimeProvider time)
    {
        var me = Me(http);
        if (await MembershipAsync(db, id, me) is not { } mine)
        {
            return NotFound();
        }

        var target = await db.TeamMembers.SingleOrDefaultAsync(m => m.TeamId == id && m.UserId == userId);
        if (target is null)
        {
            return ApiProblems.Of(ProblemTypes.NotFound, "That account is not in the team.");
        }

        var leaving = userId == me;
        if (!leaving && !MayManage(mine.Role, target.Role))
        {
            return Forbidden("Admins remove Members and Viewers; only Owners remove Owners and Admins.");
        }

        if (target.Role == TeamRoles.Owner && await IsLastOwnerAsync(db, id, userId))
        {
            return ApiProblems.Of(ProblemTypes.Conflict, "A team needs an Owner. Make someone else an Owner, or delete the team.");
        }

        if (!leaving && await StepUp.ProblemsAsync(users, (await users.GetUserAsync(http.User))!, request, sessions, http, time) is { } problems)
        {
            return ApiProblems.Invalid(problems);
        }

        db.TeamMembers.Remove(target);
        activity.Add(me, leaving ? ActivityActions.TeamLeft : ActivityActions.MemberRemoved, new { userId }, id);
        await db.SaveChangesAsync();
        if (target.Role == TeamRoles.Owner)
        {
            await enforcement.TeamChangedAsync(id);
        }

        return TypedResults.NoContent();
    }

    private static async Task<Results<Ok<TeamInvitationListDto>, ProblemHttpResult>> InvitationsAsync(
        long id, HttpContext http, AppDbContext db, TimeProvider time)
    {
        if (await MembershipAsync(db, id, Me(http)) is not { } mine)
        {
            return NotFound();
        }

        if (!TeamRoles.CanManage(mine.Role))
        {
            return Forbidden("Only the team's Owners and Admins see its invitations.");
        }

        var now = time.GetUtcNow();
        var items = await db.TeamInvitations.Where(i => i.TeamId == id && i.ExpiresAt > now)
            .OrderBy(i => i.CreatedAt)
            .ProjectToDto()
            .ToListAsync();
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(new TeamInvitationListDto(items));
    }

    private static async Task<Results<Created<TeamInvitationDto>, ValidationProblem, ProblemHttpResult>> InviteAsync(
        long id,
        TeamInvitationRequest request,
        HttpContext http,
        AppDbContext db,
        UserManager<AppUser> users,
        ActivityLog activity,
        EmailOutbox outbox,
        IConfiguration configuration,
        TimeProvider time)
    {
        var me = Me(http);
        if (await MembershipAsync(db, id, me) is not { } mine)
        {
            return NotFound();
        }

        var email = request.Email?.Trim() ?? "";
        var errors = new Dictionary<string, string[]>();
        if (!AccountEndpoints.IsEmail(email))
        {
            errors["email"] = ["Enter an email address, like kim@example.com."];
        }

        if (request.Role is null || !TeamRoles.All.Contains(request.Role))
        {
            errors["role"] = ["role is owner, admin, member or viewer."];
        }

        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        if (!TeamRoles.CanManage(mine.Role) || !MayManage(mine.Role, request.Role!))
        {
            return Forbidden("Admins invite Members and Viewers; only Owners invite Owners and Admins.");
        }

        var normalized = users.NormalizeEmail(email);
        var alreadyIn = await db.TeamMembers.Where(m => m.TeamId == id)
            .Join(db.Users, m => m.UserId, u => u.Id, (m, u) => u.NormalizedEmail)
            .AnyAsync(e => e == normalized);
        if (alreadyIn)
        {
            return ApiProblems.Of(ProblemTypes.Conflict, "That account is in the team already.");
        }

        var now = time.GetUtcNow();
        await db.TeamInvitations.Where(i => i.TeamId == id && i.NormalizedEmail == normalized).ExecuteDeleteAsync();
        var invitation = new TeamInvitation
        {
            TeamId = id,
            Email = email,
            NormalizedEmail = normalized,
            Role = request.Role!,
            InvitedBy = me,
            CreatedAt = now,
            ExpiresAt = now + InvitationLifetime,
        };
        db.TeamInvitations.Add(invitation);
        var inviter = (await users.GetUserAsync(http.User))!;
        outbox.Add(email, EmailTemplates.TeamInvitation(inviter.DisplayName, mine.Team.Name, Capitalize(request.Role!), $"{SiteUrl.From(configuration)}/account/invitations"));
        activity.Add(me, ActivityActions.MemberInvited, new { email, role = request.Role }, id);
        await db.SaveChangesAsync();
        outbox.SendSoon();
        return TypedResults.Created((string?)null, TeamMapper.ToDto(invitation));
    }

    private static async Task<Results<NoContent, ProblemHttpResult>> WithdrawAsync(
        long id, long invitationId, HttpContext http, AppDbContext db)
    {
        if (await MembershipAsync(db, id, Me(http)) is not { } mine)
        {
            return NotFound();
        }

        if (!TeamRoles.CanManage(mine.Role))
        {
            return Forbidden("Only the team's Owners and Admins take invitations back.");
        }

        return await db.TeamInvitations.Where(i => i.Id == invitationId && i.TeamId == id).ExecuteDeleteAsync() == 1
            ? TypedResults.NoContent()
            : ApiProblems.Of(ProblemTypes.NotFound, "There is no such invitation.");
    }

    private static async Task<Results<Ok<Page<ActivityDto>>, ValidationProblem, ProblemHttpResult>> ActivityAsync(
        long id, int? page, int? pageSize, HttpContext http, AppDbContext db)
    {
        if (await MembershipAsync(db, id, Me(http)) is not { } mine)
        {
            return NotFound();
        }

        if (!TeamRoles.CanManage(mine.Role))
        {
            return Forbidden("Only the team's Owners and Admins read its activity.");
        }

        var request = PageRequest.Parse(page, pageSize, out var errors);
        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        var query = db.AccountActivities.AsNoTracking().Where(a => a.TeamId == id);
        var total = await query.CountAsync();
        var rows = await query.OrderByDescending(a => a.At).ThenByDescending(a => a.Id).Skip(request.Skip).Take(request.Size).ToListAsync();
        var result = Page.Of(rows.Select(AccountMapper.ToDto).ToList(), request, total);
        PageLinks.Set(http, result);
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(result);
    }

    private static async Task<IQueryable<TeamInvitation>> OpenForAsync(HttpContext http, AppDbContext db, UserManager<AppUser> users, TimeProvider time)
    {
        var user = await users.GetUserAsync(http.User);
        var email = user is { EmailConfirmed: true } ? user.NormalizedEmail : null;
        var now = time.GetUtcNow();
        return db.TeamInvitations.Where(i => email != null && i.NormalizedEmail == email && i.ExpiresAt > now);
    }

    private static async Task<Ok<MyInvitationListDto>> MyInvitationsAsync(
        HttpContext http, AppDbContext db, UserManager<AppUser> users, TimeProvider time)
    {
        var items = await (await OpenForAsync(http, db, users, time))
            .Join(db.Teams, i => i.TeamId, t => t.Id, (i, t) => new { i, t })
            .Join(db.Users, x => x.i.InvitedBy, u => u.Id, (x, u) => new MyInvitationRow { Invitation = x.i, Team = x.t, Inviter = u })
            .ProjectToDto()
            .ToListAsync();
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(new MyInvitationListDto(items));
    }

    private static async Task<Results<Created<TeamDto>, ProblemHttpResult>> AcceptAsync(
        long id, HttpContext http, AppDbContext db, UserManager<AppUser> users, ActivityLog activity, TimeProvider time)
    {
        var me = Me(http);
        var invitation = await (await OpenForAsync(http, db, users, time)).SingleOrDefaultAsync(i => i.Id == id);
        if (invitation is null)
        {
            return ApiProblems.Of(ProblemTypes.NotFound, "There is no such invitation for this account, or it expired.");
        }

        await using var transaction = await db.Database.BeginTransactionAsync();
        db.TeamInvitations.Remove(invitation);
        if (!await db.TeamMembers.AnyAsync(m => m.TeamId == invitation.TeamId && m.UserId == me))
        {
            db.TeamMembers.Add(new TeamMember { TeamId = invitation.TeamId, UserId = me, Role = invitation.Role, JoinedAt = time.GetUtcNow() });
        }

        activity.Add(me, ActivityActions.MemberJoined, new { role = invitation.Role }, invitation.TeamId);
        await db.SaveChangesAsync();
        await transaction.CommitAsync();
        var team = await db.Teams.SingleAsync(t => t.Id == invitation.TeamId);
        var role = await db.TeamMembers.Where(m => m.TeamId == team.Id && m.UserId == me).Select(m => m.Role).SingleAsync();
        return TypedResults.Created($"/api/v1/teams/{team.Id}", await ToDtoAsync(db, team, role));
    }

    private static async Task<Results<NoContent, ProblemHttpResult>> DeclineAsync(
        long id, HttpContext http, AppDbContext db, UserManager<AppUser> users, TimeProvider time)
    {
        var deleted = await (await OpenForAsync(http, db, users, time)).Where(i => i.Id == id).ExecuteDeleteAsync();
        return deleted == 1 ? TypedResults.NoContent() : ApiProblems.Of(ProblemTypes.NotFound, "There is no such invitation for this account.");
    }

    private static async Task<JsonObject?> ReadObjectAsync(HttpContext http)
    {
        try
        {
            return await JsonNode.ParseAsync(http.Request.Body, cancellationToken: http.RequestAborted) as JsonObject;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string Capitalize(string role) => char.ToUpperInvariant(role[0]) + role[1..];
}

/// <summary>Deleting a team and everything only it held: members, invitations, its scope and synced records.</summary>
internal static class TeamRemoval
{
    public static async Task DeleteTeamAsync(AppDbContext db, long teamId)
    {
        var scopes = db.SyncScopes.Where(s => s.TeamId == teamId).Select(s => s.Id);
        await db.SyncRecords.Where(r => scopes.Contains(r.ScopeId)).ExecuteDeleteAsync();
        await db.SyncScopes.Where(s => s.TeamId == teamId).ExecuteDeleteAsync();
        await db.TeamInvitations.Where(i => i.TeamId == teamId).ExecuteDeleteAsync();
        await db.TeamMembers.Where(m => m.TeamId == teamId).ExecuteDeleteAsync();
        await db.Teams.Where(t => t.Id == teamId).ExecuteDeleteAsync();
    }
}
