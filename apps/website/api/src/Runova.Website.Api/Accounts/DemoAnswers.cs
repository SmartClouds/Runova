using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.HttpResults;
using Runova.Website.Api.CloudMonitoring;
using Runova.Website.Api.Http;
using Runova.Website.Api.Notifications;
using Runova.Website.Api.Paging;
using Runova.Website.Api.Problems;
using Runova.Website.Api.Remote;
using Runova.Website.Core.Accounts;
using Runova.Website.Core.Paging;
using Runova.Website.Core.Problems;
using Runova.Website.Data.Accounts;

namespace Runova.Website.Api.Accounts;

/// <summary>One request from the demo account, with the clock's now and its route values and body at hand.</summary>
internal sealed class DemoRequest(HttpContext http, DateTimeOffset now)
{
    public HttpContext Http => http;

    public DateTimeOffset Now => now;

    public long Id(string name) => long.Parse(Value(name), NumberStyles.Integer, CultureInfo.InvariantCulture);

    public string Value(string name) => Convert.ToString(http.Request.RouteValues[name], CultureInfo.InvariantCulture) ?? "";

    /// <summary>The JSON object the request sent, or null when it sent none or something else.</summary>
    public async Task<JsonObject?> BodyAsync()
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

    public static string? Text(JsonObject? body, string field) =>
        body?[field] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    public static bool? Flag(JsonObject? body, string field) =>
        body?[field] is JsonValue value && value.TryGetValue<bool>(out var flag) ? flag : null;
}

internal delegate Task<IResult> DemoAnswer(DemoRequest request);

/// <summary>
/// The demo account's side of the API. Runs after authorization, so a demo token reaches only
/// what the Account policy lets in, and answers every such request itself: the routes the phone
/// app calls get <see cref="DemoData"/> (reads) or the real route's success (writes, which are
/// dropped), and every other route a 403 <c>demo-read-only</c>. No endpoint runs, so nothing is
/// written: no session, activity, email, idempotency record or anything else.
/// </summary>
internal static class DemoAnswers
{
    private const string Api = ApiV1.Prefix;
    private const string Me = Api + "/accounts/me";
    private const string Teams = Api + "/teams";
    private const string RefusedDetail = "This is the demo account, so it can only look around. Sign in with your own Runova account to do this.";

    public static IApplicationBuilder UseDemoAccount(this IApplicationBuilder app) => app.Use(async (http, next) =>
    {
        if (!DemoAccount.IsDemo(http.User))
        {
            await next(http);
            return;
        }

        await AnswerAsync(http);
    });

    private static async Task AnswerAsync(HttpContext http)
    {
        if (http.GetEndpoint() is not RouteEndpoint { RoutePattern.RawText: { } route })
        {
            await ApiProblems.WriteAsync(http, ProblemTypes.NotFound, "There is nothing here.");
            return;
        }

        if (!Answered.TryGetValue((http.Request.Method, route), out var answer))
        {
            await ApiProblems.WriteAsync(http, ProblemTypes.DemoReadOnly, RefusedDetail);
            return;
        }

        http.Response.Headers.CacheControl = HttpCaching.Private;
        var now = http.RequestServices.GetRequiredService<TimeProvider>().GetUtcNow();
        var result = await answer(new DemoRequest(http, now));
        await result.ExecuteAsync(http);
    }

    /// <summary>The routes the phone app calls, by method and route pattern, and how the demo answers each.</summary>
    public static IReadOnlyDictionary<(string Method, string Route), DemoAnswer> Answered { get; } = new Dictionary<(string, string), DemoAnswer>
    {
        [("GET", Me + "/")] = r => Done(Account(r, DemoData.Account(r.Now))),
        [("PATCH", Me + "/")] = RenameAsync,
        [("GET", Api + "/sessions")] = r => Done(TypedResults.Ok(DemoData.Sessions(r.Now))),
        [("DELETE", Api + "/sessions")] = _ => Done(TypedResults.NoContent()),
        [("DELETE", Api + "/sessions/{id:long}")] = r => Done(DemoData.Sessions(r.Now).Items.Any(s => s.Id == r.Id("id"))
            ? TypedResults.NoContent()
            : ApiProblems.Of(ProblemTypes.NotFound, "There is no such session, or it has ended already.")),
        [("DELETE", Api + "/sessions/current")] = _ => Done(TypedResults.NoContent()),
        [("GET", Api + "/activities")] = ActivitiesAsync,

        [("GET", Teams + "/")] = r => Done(TypedResults.Ok(DemoData.Teams(r.Now))),
        [("GET", Teams + "/{id:long}")] = r => Done(DemoData.Team(r.Id("id"), r.Now) is { } team ? TypedResults.Ok(team) : NoTeam()),
        [("GET", Teams + "/{id:long}/members")] = r => Done(IsTeam(r) ? TypedResults.Ok(DemoData.Members(r.Now)) : NoTeam()),
        [("PATCH", Teams + "/{id:long}/members/{userId:long}")] = ChangeRoleAsync,
        [("DELETE", Teams + "/{id:long}/members/{userId:long}")] = r => Done(!IsTeam(r) ? NoTeam() : Member(r) is null ? NotInTeam() : TypedResults.NoContent()),
        [("GET", Teams + "/{id:long}/invitations")] = r => Done(IsTeam(r) ? TypedResults.Ok(DemoData.TeamInvitations(r.Now)) : NoTeam()),
        [("POST", Teams + "/{id:long}/invitations")] = InviteAsync,
        [("DELETE", Teams + "/{id:long}/invitations/{invitationId:long}")] = r => Done(IsTeam(r) ? TypedResults.NoContent() : NoTeam()),
        [("GET", Api + "/invitations/")] = r => Done(TypedResults.Ok(DemoData.MyInvitations(r.Now))),
        [("POST", Api + "/invitations/{id:long}/acceptances")] = r => Done(r.Id("id") == DemoData.ContosoInvitationId
            ? TypedResults.Created($"{Teams}/{DemoData.ContosoTeamId}", DemoData.Contoso(r.Now))
            : ApiProblems.Of(ProblemTypes.NotFound, "There is no such invitation for this account, or it expired.")),
        [("DELETE", Api + "/invitations/{id:long}")] = r => Done(r.Id("id") == DemoData.ContosoInvitationId
            ? TypedResults.NoContent()
            : ApiProblems.Of(ProblemTypes.NotFound, "There is no such invitation for this account.")),

        [("GET", Me + "/encryption-preferences/")] = _ => Done(TypedResults.Ok(DemoData.Encryption(DemoData.EncryptionOn))),
        [("PUT", Me + "/encryption-preferences/{item}")] = EncryptAsync,

        [("GET", Api + "/notifications/")] = NotificationsAsync,
        [("PATCH", Api + "/notifications/{id:long}")] = MarkReadAsync,
        [("POST", Api + "/notification-read-markers")] = MarkAllReadAsync,
        [("GET", Me + "/notification-preferences")] = _ => Done(TypedResults.Ok(DemoData.NotificationPreferences())),
        [("PUT", Me + "/notification-preferences/{category}")] = SetPreferenceAsync,
        [("PUT", Me + "/push-devices/current")] = PushDeviceAsync,
        [("DELETE", Me + "/push-devices/current")] = _ => Done(TypedResults.NoContent()),

        [("GET", Api + "/cloud-monitors/")] = r => Done(TypedResults.Ok(DemoData.CloudMonitors(r.Now))),
        [("PATCH", Api + "/cloud-monitors/{id:long}")] = PauseAsync,

        [("GET", Api + "/reachable-devices")] = r => Done(TypedResults.Ok(DemoData.ReachableDevices(r.Now))),
        [("POST", Api + "/remote-devices/")] = RegisterPhoneAsync,
    };

    /// <summary>
    /// Every other route an account may call, which the demo refuses with 403 <c>demo-read-only</c>.
    /// A test fails when an account route is in neither list, so each new one is decided here.
    /// </summary>
    public static IReadOnlySet<(string Method, string Route)> Refused { get; } = new HashSet<(string, string)>
    {
        ("DELETE", "/api/v1/accounts/me"),
        ("DELETE", "/api/v1/accounts/me/logins/{provider}"),
        ("DELETE", "/api/v1/accounts/me/muted-projects/{inventoryId:long}"),
        ("DELETE", "/api/v1/accounts/me/telegram-links/current"),
        ("DELETE", "/api/v1/cloud-monitors/{id:long}"),
        ("DELETE", "/api/v1/cloud-monitors/{id:long}/mutes/me"),
        ("DELETE", "/api/v1/remote-devices/{id:long}"),
        ("DELETE", "/api/v1/remote-devices/{id:long}/agents"),
        ("DELETE", "/api/v1/remote-sessions/{id:long}"),
        ("DELETE", "/api/v1/sync-scopes/{id:long}/keys/current"),
        ("DELETE", "/api/v1/sync-scopes/{id:long}/records"),
        ("DELETE", "/api/v1/sync-scopes/{scopeId:long}/package-inventories/{itemId}"),
        ("DELETE", "/api/v1/teams/{id:long}"),
        ("DELETE", "/api/v1/users/me/passkeys/{id}"),
        ("DELETE", "/api/v1/users/me/two-factor"),
        ("GET", "/api/v1/accounts/me/dependency-alert-settings"),
        ("GET", "/api/v1/accounts/me/notification-listeners"),
        ("GET", "/api/v1/accounts/me/payments"),
        ("GET", "/api/v1/accounts/me/subscriptions/current"),
        ("GET", "/api/v1/accounts/me/telegram-links/current"),
        ("GET", "/api/v1/cloud-monitors/usage"),
        ("GET", "/api/v1/cloud-monitors/{id:long}"),
        ("GET", "/api/v1/cloud-monitors/{id:long}/hours"),
        ("GET", "/api/v1/cloud-monitors/{id:long}/incidents"),
        ("GET", "/api/v1/cloud-monitors/{id:long}/samples"),
        ("GET", "/api/v1/dependency-findings"),
        ("GET", "/api/v1/qr-sign-ins/{id:long}"),
        ("GET", "/api/v1/remote-devices/"),
        ("GET", "/api/v1/remote-sessions"),
        ("GET", "/api/v1/sync-scopes/"),
        ("GET", "/api/v1/sync-scopes/{id:long}/changes"),
        ("GET", "/api/v1/sync-scopes/{id:long}/keys/current"),
        ("GET", "/api/v1/sync-scopes/{id:long}/usage"),
        ("GET", "/api/v1/teams/{id:long}/activities"),
        ("GET", "/api/v1/users/me/"),
        ("GET", "/api/v1/users/me/passkeys/"),
        ("GET", "/api/v1/users/me/two-factor"),
        ("PATCH", "/api/v1/accounts/me/dependency-alert-settings"),
        ("PATCH", "/api/v1/remote-devices/{id:long}"),
        ("PATCH", "/api/v1/sync-scopes/{id:long}"),
        ("PATCH", "/api/v1/teams/{id:long}"),
        ("PATCH", "/api/v1/users/me/passkeys/{id}"),
        ("POST", "/api/v1/accounts/me/billing-portal-sessions"),
        ("POST", "/api/v1/accounts/me/checkout-sessions"),
        ("POST", "/api/v1/accounts/me/crypto-invoices"),
        ("POST", "/api/v1/accounts/me/telegram-link-codes"),
        ("POST", "/api/v1/cloud-monitors/"),
        ("POST", "/api/v1/device-authorizations"),
        ("POST", "/api/v1/notification-events"),
        ("POST", "/api/v1/qr-sign-ins"),
        ("POST", "/api/v1/qr-sign-ins/{id:long}/decisions"),
        ("POST", "/api/v1/remote-devices/{id:long}/agents"),
        ("POST", "/api/v1/sync-scopes/{id:long}/records"),
        ("POST", "/api/v1/teams/"),
        ("POST", "/api/v1/users/me/passkeys/"),
        ("POST", "/api/v1/users/me/two-factor"),
        ("POST", "/api/v1/users/me/two-factor/recovery-codes"),
        ("PUT", "/api/v1/accounts/me/muted-projects/{inventoryId:long}"),
        ("PUT", "/api/v1/cloud-monitors/{id:long}/mutes/me"),
        ("PUT", "/api/v1/cloud-monitors/{id:long}/secrets/current"),
        ("PUT", "/api/v1/sync-scopes/{id:long}/keys/current"),
        ("PUT", "/api/v1/sync-scopes/{scopeId:long}/package-inventories/{itemId}"),
        ("PUT", "/api/v1/users/me/password"),
        ("PUT", "/api/v1/users/me/two-factor"),
    };

    private static Task<IResult> Done(IResult result) => Task.FromResult(result);

    private static Ok<AccountDto> Account(DemoRequest r, AccountDto account)
    {
        Versions.SetETag(r.Http.Response, 1);
        return TypedResults.Ok(account);
    }

    private static bool IsTeam(DemoRequest r) => r.Id("id") == DemoData.NorthwindTeamId;

    private static TeamMemberDto? Member(DemoRequest r) =>
        DemoData.Members(r.Now).Items.SingleOrDefault(m => m.UserId == r.Id("userId"));

    private static ProblemHttpResult NoTeam() => ApiProblems.Of(ProblemTypes.NotFound, "There is no such team for this account.");

    private static ProblemHttpResult NotInTeam() => ApiProblems.Of(ProblemTypes.NotFound, "That account is not in the team.");

    private static async Task<IResult> RenameAsync(DemoRequest r)
    {
        if (Versions.CheckIfMatch(r.Http.Request, 1) is { } precondition)
        {
            return precondition;
        }

        if (await r.BodyAsync() is not { } body)
        {
            return ApiProblems.Invalid("body", "Send a JSON merge patch object.");
        }

        var name = DemoAccount.DisplayName;
        foreach (var (field, _) in body)
        {
            if (field != "displayName")
            {
                return ApiProblems.Invalid(field, "Only displayName can be changed here.");
            }

            name = DemoRequest.Text(body, field)?.Trim() ?? "";
            if (name.Length is 0 or > AccountEndpoints.DisplayNameMax)
            {
                return ApiProblems.Invalid("displayName", $"Enter your name, up to {AccountEndpoints.DisplayNameMax} characters.");
            }
        }

        return Account(r, DemoData.Account(r.Now, name));
    }

    private static Task<IResult> ActivitiesAsync(DemoRequest r)
    {
        if (Paging(r) is not { } request)
        {
            return Done(PagingProblem(r));
        }

        var action = r.Http.Request.Query["action"].ToString();
        var all = DemoData.Activities(r.Now).Where(a => action.Length == 0 || a.Action == action).ToList();
        var result = Page.Of([.. all.Skip(request.Skip).Take(request.Size)], request, all.Count);
        PageLinks.Set(r.Http, result);
        return Done(TypedResults.Ok(result));
    }

    private static Task<IResult> NotificationsAsync(DemoRequest r)
    {
        if (Paging(r) is not { } request)
        {
            return Done(PagingProblem(r));
        }

        var mine = DemoData.Notifications(r.Now);
        var listed = r.Http.Request.Query["unread"].ToString() == "true" ? [.. mine.Where(n => n.ReadAt is null)] : mine;
        var result = Page.Of([.. listed.Skip(request.Skip).Take(request.Size)], request, listed.Count);
        PageLinks.Set(r.Http, result);
        return Done(TypedResults.Ok(new NotificationPageDto(result.Items, result.Number, result.PageSize, result.TotalItems, result.TotalPages, mine.Count(n => n.ReadAt is null))));
    }

    private static async Task<IResult> MarkReadAsync(DemoRequest r)
    {
        if (DemoData.Notifications(r.Now).SingleOrDefault(n => n.Id == r.Id("id")) is not { } notification)
        {
            return ApiProblems.Of(ProblemTypes.NotFound, "There is no such notification for this account.");
        }

        var body = await r.BodyAsync();
        if (body is not { Count: 1 } || DemoRequest.Flag(body, "read") is not { } read)
        {
            return ApiProblems.Invalid("read", "Send { \"read\": true } or { \"read\": false }.");
        }

        return TypedResults.Ok(notification with { ReadAt = read ? notification.ReadAt ?? r.Now : null });
    }

    private static async Task<IResult> MarkAllReadAsync(DemoRequest r)
    {
        var body = await r.BodyAsync();
        var before = DemoRequest.Text(body, "before") is { } text && DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, out var at) ? at : r.Now;
        var marked = DemoData.Notifications(r.Now).Count(n => n.ReadAt is null && n.CreatedAt <= before);
        return TypedResults.Created((string?)null, new NotificationReadMarkerDto(marked));
    }

    private static async Task<IResult> SetPreferenceAsync(DemoRequest r)
    {
        if (NotificationCategories.All.SingleOrDefault(c => c.Id == r.Value("category")) is not { } known)
        {
            return ApiProblems.Of(ProblemTypes.NotFound, "There is no such notification category.");
        }

        if (DemoRequest.Flag(await r.BodyAsync(), "enabled") is not { } enabled)
        {
            return ApiProblems.Invalid("enabled", "Send { \"enabled\": true } or { \"enabled\": false }.");
        }

        return TypedResults.Ok(NotificationMapper.ToDto(known, enabled));
    }

    private static async Task<IResult> PushDeviceAsync(DemoRequest r)
    {
        var platform = DemoRequest.Text(await r.BodyAsync(), "platform");
        if (!PushPlatforms.IsKnown(platform))
        {
            return ApiProblems.Invalid("platform", "platform is android or ios.");
        }

        return TypedResults.Ok(new PushDeviceDto(-1, platform!, r.Now));
    }

    private static async Task<IResult> EncryptAsync(DemoRequest r)
    {
        var item = r.Value("item");
        if (EncryptionItems.All.All(known => known.Id != item))
        {
            return ApiProblems.Of(ProblemTypes.NotFound, "There is no such item to encrypt.");
        }

        if (DemoRequest.Flag(await r.BodyAsync(), "enabled") is not { } enabled)
        {
            return ApiProblems.Invalid("enabled", "Send { \"enabled\": true } or { \"enabled\": false }.");
        }

        var on = new HashSet<string>(DemoData.EncryptionOn, StringComparer.Ordinal);
        if (enabled)
        {
            on.Add(item);
        }
        else
        {
            on.Remove(item);
        }

        return TypedResults.Ok(DemoData.Encryption(on));
    }

    private static async Task<IResult> ChangeRoleAsync(DemoRequest r)
    {
        if (!IsTeam(r))
        {
            return NoTeam();
        }

        var role = DemoRequest.Text(await r.BodyAsync(), "role");
        if (role is null || !TeamRoles.All.Contains(role))
        {
            return ApiProblems.Invalid("role", "role is owner, admin, member or viewer.");
        }

        // Step-up is taken as given: the demo has no password to check it against.
        return Member(r) is { } member ? TypedResults.Ok(member with { Role = role }) : NotInTeam();
    }

    private static async Task<IResult> InviteAsync(DemoRequest r)
    {
        if (!IsTeam(r))
        {
            return NoTeam();
        }

        var body = await r.BodyAsync();
        var email = DemoRequest.Text(body, "email")?.Trim() ?? "";
        var role = DemoRequest.Text(body, "role");
        var errors = new Dictionary<string, string[]>();
        if (!AccountEndpoints.IsEmail(email))
        {
            errors["email"] = ["Enter an email address, like kim@example.com."];
        }

        if (role is null || !TeamRoles.All.Contains(role))
        {
            errors["role"] = ["role is owner, admin, member or viewer."];
        }

        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        return TypedResults.Created((string?)null, new TeamInvitationDto(-43, email, role!, r.Now, r.Now + TeamEndpoints.InvitationLifetime));
    }

    private static async Task<IResult> PauseAsync(DemoRequest r)
    {
        if (DemoData.CloudMonitors(r.Now).Items.SingleOrDefault(m => m.Id == r.Id("id")) is not { } monitor)
        {
            return ApiProblems.Of(ProblemTypes.NotFound, "There is no such online monitor for this account.");
        }

        if (Versions.CheckIfMatch(r.Http.Request, 1) is { } precondition)
        {
            return precondition;
        }

        if (await r.BodyAsync() is not { } body)
        {
            return ApiProblems.Invalid("body", "Send a JSON object.");
        }

        if (DemoRequest.Flag(body, "paused") is { } paused && paused != monitor.Paused)
        {
            // Resumed, it has no check yet; paused, it keeps its last one.
            monitor = monitor with
            {
                Paused = paused,
                Status = paused
                    ? monitor.Status with { Verdict = "paused", Confirming = false, OpenIncident = null }
                    : new CloudMonitorStatusDto("unknown", null, null, null, null, null, null, false, null, null),
            };
        }

        Versions.SetETag(r.Http.Response, 1);
        return TypedResults.Ok(monitor);
    }

    private static async Task<IResult> RegisterPhoneAsync(DemoRequest r)
    {
        var body = await r.BodyAsync();
        var name = DemoRequest.Text(body, "name")?.Trim() ?? "";
        var platform = DemoRequest.Text(body, "platform");
        var errors = new Dictionary<string, string[]>();
        if (name.Length is 0 or > RemoteEndpoints.NameMax)
        {
            errors["name"] = [$"Name the computer, up to {RemoteEndpoints.NameMax} characters."];
        }

        if (platform is null || !(RemoteEndpoints.Platforms.Contains(platform) || RemoteEndpoints.PhonePlatforms.Contains(platform)))
        {
            errors["platform"] = ["platform is windows, macos, linux, android or ios."];
        }

        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        var phone = DemoData.Phone(r.Now, name, platform!, DemoRequest.Text(body, "identityKey") ?? "");
        return TypedResults.Created($"{Api}/remote-devices/{phone.Id}", phone);
    }

    private static PageRequest? Paging(DemoRequest r) =>
        TryQuery(r, "page", out var page) && TryQuery(r, "pageSize", out var size)
        && PageRequest.Parse(page, size, out var errors) is var request && errors.Count == 0
            ? request
            : null;

    private static ValidationProblem PagingProblem(DemoRequest r)
    {
        var errors = new Dictionary<string, string[]>();
        if (!TryQuery(r, "page", out var page) || page < 1)
        {
            errors["page"] = ["page starts at 1."];
        }

        if (!TryQuery(r, "pageSize", out var size) || size is < 1 or > PageRequest.MaxSize)
        {
            errors["pageSize"] = [$"pageSize is from 1 to {PageRequest.MaxSize}."];
        }

        return ApiProblems.Invalid(errors);
    }

    private static bool TryQuery(DemoRequest r, string name, out int? value)
    {
        var text = r.Http.Request.Query[name].ToString();
        value = null;
        if (text.Length == 0)
        {
            return true;
        }

        if (int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed))
        {
            value = parsed;
            return true;
        }

        return false;
    }
}
