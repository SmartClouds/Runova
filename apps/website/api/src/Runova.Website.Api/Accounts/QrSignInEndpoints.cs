using System.Buffers.Text;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Problems;
using Runova.Website.Data;
using Runova.Website.Data.Accounts;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Accounts;

public sealed record QrSignInDto(long Id, string QrText, DateTimeOffset ExpiresAt);

public sealed record QrSignInStatusDto(string Status, string? MatchCode, DateTimeOffset ExpiresAt);

public sealed record QrSignInDecisionRequest(bool? Approve);

public sealed record QrSignInClaimRequest(string? Code, string? CodeChallenge, string? CodeChallengeMethod, string? Platform, string? AppVersion, Guid? DeviceId);

public sealed record QrSignInClaimDto(string MatchCode, DateTimeOffset ExpiresAt);

public sealed record QrSignInPollRequest(string? Code, string? CodeVerifier);

public sealed record QrSignInPollDto(string Status, string? Code);

/// <summary>
/// Signing the Runova app in by QR code. A signed-in desktop app or browser asks for a code and
/// shows it; the app scans it and claims it with a PKCE challenge; the signed-in side sees the
/// claim and approves it. Then the app's poll hands over an ordinary one-time code for
/// <c>POST /device-tokens</c>, so the session, the activity entry and the new sign-in email are the
/// same as for a browser sign-in. A photo of the code is worth nothing without that approval, and
/// the code is one use, so a second scanner is refused.
/// </summary>
internal static class QrSignInEndpoints
{
    public const string QrPrefix = "rq1.";
    public static readonly TimeSpan CodeLifetime = TimeSpan.FromMinutes(2);

    public static RouteGroupBuilder MapQrSignIns(this RouteGroupBuilder api)
    {
        api.MapPost("/qr-sign-ins", CreateAsync).RequireAuthorization(Policies.Account);
        api.MapGet("/qr-sign-ins/{id:long}", ReadAsync).RequireAuthorization(Policies.Account);
        api.MapPost("/qr-sign-ins/{id:long}/decisions", DecideAsync).RequireAuthorization(Policies.Account);
        api.MapPost("/qr-sign-in-claims", ClaimAsync).AllowAnonymous().RequireRateLimiting(AuthRateLimits.Policy);
        api.MapPost("/qr-sign-in-polls", PollAsync).AllowAnonymous().RequireRateLimiting(AuthRateLimits.PollPolicy);
        return api;
    }

    private static async Task<Results<Created<QrSignInDto>, UnauthorizedHttpResult>> CreateAsync(
        HttpContext http, UserManager<AppUser> users, AppDbContext db, TimeProvider time)
    {
        if (await users.GetUserAsync(http.User) is not { } user)
        {
            return TypedResults.Unauthorized();
        }

        var now = time.GetUtcNow();
        var code = Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32));
        var row = new QrSignIn
        {
            UserId = user.Id,
            CodeHash = DeviceTokenEndpoints.Hash(code),
            CreatedAt = now,
            ExpiresAt = now + CodeLifetime,
        };

        // One live code per person: asking for a new one retires a code nobody has scanned.
        await db.QrSignIns.Where(q => q.ExpiresAt < now || (q.UserId == user.Id && q.ClaimedAt == null)).ExecuteDeleteAsync();
        db.QrSignIns.Add(row);
        await db.SaveChangesAsync();

        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Created((string?)null, QrSignInMapper.ToDto(row, QrPrefix + code));
    }

    private static async Task<Results<Ok<QrSignInStatusDto>, ProblemHttpResult, UnauthorizedHttpResult>> ReadAsync(
        long id, HttpContext http, UserManager<AppUser> users, AppDbContext db, TimeProvider time)
    {
        if (await users.GetUserAsync(http.User) is not { } user)
        {
            return TypedResults.Unauthorized();
        }

        var row = await db.QrSignIns.AsNoTracking().SingleOrDefaultAsync(q => q.Id == id && q.UserId == user.Id);
        if (row is null)
        {
            return Gone();
        }

        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(QrSignInMapper.ToStatusDto(row, StatusOf(row, time.GetUtcNow())));
    }

    private static string StatusOf(QrSignIn row, DateTimeOffset now)
    {
        var expired = row.ExpiresAt <= now;
        return row switch
        {
            { DeliveredAt: not null } => "approved",
            { ApprovedAt: not null } when !expired => "approved",
            { DeclinedAt: not null } => "declined",
            _ when expired => "expired",
            { ClaimedAt: not null } => "scanned",
            _ => "waiting",
        };
    }

    private static async Task<Results<NoContent, ValidationProblem, ProblemHttpResult, UnauthorizedHttpResult>> DecideAsync(
        long id, QrSignInDecisionRequest request, HttpContext http, UserManager<AppUser> users, AppDbContext db, TimeProvider time)
    {
        if (await users.GetUserAsync(http.User) is not { } user)
        {
            return TypedResults.Unauthorized();
        }

        if (request.Approve is not { } approve)
        {
            return ApiProblems.Invalid("approve", "Say whether to approve this sign-in.");
        }

        var now = time.GetUtcNow();
        if (!await db.QrSignIns.AnyAsync(q => q.Id == id && q.UserId == user.Id))
        {
            return Gone();
        }

        var undecided = db.QrSignIns.Where(q => q.Id == id && q.UserId == user.Id && q.ApprovedAt == null && q.DeclinedAt == null && q.ExpiresAt > now);

        // Closing the code before anyone scans it counts as declining it. Approving needs a scan.
        var changed = approve
            ? await undecided.Where(q => q.ClaimedAt != null).ExecuteUpdateAsync(q => q.SetProperty(x => x.ApprovedAt, now))
            : await undecided.ExecuteUpdateAsync(q => q.SetProperty(x => x.DeclinedAt, now));
        return changed == 1
            ? TypedResults.NoContent()
            : ApiProblems.Of(ProblemTypes.Conflict, "This code can no longer be answered. Show a new one.");
    }

    private static async Task<Results<Ok<QrSignInClaimDto>, ValidationProblem, ProblemHttpResult>> ClaimAsync(
        QrSignInClaimRequest request, HttpContext http, AppDbContext db, TimeProvider time)
    {
        http.Response.Headers.CacheControl = HttpCaching.Private;
        var errors = new Dictionary<string, string[]>();
        if (string.IsNullOrEmpty(request.Code))
        {
            errors["code"] = ["Send the code from the QR."];
        }

        if (request.CodeChallengeMethod != "S256" || request.CodeChallenge is null || !DeviceTokenEndpoints.Base64UrlToken().IsMatch(request.CodeChallenge))
        {
            errors["codeChallenge"] = ["Send a PKCE S256 challenge."];
        }

        if (request.Platform is null || !DeviceTokenEndpoints.PhonePlatforms.ContainsKey(request.Platform))
        {
            errors["platform"] = ["platform is android or ios."];
        }

        if (request.AppVersion is { Length: > 32 })
        {
            errors["appVersion"] = ["appVersion is up to 32 characters."];
        }

        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        var now = time.GetUtcNow();
        var hash = DeviceTokenEndpoints.Hash(request.Code!);
        var matchCode = RandomNumberGenerator.GetInt32(10_000).ToString("D4", CultureInfo.InvariantCulture);
        var expiresAt = now + CodeLifetime;
        var platform = DeviceTokenEndpoints.PhonePlatforms[request.Platform!];

        // One claim, even when two scanners race for it.
        var claimed = await db.QrSignIns
            .Where(q => q.CodeHash == hash && q.ClaimedAt == null && q.DeclinedAt == null && q.ExpiresAt > now)
            .ExecuteUpdateAsync(q => q
                .SetProperty(x => x.ClaimedAt, now)
                .SetProperty(x => x.CodeChallenge, request.CodeChallenge)
                .SetProperty(x => x.MatchCode, matchCode)
                .SetProperty(x => x.Platform, platform)
                .SetProperty(x => x.AppVersion, request.AppVersion)
                .SetProperty(x => x.DeviceId, request.DeviceId)
                .SetProperty(x => x.ExpiresAt, expiresAt));
        if (claimed != 1)
        {
            return Refused();
        }

        return TypedResults.Ok(new QrSignInClaimDto(matchCode, expiresAt));
    }

    private static async Task<Results<Ok<QrSignInPollDto>, ValidationProblem, ProblemHttpResult>> PollAsync(
        QrSignInPollRequest request, HttpContext http, AppDbContext db, TimeProvider time)
    {
        http.Response.Headers.CacheControl = HttpCaching.Private;
        if (string.IsNullOrEmpty(request.Code) || string.IsNullOrEmpty(request.CodeVerifier))
        {
            return ApiProblems.Invalid("code", "Send the code and the verifier.");
        }

        var now = time.GetUtcNow();
        var hash = DeviceTokenEndpoints.Hash(request.Code);
        var row = await db.QrSignIns.AsNoTracking().SingleOrDefaultAsync(q => q.CodeHash == hash);
        if (row?.CodeChallenge is null || row.ExpiresAt <= now
            || !CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(DeviceTokenEndpoints.Challenge(request.CodeVerifier)), Encoding.ASCII.GetBytes(row.CodeChallenge)))
        {
            return Refused();
        }

        if (row.DeclinedAt is not null)
        {
            return TypedResults.Ok(new QrSignInPollDto("declined", null));
        }

        if (row.ApprovedAt is null)
        {
            return TypedResults.Ok(new QrSignInPollDto("waiting", null));
        }

        // The sign-in code goes out once, even when two polls race for it.
        if (await db.QrSignIns.Where(q => q.Id == row.Id && q.DeliveredAt == null).ExecuteUpdateAsync(q => q.SetProperty(x => x.DeliveredAt, now)) != 1)
        {
            return Refused();
        }

        var code = Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32));
        db.DeviceAuthorizations.Add(new DeviceAuthorization
        {
            UserId = row.UserId,
            CodeHash = DeviceTokenEndpoints.Hash(code),
            CodeChallenge = row.CodeChallenge,
            RedirectUri = DeviceTokenEndpoints.PhoneRedirect,
            DeviceName = DeviceTokenEndpoints.PhoneDeviceName,
            Platform = row.Platform!,
            AppVersion = row.AppVersion,
            DeviceId = row.DeviceId,
            CreatedAt = now,
            ExpiresAt = now + DeviceTokenEndpoints.CodeLifetime,
        });
        await db.SaveChangesAsync();
        return TypedResults.Ok(new QrSignInPollDto("approved", code));
    }

    private static ProblemHttpResult Gone() =>
        ApiProblems.Of(ProblemTypes.NotFound, "This code is gone. Show a new one.");

    private static ProblemHttpResult Refused() =>
        ApiProblems.Of(ProblemTypes.Unauthorized, "This QR code is no longer valid. Show a new one and scan it again.");
}
