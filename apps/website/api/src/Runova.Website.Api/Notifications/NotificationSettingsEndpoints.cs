using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Api.Accounts;
using Runova.Website.Api.Dependencies;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Problems;
using Runova.Website.Data;
using Runova.Website.Data.Accounts;
using Runova.Website.Data.Dependencies;
using Runova.Website.Data.Notifications;

namespace Runova.Website.Api.Notifications;

public sealed record NotificationPreferenceDto(string Category, string Label, bool Enabled);

public sealed record NotificationPreferencesDto(IReadOnlyList<NotificationPreferenceDto> Items);

public sealed record NotificationPreferenceWrite(bool? Enabled);

public sealed record PushDeviceWrite(string? Platform, string? PushToken);

public sealed record PushDeviceDto(long Id, string Platform, DateTimeOffset UpdatedAt);

public sealed record NotificationListenersDto(int Count);

public sealed record NotificationEventDto(long? NotificationId);

/// <summary>
/// A phone's push token and the account's notification categories (E82), and the desktop app's way
/// of saying that something happened. Only a sign-in of kind <c>mobile</c> may hold a push token, and
/// only a computer may forward an event.
/// </summary>
internal static partial class NotificationSettingsEndpoints
{
    public const int MaxForwardedPerMinute = 60;

    public static readonly TimeSpan KeepForwardedFor = TimeSpan.FromDays(30);

    public static RouteGroupBuilder MapNotificationSettings(this RouteGroupBuilder api)
    {
        var me = api.MapGroup("/accounts/me").RequireAuthorization(Policies.Account);
        me.MapGet("/notification-preferences", ListPreferencesAsync);
        me.MapPut("/notification-preferences/{category}", SetPreferenceAsync);
        me.MapPut("/push-devices/current", RegisterAsync);
        me.MapDelete("/push-devices/current", UnregisterAsync);
        me.MapGet("/notification-listeners", ListenersAsync);
        api.MapPost("/notification-events", ForwardAsync).RequireAuthorization(Policies.Account);
        return api;
    }

    private static async Task<Ok<NotificationPreferencesDto>> ListPreferencesAsync(HttpContext http, NotificationPreferenceStore preferences)
    {
        var off = await preferences.OffForAsync(CurrentAccount.Id(http));
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(new NotificationPreferencesDto([.. NotificationCategories.All.Select(c => NotificationMapper.ToDto(c, !off.Contains(c.Id)))]));
    }

    private static async Task<Results<Ok<NotificationPreferenceDto>, ValidationProblem, ProblemHttpResult>> SetPreferenceAsync(
        string category, NotificationPreferenceWrite request, HttpContext http, NotificationPreferenceStore preferences)
    {
        if (NotificationCategories.All.SingleOrDefault(c => c.Id == category) is not { } known)
        {
            return ApiProblems.Of(ProblemTypes.NotFound, "There is no such notification category.");
        }

        if (request.Enabled is not { } enabled)
        {
            return ApiProblems.Invalid("enabled", "Send { \"enabled\": true } or { \"enabled\": false }.");
        }

        await preferences.SetAsync(CurrentAccount.Id(http), category, enabled);
        return TypedResults.Ok(NotificationMapper.ToDto(known, enabled));
    }

    private static async Task<Results<Ok<PushDeviceDto>, ValidationProblem, ProblemHttpResult>> RegisterAsync(
        PushDeviceWrite request, HttpContext http, AppDbContext db, AccountSessions sessions, TimeProvider time)
    {
        var userId = CurrentAccount.Id(http);
        if (await SessionKindAsync(http, userId, sessions) != AccountSessionKinds.Mobile)
        {
            return ApiProblems.Of(ProblemTypes.Forbidden, "Only the phone's own sign-in can register a push token.");
        }

        var errors = new Dictionary<string, string[]>();
        if (!PushPlatforms.IsKnown(request.Platform))
        {
            errors["platform"] = ["platform is android or ios."];
        }

        if (request.PushToken is null || !PushToken().IsMatch(request.PushToken))
        {
            errors["pushToken"] = ["Send the token the push service gave this phone."];
        }

        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        var sessionId = AccountSessions.SessionId(http.User)!.Value;
        var now = time.GetUtcNow();
        // A token someone else's sign-in held on this phone is this phone's now.
        await db.PushDevices.Where(d => d.PushToken == request.PushToken && d.SessionId != sessionId).ExecuteDeleteAsync();
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""
            INSERT INTO "PushDevices" ("UserId", "SessionId", "Platform", "PushToken", "UpdatedAt")
            VALUES ({userId}, {sessionId}, {request.Platform}, {request.PushToken}, {now})
            ON CONFLICT ("SessionId") DO UPDATE SET "Platform" = {request.Platform}, "PushToken" = {request.PushToken}, "UpdatedAt" = {now}
            """);
        var device = await db.PushDevices.AsNoTracking().SingleAsync(d => d.SessionId == sessionId);
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(NotificationMapper.ToDto(device));
    }

    private static async Task<NoContent> UnregisterAsync(HttpContext http, AppDbContext db)
    {
        var sessionId = AccountSessions.SessionId(http.User);
        await db.PushDevices.Where(d => d.SessionId == sessionId && d.UserId == CurrentAccount.Id(http)).ExecuteDeleteAsync();
        return TypedResults.NoContent();
    }

    private static async Task<Ok<NotificationListenersDto>> ListenersAsync(HttpContext http, AppDbContext db, TimeProvider time)
    {
        var userId = CurrentAccount.Id(http);
        var now = time.GetUtcNow();
        var count = await db.AccountSessions.CountAsync(s => s.UserId == userId && s.Kind == AccountSessionKinds.Mobile && s.RevokedAt == null && (s.RefreshExpiresAt == null || s.RefreshExpiresAt > now));
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(new NotificationListenersDto(count));
    }

    private static async Task<Results<Created<NotificationEventDto>, ValidationProblem, ProblemHttpResult>> ForwardAsync(
        NotificationEventRequest request,
        HttpContext http,
        AppDbContext db,
        AccountSessions sessions,
        NotificationPreferenceStore preferences,
        NotificationDelivery delivery,
        TimeProvider time)
    {
        var userId = CurrentAccount.Id(http);
        if (await SessionKindAsync(http, userId, sessions) != AccountSessionKinds.Desktop)
        {
            return ApiProblems.Of(ProblemTypes.Forbidden, "Only a signed-in computer can send events.");
        }

        var errors = new Dictionary<string, string[]>();
        if (PushContent.Compose(request, errors) is not { } composed)
        {
            return ApiProblems.Invalid(errors);
        }

        var now = time.GetUtcNow();
        var phones = await db.AccountSessions.AnyAsync(s => s.UserId == userId && s.Kind == AccountSessionKinds.Mobile && s.RevokedAt == null && (s.RefreshExpiresAt == null || s.RefreshExpiresAt > now));
        if (!phones || (await preferences.OffForAsync(userId)).Contains(composed.Category))
        {
            return TypedResults.Created((string?)null, new NotificationEventDto(null));
        }

        var forwarded = NotificationCategories.ForwardedKinds;
        var since = now.AddMinutes(-1);
        if (await db.UserNotifications.CountAsync(n => n.UserId == userId && forwarded.Contains(n.Kind) && n.CreatedAt > since) >= MaxForwardedPerMinute)
        {
            return ApiProblems.Of(ProblemTypes.RateLimited, "Too many notifications in the last minute.");
        }

        var notification = new UserNotification
        {
            UserId = userId,
            Kind = composed.Category,
            Title = composed.Line,
            Body = "",
            Severity = composed.Severity,
            ItemId = composed.ItemId,
            CreatedAt = now,
        };
        db.UserNotifications.Add(notification);
        await db.SaveChangesAsync();

        // Agents finish often; this keeps the table from growing forever without a job of its own.
        var cutoff = now - KeepForwardedFor;
        await db.UserNotifications.Where(n => n.UserId == userId && forwarded.Contains(n.Kind) && n.CreatedAt < cutoff).ExecuteDeleteAsync();

        await delivery.DeliverAsync([notification]);
        return TypedResults.Created((string?)null, new NotificationEventDto(notification.Id));
    }

    private static async Task<string?> SessionKindAsync(HttpContext http, long userId, AccountSessions sessions) =>
        AccountSessions.SessionId(http.User) is { } sessionId ? (await sessions.FindLiveAsync(sessionId, userId))?.Kind : null;

    [GeneratedRegex(@"\A[A-Za-z0-9:_.-]{1,1024}\z", RegexOptions.CultureInvariant)]
    private static partial Regex PushToken();
}

internal static class NotificationsSetup
{
    /// <summary>Categories, delivery, and the push senders with their queue (E82).</summary>
    public static IServiceCollection AddWebsiteNotifications(this IServiceCollection services)
    {
        services.AddOptions<PushOptions>().BindConfiguration(PushOptions.Section);
        services.AddScoped<NotificationPreferenceStore>();
        services.AddScoped<NotificationDelivery>();
        services.AddSingleton<PushQueue>();
        services.AddHttpClient(FcmPushSender.HttpClientName, http => http.Timeout = TimeSpan.FromSeconds(20));
        services.AddHttpClient(ApnsPushSender.HttpClientName, http => http.Timeout = TimeSpan.FromSeconds(20));
        services.AddSingleton<IPushSender, FcmPushSender>();
        services.AddSingleton<IPushSender, ApnsPushSender>();
        services.AddHostedService<PushDispatcher>();
        return services;
    }
}
