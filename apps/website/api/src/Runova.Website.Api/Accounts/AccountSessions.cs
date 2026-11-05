using System.Globalization;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using Runova.Website.Api.Email;
using Runova.Website.Api.Http;
using Runova.Website.Core.Accounts;
using Runova.Website.Core.Email;
using Runova.Website.Data;
using Runova.Website.Data.Accounts;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Accounts;

/// <summary>
/// The sessions of an account: one per browser and one per computer. A cookie or token names its
/// session in <see cref="SessionClaim"/>, and every request checks the session is still live (from a
/// cache for a few seconds), so ending a session works at once. Ending one here also drops it from
/// this instance's cache straight away.
/// </summary>
internal sealed class AccountSessions(
    AppDbContext db,
    TimeProvider time,
    IMemoryCache cache,
    IHttpContextAccessor accessor,
    IServiceScopeFactory scopes,
    IConfiguration configuration)
{
    public const string SessionClaim = "runova:sid";

    /// <summary>How long a live session is trusted from the cache before the database is asked again.</summary>
    public static readonly TimeSpan CacheFor = TimeSpan.FromSeconds(15);

    /// <summary>How stale a session's last-seen time may get before a request updates it.</summary>
    public static readonly TimeSpan TouchEvery = TimeSpan.FromMinutes(5);

    /// <summary>The newest session started in this request, for the activity entry that follows it.</summary>
    private const string StartedItem = "runova:started-session";

    public static long? SessionId(ClaimsPrincipal? user) =>
        long.TryParse(user?.FindFirstValue(SessionClaim), CultureInfo.InvariantCulture, out var id) ? id : null;

    /// <summary>The session of this request: the one its cookie or token names, or one it just started.</summary>
    public static long? CurrentId(HttpContext? http) =>
        http is null ? null : SessionId(http.User) ?? (http.Items[StartedItem] as long?);

    /// <summary>
    /// A new browser session, saved at once. The owner gets an email when this browser and address
    /// have not signed in to the account in the last 30 days, unless this is their first session.
    /// It is written through a context of its own: a sign-in on another computer at the same moment
    /// can leave this request's copy of the user stale, and nothing here should try to save that.
    /// </summary>
    public async Task<AccountSession> StartWebAsync(AppUser user)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var outbox = scope.ServiceProvider.GetRequiredService<EmailOutbox>();
        var http = accessor.HttpContext;
        var userAgent = Truncate(http?.Request.Headers.UserAgent.ToString(), 300);
        var ip = http?.Connection.RemoteIpAddress?.ToString();
        var (name, platform) = DeviceNames.FromUserAgent(userAgent);
        var now = time.GetUtcNow();

        var since = now.AddDays(-30);
        var anyBefore = await db.AccountSessions.AnyAsync(s => s.UserId == user.Id);
        var seenHere = await db.AccountSessions.AnyAsync(s =>
            s.UserId == user.Id && s.Kind == AccountSessionKinds.Web && s.UserAgent == userAgent && s.CreatedIp == ip && s.CreatedAt >= since);

        var session = new AccountSession
        {
            UserId = user.Id,
            Kind = AccountSessionKinds.Web,
            DeviceName = name,
            Platform = platform,
            UserAgent = userAgent,
            CreatedIp = ip,
            LastIp = ip,
            CreatedAt = now,
            LastSeenAt = now,
        };
        db.AccountSessions.Add(session);
        if (anyBefore && !seenHere && user.Email is { } email)
        {
            outbox.Add(email, EmailTemplates.NewSignIn(user.DisplayName, name, ip ?? "an unknown address", $"{SiteUrl.From(configuration)}/account/sessions"));
        }

        await db.SaveChangesAsync();
        outbox.SendSoon();
        if (http is not null)
        {
            http.Items[StartedItem] = session.Id;
        }

        return session;
    }

    /// <summary>
    /// The session when it is live and belongs to the user, else null. A session not seen for
    /// <see cref="TouchEvery"/> gets its last-seen time and address updated.
    /// </summary>
    public async Task<AccountSession?> FindLiveAsync(long sessionId, long userId)
    {
        var key = CacheKey(sessionId);
        if (!cache.TryGetValue(key, out AccountSession? session))
        {
            session = await db.AccountSessions.AsNoTracking()
                .SingleOrDefaultAsync(s => s.Id == sessionId && s.UserId == userId && s.RevokedAt == null);
            cache.Set(key, session, CacheFor);
        }

        if (session is null || session.UserId != userId)
        {
            return null;
        }

        var now = time.GetUtcNow();
        if (now - session.LastSeenAt >= TouchEvery)
        {
            var ip = accessor.HttpContext?.Connection.RemoteIpAddress?.ToString();
            await db.AccountSessions.Where(s => s.Id == sessionId).ExecuteUpdateAsync(s => s.SetProperty(x => x.LastSeenAt, now).SetProperty(x => x.LastIp, ip));
            session.LastSeenAt = now;
            session.LastIp = ip;
        }

        return session;
    }

    /// <summary>Ends one of the user's sessions; false when there is no such live session.</summary>
    public async Task<bool> RevokeAsync(long userId, long sessionId)
    {
        var now = time.GetUtcNow();
        var ended = await db.AccountSessions
            .Where(s => s.Id == sessionId && s.UserId == userId && s.RevokedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(x => x.RevokedAt, now));
        cache.Remove(CacheKey(sessionId));
        return ended == 1;
    }

    /// <summary>Ends every live session of the user but <paramref name="keep"/> (none when null).</summary>
    public async Task<int> RevokeAllAsync(long userId, long? keep)
    {
        var now = time.GetUtcNow();
        var ids = await db.AccountSessions
            .Where(s => s.UserId == userId && s.RevokedAt == null && s.Id != keep)
            .Select(s => s.Id)
            .ToListAsync();
        if (ids.Count == 0)
        {
            return 0;
        }

        await db.AccountSessions.Where(s => ids.Contains(s.Id)).ExecuteUpdateAsync(s => s.SetProperty(x => x.RevokedAt, now));
        foreach (var id in ids)
        {
            cache.Remove(CacheKey(id));
        }

        return ids.Count;
    }

    private static string CacheKey(long sessionId) => "account-session:" + sessionId.ToString(CultureInfo.InvariantCulture);

    internal static string? Truncate(string? text, int length) =>
        string.IsNullOrEmpty(text) ? null : text.Length <= length ? text : text[..length];

    /// <summary>
    /// The cookie check: the security stamp first, as Identity does, then the session. A cookie with
    /// no session, or with one that has ended, is signed out.
    /// </summary>
    public static async Task ValidatePrincipalAsync(CookieValidatePrincipalContext context)
    {
        await SecurityStampValidator.ValidatePrincipalAsync(context);
        if (context.Principal is null)
        {
            return;
        }

        var sessions = context.HttpContext.RequestServices.GetRequiredService<AccountSessions>();
        var userId = AuditLogUserId(context.Principal);
        if (SessionId(context.Principal) is not { } sessionId
            || userId is null
            || await sessions.FindLiveAsync(sessionId, userId.Value) is null)
        {
            context.RejectPrincipal();
            await context.HttpContext.SignOutAsync(IdentityConstants.ApplicationScheme);
        }
    }

    private static long? AuditLogUserId(ClaimsPrincipal principal) =>
        long.TryParse(principal.FindFirstValue(ClaimTypes.NameIdentifier), CultureInfo.InvariantCulture, out var id) ? id : null;
}

/// <summary>
/// Identity's sign-in manager, with sessions: every sign-in that does not carry a session already
/// starts one, and a refreshed cookie (a password change, two-factor turned on) keeps the session of
/// the cookie it replaces.
/// </summary>
internal sealed class AppSignInManager(
    UserManager<AppUser> userManager,
    IHttpContextAccessor contextAccessor,
    IUserClaimsPrincipalFactory<AppUser> claimsFactory,
    IOptions<IdentityOptions> optionsAccessor,
    ILogger<SignInManager<AppUser>> logger,
    IAuthenticationSchemeProvider schemes,
    IUserConfirmation<AppUser> confirmation)
    : SignInManager<AppUser>(userManager, contextAccessor, claimsFactory, optionsAccessor, logger, schemes, confirmation)
{
    public override async Task SignInWithClaimsAsync(AppUser user, AuthenticationProperties? authenticationProperties, IEnumerable<Claim> additionalClaims)
    {
        var claims = additionalClaims.Where(c => c.Type != AccountSessions.SessionClaim).ToList();
        var carried = Context.User.FindFirstValue(ClaimTypes.NameIdentifier) == user.Id.ToString(CultureInfo.InvariantCulture)
            ? AccountSessions.SessionId(Context.User)
            : null;
        var sessionId = additionalClaims.FirstOrDefault(c => c.Type == AccountSessions.SessionClaim)?.Value
            ?? carried?.ToString(CultureInfo.InvariantCulture)
            ?? (await Context.RequestServices.GetRequiredService<AccountSessions>().StartWebAsync(user)).Id.ToString(CultureInfo.InvariantCulture);
        claims.Add(new Claim(AccountSessions.SessionClaim, sessionId));
        await base.SignInWithClaimsAsync(user, authenticationProperties, claims);
    }

    public override async Task SignOutAsync()
    {
        if (AccountSessions.SessionId(Context.User) is { } sessionId
            && long.TryParse(Context.User.FindFirstValue(ClaimTypes.NameIdentifier), CultureInfo.InvariantCulture, out var userId))
        {
            await Context.RequestServices.GetRequiredService<AccountSessions>().RevokeAsync(userId, sessionId);
        }

        await base.SignOutAsync();
    }
}

/// <summary>Adds account activity to the request's <see cref="AppDbContext"/>, saved with the change it describes.</summary>
internal sealed class ActivityLog(AppDbContext db, TimeProvider time, IHttpContextAccessor accessor, IServiceScopeFactory scopes)
{
    private static readonly JsonSerializerOptions _json = new(JsonSerializerDefaults.Web);

    /// <summary><paramref name="details"/> must hold no secret.</summary>
    public void Add(long userId, string action, object? details = null, long? teamId = null) =>
        db.AccountActivities.Add(Entry(userId, action, details, teamId));

    /// <summary>
    /// Saves an entry at once, through a context of its own, for a sign-in: it belongs to no other
    /// change, and the request's own context may hold a copy of the user another sign-in made stale.
    /// </summary>
    public async Task SaveNowAsync(long userId, string action, object? details = null)
    {
        using var scope = scopes.CreateScope();
        var own = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        own.AccountActivities.Add(Entry(userId, action, details, null));
        await own.SaveChangesAsync();
    }

    /// <summary>The time a user last signed in, set straight in the database with no row version check.</summary>
    public async Task MarkSignedInAsync(long userId)
    {
        using var scope = scopes.CreateScope();
        var own = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var now = time.GetUtcNow();
        await own.Users.Where(u => u.Id == userId).ExecuteUpdateAsync(u => u.SetProperty(x => x.LastSignInAt, now));
    }

    private AccountActivity Entry(long userId, string action, object? details, long? teamId)
    {
        var http = accessor.HttpContext;
        return new AccountActivity
        {
            UserId = userId,
            TeamId = teamId,
            Action = action,
            SessionId = AccountSessions.CurrentId(http),
            Ip = http?.Connection.RemoteIpAddress?.ToString(),
            Device = AccountSessions.Truncate(DeviceOf(http), 100),
            At = time.GetUtcNow(),
            Details = details is null ? null : JsonSerializer.Serialize(details, _json),
        };
    }

    private static string? DeviceOf(HttpContext? http)
    {
        if (http?.Items[DeviceItem] is string device)
        {
            return device;
        }

        var userAgent = http?.Request.Headers.UserAgent.ToString();
        return string.IsNullOrEmpty(userAgent) ? null : DeviceNames.FromUserAgent(userAgent).Name;
    }

    /// <summary>Set by a desktop request, whose computer name reads better than its User-Agent.</summary>
    public const string DeviceItem = "runova:device-name";
}

/// <summary>
/// Proof for a sensitive change: the password when the account has one, else a two-factor code,
/// else (Google only, no two-factor) a sign-in in the last 10 minutes.
/// </summary>
internal static class StepUp
{
    public static readonly TimeSpan RecentSignIn = TimeSpan.FromMinutes(10);

    public static async Task<Dictionary<string, string[]>?> ProblemsAsync(
        UserManager<AppUser> users, AppUser user, StepUpRequest? request, AccountSessions sessions, HttpContext http, TimeProvider time)
    {
        if (await users.HasPasswordAsync(user))
        {
            return !string.IsNullOrEmpty(request?.Password) && await users.CheckPasswordAsync(user, request.Password)
                ? null
                : new() { ["password"] = ["Enter your password to confirm."] };
        }

        if (user.TwoFactorEnabled)
        {
            return !string.IsNullOrWhiteSpace(request?.Code)
                && await users.VerifyTwoFactorTokenAsync(user, users.Options.Tokens.AuthenticatorTokenProvider, request.Code)
                ? null
                : new() { ["code"] = ["Enter the current code from your authenticator app to confirm."] };
        }

        var session = AccountSessions.SessionId(http.User) is { } id ? await sessions.FindLiveAsync(id, user.Id) : null;
        return session is not null && time.GetUtcNow() - session.CreatedAt <= RecentSignIn
            ? null
            : new() { ["signIn"] = ["Sign in again to confirm, then try once more within 10 minutes."] };
    }
}
