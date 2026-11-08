using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Api.Accounts;
using Runova.Website.Api.Dependencies;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Paging;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Paging;
using Runova.Website.Core.Problems;
using Runova.Website.Data;
using Runova.Website.Data.Accounts;
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
    DateTimeOffset? ReadAt,
    string Category);

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

    private static async Task<Results<Ok<NotificationPageDto>, ValidationProblem>> ListAsync(
        int? page, int? pageSize, bool? unread, HttpContext http, AppDbContext db, AccountSessions sessions, NotificationPreferenceStore preferences)
    {
        var request = PageRequest.Parse(page, pageSize, out var errors);
        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        var userId = CurrentAccount.Id(http);
        var mine = await VisibleAsync(db.UserNotifications.AsNoTracking().Where(n => n.UserId == userId), userId, http, sessions, preferences);
        var listed = unread == true ? mine.Where(n => n.ReadAt == null) : mine;
        var total = await listed.CountAsync();
        var unreadCount = await mine.CountAsync(n => n.ReadAt == null);
        var rows = await listed.OrderByDescending(n => n.CreatedAt).ThenByDescending(n => n.Id)
            .Skip(request.Skip).Take(request.Size)
            .ToListAsync();
        var result = Page.Of([.. rows.Select(NotificationMapper.ToDto)], request, total);
        PageLinks.Set(http, result);
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(new NotificationPageDto(result.Items, result.Number, result.PageSize, result.TotalItems, result.TotalPages, unreadCount));
    }

    private static async Task<Results<Ok<UserNotificationDto>, ValidationProblem, ProblemHttpResult>> PatchAsync(
        long id, HttpContext http, AppDbContext db, TimeProvider time, AccountSessions sessions, NotificationPreferenceStore preferences)
    {
        var userId = CurrentAccount.Id(http);
        var mine = await VisibleAsync(db.UserNotifications.Where(n => n.UserId == userId), userId, http, sessions, preferences);
        if (await mine.SingleOrDefaultAsync(n => n.Id == id) is not { } notification)
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
        return TypedResults.Ok(NotificationMapper.ToDto(notification));
    }

    /// <summary>Marks every message read, or only those made before <c>before</c> so one that came in meanwhile stays new.</summary>
    private static async Task<Created<NotificationReadMarkerDto>> MarkAllAsync(
        NotificationReadMarkerRequest request, HttpContext http, AppDbContext db, TimeProvider time, AccountSessions sessions, NotificationPreferenceStore preferences)
    {
        var userId = CurrentAccount.Id(http);
        var now = time.GetUtcNow();
        var before = request.Before ?? now;
        var mine = await VisibleAsync(db.UserNotifications.Where(n => n.UserId == userId), userId, http, sessions, preferences);
        var marked = await mine
            .Where(n => n.ReadAt == null && n.CreatedAt <= before)
            .ExecuteUpdateAsync(n => n.SetProperty(x => x.ReadAt, now));
        return TypedResults.Created((string?)null, new NotificationReadMarkerDto(marked));
    }

    /// <summary>
    /// What this sign-in can see of the account's messages. The desktop's forwarded events exist
    /// only for phones, and a phone does not see a category turned off (E82).
    /// </summary>
    private static async Task<IQueryable<UserNotification>> VisibleAsync(
        IQueryable<UserNotification> mine, long userId, HttpContext http, AccountSessions sessions, NotificationPreferenceStore preferences)
    {
        var session = AccountSessions.SessionId(http.User) is { } sessionId ? await sessions.FindLiveAsync(sessionId, userId) : null;
        if (session?.Kind != AccountSessionKinds.Mobile)
        {
            var forwarded = NotificationCategories.ForwardedKinds;
            return mine.Where(n => !forwarded.Contains(n.Kind));
        }

        var off = NotificationCategories.KindsOf(await preferences.OffForAsync(userId));
        return off.Count == 0 ? mine : mine.Where(n => !off.Contains(n.Kind));
    }
}
