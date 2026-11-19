using System.Buffers.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Runova.Website.Api.ApiClients;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Problems;
using Runova.Website.Api.Sessions;
using Runova.Website.Core.Accounts;
using Runova.Website.Core.Problems;
using Runova.Website.Data;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Accounts;

/// <summary>
/// Passkeys (E115): the challenge every ceremony starts with, signing in on the website, and the
/// account's own list. A passkey with user verification is enough on its own, so an account with
/// two-step sign-in is not asked for its code. The phone signs in through the <c>passkey</c> grant
/// of <c>/device-tokens</c>.
/// </summary>
internal static class PasskeyEndpoints
{
    public const int NameLength = 50;

    private const string NotAccepted = "That passkey was not accepted. Try again, or sign in another way.";

    public static RouteGroupBuilder MapPasskeys(this RouteGroupBuilder api)
    {
        // No antiforgery of its own: the phone asks with no cookie. A signed-in browser still sends
        // the token, as for every unsafe request with a session.
        api.MapPost("/passkey-challenges", ChallengeAsync).AllowAnonymous().RequireRateLimiting(AuthRateLimits.Policy);
        api.MapPost("/passkey-sign-ins", SignInAsync).AllowAnonymous().WithMetadata(RequiresAntiforgery.Instance).RequireRateLimiting(AuthRateLimits.Policy);

        var mine = api.MapGroup("/users/me/passkeys").RequireAuthorization(Policies.Account);
        mine.MapGet("", ListAsync);
        mine.MapPost("", AddAsync);
        mine.MapPatch("/{id}", RenameAsync).Accepts<RenamePasskeyRequest>("application/merge-patch+json");
        mine.MapDelete("/{id}", RemoveAsync);
        return api;
    }

    private static async Task<Results<Created<PasskeyChallengeDto>, ValidationProblem, UnauthorizedHttpResult>> ChallengeAsync(
        PasskeyChallengeRequest request, HttpContext http, UserManager<AppUser> users, PasskeyCeremonies ceremonies)
    {
        if (!PasskeyPurposes.IsKnown(request.Purpose))
        {
            return ApiProblems.Invalid("purpose", "purpose is sign-in, register or step-up.");
        }

        AppUser? user = null;
        if (request.Purpose != PasskeyPurposes.SignIn
            && (ApiClientPrincipal.IsApiClient(http.User) || DeviceTokenAuthenticationHandler.IsDevice(http.User) || (user = await users.GetUserAsync(http.User)) is null))
        {
            return TypedResults.Unauthorized();
        }

        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Created((string?)null, await ceremonies.StartAsync(request.Purpose!, user, http));
    }

    private static async Task<Results<NoContent, ValidationProblem, ProblemHttpResult>> SignInAsync(
        PasskeySignInRequest request,
        HttpContext http,
        UserManager<AppUser> users,
        SignInManager<AppUser> signIn,
        PasskeyCeremonies ceremonies,
        ActivityLog activity,
        TimeProvider time)
    {
        if (string.IsNullOrEmpty(request.ChallengeId) || request.Credential is not { ValueKind: JsonValueKind.Object })
        {
            return ApiProblems.Invalid("credential", "Send the challenge id and the passkey's answer.");
        }

        var result = await ceremonies.AssertAsync(request.ChallengeId, request.Credential, PasskeyPurposes.SignIn, null, http);
        if (result is not { Succeeded: true, User: { } user })
        {
            if (await ceremonies.OwnerAsync(request.Credential) is { } owner)
            {
                await activity.SaveNowAsync(owner.Id, ActivityActions.SignInFailed, new { reason = "passkey" });
            }

            return ApiProblems.Of(ProblemTypes.Unauthorized, NotAccepted);
        }

        if (user.DisabledAt is not null)
        {
            return ApiProblems.Of(ProblemTypes.Unauthorized, NotAccepted);
        }

        if (await users.IsLockedOutAsync(user))
        {
            return SessionEndpoints.Locked(user, time);
        }

        if (!user.EmailConfirmed)
        {
            return ApiProblems.Of(ProblemTypes.EmailUnverified, "Confirm your email first: open the link we sent you, or ask for a new one.");
        }

        await users.ResetAccessFailedCountAsync(user);
        await activity.MarkSignedInAsync(user.Id);
        await signIn.SignInAsync(user, isPersistent: true);
        await activity.SaveNowAsync(user.Id, ActivityActions.SignIn, new { method = "passkey" });

        // The antiforgery token belongs to a user, so the one from before sign-in is replaced.
        http.User = await signIn.CreateUserPrincipalAsync(user);
        AntiforgeryCheck.IssueToken(http);
        return TypedResults.NoContent();
    }

    private static async Task<Results<Ok<PasskeyListDto>, UnauthorizedHttpResult>> ListAsync(HttpContext http, UserManager<AppUser> users)
    {
        if (await users.GetUserAsync(http.User) is not { } user)
        {
            return TypedResults.Unauthorized();
        }

        var passkeys = await users.GetPasskeysAsync(user);
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(new PasskeyListDto([.. passkeys.OrderBy(p => p.CreatedAt).Select(PasskeyMapper.ToDto)]));
    }

    private static async Task<Results<Created<PasskeyDto>, ValidationProblem, UnauthorizedHttpResult>> AddAsync(
        AddPasskeyRequest request,
        HttpContext http,
        UserManager<AppUser> users,
        PasskeyCeremonies ceremonies,
        AccountSessions sessions,
        ActivityLog activity,
        AppDbContext db,
        TimeProvider time)
    {
        if (await users.GetUserAsync(http.User) is not { } user)
        {
            return TypedResults.Unauthorized();
        }

        var name = request.Name?.Trim() ?? "";
        if (name.Length > NameLength)
        {
            return ApiProblems.Invalid("name", $"Name the passkey in up to {NameLength} characters.");
        }

        var stepUp = new StepUpRequest(request.Password, request.Code, request.PasskeyChallengeId, request.PasskeyCredential);
        if (await StepUp.ProblemsAsync(users, user, stepUp, sessions, http, time) is { } problems)
        {
            return ApiProblems.Invalid(problems);
        }

        var result = await ceremonies.AttestAsync(request.ChallengeId, request.Credential, user, http);
        if (result is not { Succeeded: true, Passkey: { } passkey })
        {
            return ApiProblems.Invalid("credential", "The passkey was not added. Start again and use the passkey you just made.");
        }

        if (await users.FindByPasskeyIdAsync(passkey.CredentialId) is not null)
        {
            return ApiProblems.Invalid("credential", "That passkey is already on an account.");
        }

        passkey.Name = name.Length > 0 ? name : PasskeyMapper.DefaultName;
        if (!(await users.AddOrUpdatePasskeyAsync(user, passkey)).Succeeded)
        {
            return ApiProblems.Invalid("credential", "The passkey was not added. Try again.");
        }

        activity.Add(user.Id, ActivityActions.PasskeyAdded, new { name = passkey.Name });
        await db.SaveChangesAsync();
        var dto = PasskeyMapper.ToDto(passkey);
        return TypedResults.Created($"{ApiV1.Prefix}/users/me/passkeys/{dto.Id}", dto);
    }

    private static async Task<Results<Ok<PasskeyDto>, ValidationProblem, ProblemHttpResult, UnauthorizedHttpResult>> RenameAsync(
        string id, HttpContext http, UserManager<AppUser> users)
    {
        if (await users.GetUserAsync(http.User) is not { } user)
        {
            return TypedResults.Unauthorized();
        }

        if (await FindAsync(users, user, id) is not { } passkey)
        {
            return NotFound();
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

        var name = body?["name"] is JsonValue value && value.TryGetValue(out string? text) ? text.Trim() : null;
        if (name is null || name.Length is 0 or > NameLength)
        {
            return ApiProblems.Invalid("name", $"Name the passkey in 1 to {NameLength} characters.");
        }

        passkey.Name = name;
        if (!(await users.AddOrUpdatePasskeyAsync(user, passkey)).Succeeded)
        {
            return ApiProblems.Invalid("name", "The passkey was not renamed. Try again.");
        }

        return TypedResults.Ok(PasskeyMapper.ToDto(passkey));
    }

    private static async Task<Results<NoContent, ValidationProblem, ProblemHttpResult, UnauthorizedHttpResult>> RemoveAsync(
        string id,
        [FromBody] StepUpRequest request,
        HttpContext http,
        UserManager<AppUser> users,
        AccountSessions sessions,
        ActivityLog activity,
        AppDbContext db,
        TimeProvider time)
    {
        if (await users.GetUserAsync(http.User) is not { } user)
        {
            return TypedResults.Unauthorized();
        }

        if (await FindAsync(users, user, id) is not { } passkey)
        {
            return NotFound();
        }

        if (await StepUp.ProblemsAsync(users, user, request, sessions, http, time) is { } problems)
        {
            return ApiProblems.Invalid(problems);
        }

        if (!(await users.RemovePasskeyAsync(user, passkey.CredentialId)).Succeeded)
        {
            return NotFound();
        }

        activity.Add(user.Id, ActivityActions.PasskeyRemoved, new { name = PasskeyMapper.ToDto(passkey).Name });
        await db.SaveChangesAsync();
        return TypedResults.NoContent();
    }

    private static async Task<UserPasskeyInfo?> FindAsync(UserManager<AppUser> users, AppUser user, string id)
    {
        if (id.Length > 1400 || !Base64Url.IsValid(id))
        {
            return null;
        }

        return await users.GetPasskeyAsync(user, Base64Url.DecodeFromChars(id));
    }

    private static ProblemHttpResult NotFound() => ApiProblems.Of(ProblemTypes.NotFound, "There is no such passkey on your account.");
}
