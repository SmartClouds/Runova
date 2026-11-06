using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Api.Dependencies;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Paging;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Paging;
using Runova.Website.Core.Problems;
using Runova.Website.Data;
using Runova.Website.Data.Dependencies;

namespace Runova.Website.Api.Notifications;

public sealed record UserNotificationDto(
    long Id,
    string Kind,
    string Title,
    string Body,
    string? Severity,
    long? ScopeId,
    string? ItemId,
    long? InventoryId,
    DateTimeOffset CreatedAt,
    DateTimeOffset? ReadAt);

public sealed record NotificationPageDto(
    IReadOnlyList<UserNotificationDto> Items,
    [property: System.Text.Json.Serialization.JsonPropertyName("page")] int Number,
    int PageSize,
    int TotalItems,
    int TotalPages,
    int Unread);

public sealed record NotificationReadMarkerRequest(DateTimeOffset? Before);

public sealed record NotificationReadMarkerDto(int Marked);

/// <summary>An account's messages, newest first, and marking them read (E51).</summary>
internal static class NotificationEndpoints
{
    public static RouteGroupBuilder MapNotifications(this RouteGroupBuilder api)
    {
        var notifications = api.MapGroup("/notifications").RequireAuthorization(Policies.Account);
        notifications.MapGet("", ListAsync);
        notifications.MapPatch("/{id:long}", PatchAsync).Accepts<JsonObject>("application/merge-patch+json");
        api.MapPost("/notification-read-markers", MarkAllAsync).RequireAuthorization(Policies.Account);
        return api;
    }

    internal static UserNotificationDto ToDto(UserNotification n) =>
        new(n.Id, n.Kind, n.Title, n.Body, n.Severity, n.ScopeId, n.ItemId, n.InventoryId, n.CreatedAt, n.ReadAt);

    private static async Task<Results<Ok<NotificationPageDto>, ValidationProblem>> ListAsync(
        int? page, int? pageSize, bool? unread, HttpContext http, AppDbContext db)
    {
        var request = PageRequest.Parse(page, pageSize, out var errors);
        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        var userId = CurrentAccount.Id(http);
        var mine = db.UserNotifications.AsNoTracking().Where(n => n.UserId == userId);
        var listed = unread == true ? mine.Where(n => n.ReadAt == null) : mine;
        var total = await listed.CountAsync();
        var unreadCount = await mine.CountAsync(n => n.ReadAt == null);
        var rows = await listed.OrderByDescending(n => n.CreatedAt).ThenByDescending(n => n.Id)
            .Skip(request.Skip).Take(request.Size)
            .ToListAsync();
        var result = Page.Of([.. rows.Select(ToDto)], request, total);
        PageLinks.Set(http, result);
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(new NotificationPageDto(result.Items, result.Number, result.PageSize, result.TotalItems, result.TotalPages, unreadCount));
    }

    private static async Task<Results<Ok<UserNotificationDto>, ValidationProblem, ProblemHttpResult>> PatchAsync(
        long id, HttpContext http, AppDbContext db, TimeProvider time)
    {
        var userId = CurrentAccount.Id(http);
        if (await db.UserNotifications.SingleOrDefaultAsync(n => n.Id == id && n.UserId == userId) is not { } notification)
        {
            return ApiProblems.Of(ProblemTypes.NotFound, "There is no such notification for this account.");
        }

        JsonObject? body;
        try
        {
            body = await JsonNode.ParseAsync(http.Request.Body, cancellationToken: http.RequestAborted) as JsonObject;
        }
        catch (JsonException)
        {
            body = null;
        }

        if (body is null || body.Count != 1 || body["read"] is not JsonValue flag || !flag.TryGetValue<bool>(out var read))
        {
            return ApiProblems.Invalid("read", "Send { \"read\": true } or { \"read\": false }.");
        }

        notification.ReadAt = read ? notification.ReadAt ?? time.GetUtcNow() : null;
        await db.SaveChangesAsync();
        return TypedResults.Ok(ToDto(notification));
    }

    /// <summary>Marks every message read, or only those made before <c>before</c> so one that came in meanwhile stays new.</summary>
    private static async Task<Created<NotificationReadMarkerDto>> MarkAllAsync(
        NotificationReadMarkerRequest request, HttpContext http, AppDbContext db, TimeProvider time)
    {
        var userId = CurrentAccount.Id(http);
        var now = time.GetUtcNow();
        var before = request.Before ?? now;
        var marked = await db.UserNotifications
            .Where(n => n.UserId == userId && n.ReadAt == null && n.CreatedAt <= before)
            .ExecuteUpdateAsync(n => n.SetProperty(x => x.ReadAt, now));
        return TypedResults.Created((string?)null, new NotificationReadMarkerDto(marked));
    }
}
