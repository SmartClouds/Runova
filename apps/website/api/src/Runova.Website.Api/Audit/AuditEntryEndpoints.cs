using System.Globalization;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Paging;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Audit;
using Runova.Website.Core.Paging;
using Runova.Website.Data;
using Runova.Website.Data.Audit;

namespace Runova.Website.Api.Audit;

/// <summary>
/// An audit entry as the API shows it. The JSON of what changed stays in the database: it is for
/// someone reading the table, and leaving it out keeps the response free of anything sensitive.
/// </summary>
public sealed record AuditEntryDto(
    long Id, DateTimeOffset At, string ActorKind, long? ActorId, string Action, string TargetType, string TargetId, string? Ip);

/// <summary>The audit trail, newest first, for Admins only. Entries are only read here, never changed.</summary>
internal static class AuditEntryEndpoints
{
    public static RouteGroupBuilder MapAuditEntries(this RouteGroupBuilder api)
    {
        api.MapGet("/audit-entries", ListAsync).RequireAuthorization(Policies.Admin);
        return api;
    }

    private static async Task<Results<Ok<Page<AuditEntryDto>>, ValidationProblem>> ListAsync(
        int? page,
        int? pageSize,
        long? actorId,
        string? actorKind,
        string? action,
        string? targetType,
        string? since,
        AppDbContext db,
        HttpContext http)
    {
        var request = PageRequest.Parse(page, pageSize, out var errors);
        if (actorKind is not null && !AuditActorKinds.All.Contains(actorKind))
        {
            errors["actorKind"] = [$"actorKind is one of {string.Join(", ", AuditActorKinds.All.Order(StringComparer.Ordinal))}."];
        }

        if (action is not null && !AuditActions.All.Contains(action))
        {
            errors["action"] = ["action is one of the audit actions in the contract, such as user.invite."];
        }

        if (targetType is not null && !AuditTargetTypes.All.Contains(targetType))
        {
            errors["targetType"] = [$"targetType is one of {string.Join(", ", AuditTargetTypes.All.Order(StringComparer.Ordinal))}."];
        }

        DateTimeOffset? from = null;
        if (since is not null)
        {
            if (DateTimeOffset.TryParse(since, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var time))
            {
                from = time.ToUniversalTime();
            }
            else
            {
                errors["since"] = ["since is an RFC 3339 time, such as 2026-10-30T12:00:00.000Z."];
            }
        }

        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        IQueryable<AuditEntry> query = db.AuditEntries.AsNoTracking();
        if (actorId is { } id)
        {
            query = query.Where(e => e.ActorId == id);
        }

        if (actorKind is not null)
        {
            query = query.Where(e => e.ActorKind == actorKind);
        }

        if (action is not null)
        {
            query = query.Where(e => e.Action == action);
        }

        if (targetType is not null)
        {
            query = query.Where(e => e.TargetType == targetType);
        }

        if (from is { } at)
        {
            query = query.Where(e => e.At >= at);
        }

        var total = await query.CountAsync();
        var items = await query
            .OrderByDescending(e => e.At).ThenByDescending(e => e.Id)
            .Skip(request.Skip).Take(request.Size)
            .Select(e => new AuditEntryDto(e.Id, e.At, e.ActorKind, e.ActorId, e.Action, e.TargetType, e.TargetId, e.Ip))
            .ToListAsync();

        var result = Page.Of(items, request, total);
        PageLinks.Set(http, result);
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(result);
    }
}
