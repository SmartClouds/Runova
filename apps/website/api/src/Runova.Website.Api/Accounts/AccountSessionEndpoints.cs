using System.Text.Json;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Paging;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Accounts;
using Runova.Website.Core.Identity;
using Runova.Website.Core.Paging;
using Runova.Website.Core.Problems;
using Runova.Website.Data;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Accounts;

/// <summary>
/// An account's own sessions and activity, and deleting the account. Ending every other session and
/// deleting the account need a step-up (<see cref="StepUp"/>).
/// </summary>
internal static class AccountSessionEndpoints
{
    public static RouteGroupBuilder MapAccountSessions(this RouteGroupBuilder api)
    {
        api.MapGet("/sessions", ListAsync).RequireAuthorization(Policies.Account);
        api.MapDelete("/sessions", EndOthersAsync).RequireAuthorization(Policies.Account);
        api.MapDelete("/sessions/{id:long}", EndAsync).RequireAuthorization(Policies.Account);
        api.MapGet("/activities", ListActivityAsync).RequireAuthorization(Policies.Account);
        api.MapDelete("/accounts/me", DeleteAccountAsync).RequireAuthorization(Policies.Account);
        return api;
    }

    private static async Task<Results<Ok<SessionListDto>, UnauthorizedHttpResult>> ListAsync(
        HttpContext http, UserManager<AppUser> users, AppDbContext db)
    {
        if (await users.GetUserAsync(http.User) is not { } user)
        {
            return TypedResults.Unauthorized();
        }

        var current = AccountSessions.SessionId(http.User);
        var sessions = await db.AccountSessions.AsNoTracking()
            .Where(s => s.UserId == user.Id && s.RevokedAt == null)
            .OrderByDescending(s => s.LastSeenAt).ThenByDescending(s => s.Id)
            .Take(200)
            .Select(s => new SessionDto(s.Id, s.Kind, s.DeviceName, s.Platform, s.AppVersion, s.LastIp, s.CreatedAt, s.LastSeenAt, s.Id == current))
            .ToListAsync();
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(new SessionListDto([.. sessions.OrderByDescending(s => s.Current)]));
    }

    private static async Task<Results<NoContent, ProblemHttpResult, UnauthorizedHttpResult>> EndAsync(
        long id, HttpContext http, UserManager<AppUser> users, AppDbContext db, AccountSessions sessions, ActivityLog activity)
    {
        if (await users.GetUserAsync(http.User) is not { } user)
        {
            return TypedResults.Unauthorized();
        }

        var device = await db.AccountSessions.Where(s => s.Id == id && s.UserId == user.Id).Select(s => s.DeviceName).SingleOrDefaultAsync();
        if (device is null || !await sessions.RevokeAsync(user.Id, id))
        {
            return ApiProblems.Of(ProblemTypes.NotFound, "There is no such session, or it has ended already.");
        }

        activity.Add(user.Id, ActivityActions.SessionEnded, new { sessionId = id, device });
        await db.SaveChangesAsync();
        return TypedResults.NoContent();
    }

    private static async Task<Results<NoContent, ValidationProblem, UnauthorizedHttpResult>> EndOthersAsync(
        [FromBody] StepUpRequest request,
        HttpContext http,
        UserManager<AppUser> users,
        AppDbContext db,
        AccountSessions sessions,
        ActivityLog activity,
        TimeProvider time)
    {
        if (await users.GetUserAsync(http.User) is not { } user)
        {
            return TypedResults.Unauthorized();
        }

        if (await StepUp.ProblemsAsync(users, user, request, sessions, http, time) is { } problems)
        {
            return ApiProblems.Invalid(problems);
        }

        var ended = await sessions.RevokeAllAsync(user.Id, AccountSessions.SessionId(http.User));
        activity.Add(user.Id, ActivityActions.SessionsEnded, new { count = ended });
        await db.SaveChangesAsync();
        return TypedResults.NoContent();
    }

    private static async Task<Results<Ok<Page<ActivityDto>>, ValidationProblem, UnauthorizedHttpResult>> ListActivityAsync(
        int? page, int? pageSize, string? action, HttpContext http, UserManager<AppUser> users, AppDbContext db)
    {
        if (await users.GetUserAsync(http.User) is not { } user)
        {
            return TypedResults.Unauthorized();
        }

        var request = PageRequest.Parse(page, pageSize, out var errors);
        if (action is { Length: > 48 })
        {
            errors["action"] = ["action is one of the activity actions in the contract, such as sign-in."];
        }

        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        var query = db.AccountActivities.AsNoTracking().Where(a => a.UserId == user.Id);
        if (action is not null)
        {
            query = query.Where(a => a.Action == action);
        }

        var total = await query.CountAsync();
        var rows = await query
            .OrderByDescending(a => a.At).ThenByDescending(a => a.Id)
            .Skip(request.Skip).Take(request.Size)
            .ToListAsync();
        var items = rows.Select(ToDto).ToList();

        var result = Page.Of(items, request, total);
        PageLinks.Set(http, result);
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(result);
    }

    internal static ActivityDto ToDto(Data.Accounts.AccountActivity a) =>
        new(a.Id, a.Action, a.TeamId, a.Ip, a.Device, a.At, a.Details is null ? null : JsonSerializer.Deserialize<Dictionary<string, object?>>(a.Details));

    /// <summary>
    /// Deletes the account and everything that belongs only to it: sessions, activity, links, and
    /// (with E48.6 and E48.7) its synced data and memberships. Staff are removed by an Admin instead.
    /// </summary>
    private static async Task<Results<NoContent, ValidationProblem, ProblemHttpResult, UnauthorizedHttpResult>> DeleteAccountAsync(
        [FromBody] StepUpRequest request,
        HttpContext http,
        UserManager<AppUser> users,
        SignInManager<AppUser> signIn,
        AccountSessions sessions,
        AccountDeletion deletion,
        TimeProvider time)
    {
        if (await users.GetUserAsync(http.User) is not { } user)
        {
            return TypedResults.Unauthorized();
        }

        var roles = await users.GetRolesAsync(user);
        if (roles.Contains(Roles.Admin) || roles.Contains(Roles.Editor))
        {
            return ApiProblems.Of(ProblemTypes.Conflict, "A staff account is removed by an Admin, not from here.");
        }

        if (await StepUp.ProblemsAsync(users, user, request, sessions, http, time) is { } problems)
        {
            return ApiProblems.Invalid(problems);
        }

        if (await AccountDeletion.BlockerAsync(user) is { } blocker)
        {
            return ApiProblems.Of(ProblemTypes.Conflict, blocker);
        }

        await sessions.RevokeAllAsync(user.Id, keep: null);
        await deletion.DeleteAsync(user);
        await signIn.Context.SignOutAsync(IdentityConstants.ApplicationScheme);
        return TypedResults.NoContent();
    }
}

/// <summary>
/// What deleting an account takes with it. Later tasks add the account's sync scope and its team
/// memberships; a team it owns alone with other members in it must be handed over first.
/// </summary>
internal sealed class AccountDeletion(UserManager<AppUser> users)
{
    /// <summary>Why the account can not be deleted yet, or null. Nothing blocks it until teams arrive (E48.7).</summary>
    public static Task<string?> BlockerAsync(AppUser user)
    {
        ArgumentNullException.ThrowIfNull(user);
        return Task.FromResult<string?>(null);
    }

    public async Task DeleteAsync(AppUser user)
    {
        var result = await users.DeleteAsync(user);
        if (!result.Succeeded)
        {
            throw new InvalidOperationException(string.Join(" ", result.Errors.Select(e => e.Code)));
        }
    }
}
