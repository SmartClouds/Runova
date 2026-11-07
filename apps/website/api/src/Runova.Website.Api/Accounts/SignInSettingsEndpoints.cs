using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Runova.Website.Api.Audit;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Audit;
using Runova.Website.Data;
using Runova.Website.Data.Accounts;
using JsonOptions = Microsoft.AspNetCore.Http.Json.JsonOptions;

namespace Runova.Website.Api.Accounts;

/// <summary>
/// The sign-in settings as an Admin sees them. Secrets are never shown, only whether one is saved.
/// <c>googleActive</c> says whether "Continue with Google" shows, with keys from here or from the
/// environment; <c>googleOnlyAccounts</c> is how many people could only sign in with Google.
/// </summary>
public sealed record SignInSettingsDto(
    bool CaptchaEnabled,
    string? TurnstileSiteKey,
    bool HasTurnstileSecret,
    bool GoogleEnabled,
    bool GoogleActive,
    string? GoogleClientId,
    bool HasGoogleClientSecret,
    bool GoogleFromEnvironment,
    string GoogleCallbackUrl,
    int GoogleOnlyAccounts,
    DateTimeOffset? UpdatedAt,
    string Version);

/// <summary>
/// A merge patch of the settings. A secret given replaces the saved one and null removes it.
/// <c>captchaToken</c> is the settings page's own check, needed to turn the captcha on or give it new keys.
/// </summary>
public sealed record SignInSettingsPatch(
    bool? CaptchaEnabled,
    string? TurnstileSiteKey,
    string? TurnstileSecret,
    bool? GoogleEnabled,
    string? GoogleClientId,
    string? GoogleClientSecret,
    string? CaptchaToken);

/// <summary>
/// The Admin's switches and keys for the captcha and Google (E52). Turning the captcha on, or
/// giving it new keys, needs a token the settings page got with those keys and that Cloudflare
/// accepts with the new secret, so a wrong key can never lock everyone out, Admins included.
/// </summary>
internal static class SignInSettingsEndpoints
{
    public const int MaxSiteKey = 100;
    public const int MaxClientId = 300;
    public const int MaxSecret = 200;

    public static RouteGroupBuilder MapSignInSettings(this RouteGroupBuilder api)
    {
        var settings = api.MapGroup("/sign-in-settings").RequireAuthorization(Policies.Admin);
        settings.MapGet("", GetAsync);
        settings.MapPatch("", PatchAsync).Accepts<SignInSettingsPatch>("application/merge-patch+json", "application/json");
        return api;
    }

    private static async Task<Ok<SignInSettingsDto>> GetAsync(HttpContext http, AppDbContext db, SignInSettingsStore store, IConfiguration configuration)
    {
        var row = await db.SignInSettings.AsNoTracking().SingleAsync();
        return await AnswerAsync(http, db, store, configuration, row);
    }

    private static async Task<Results<Ok<SignInSettingsDto>, ValidationProblem, ProblemHttpResult>> PatchAsync(
        HttpContext http,
        AppDbContext db,
        SignInSettingsStore store,
        SignInSecrets secrets,
        TurnstileVerifier turnstile,
        AuditLog audit,
        TimeProvider time,
        IConfiguration configuration,
        IOptions<JsonOptions> json)
    {
        var row = await db.SignInSettings.SingleAsync();
        if (Versions.CheckIfMatch(http.Request, row.Version) is { } precondition)
        {
            return precondition;
        }

        var errors = new Dictionary<string, string[]>();
        if (await RequestBodies.ReadObjectAsync(http.Request, errors) is not { } body
            || RequestBodies.Deserialize<SignInSettingsPatch>(body, json.Value.SerializerOptions, errors) is not { } patch)
        {
            return ApiProblems.Invalid(errors);
        }

        var before = new Values(
            row.CaptchaEnabled, row.TurnstileSiteKey, secrets.Unseal(row.TurnstileSecretSealed),
            row.GoogleEnabled, row.GoogleClientId, secrets.Unseal(row.GoogleClientSecretSealed));
        var after = before with
        {
            CaptchaEnabled = Switch(body, "captchaEnabled", patch.CaptchaEnabled, before.CaptchaEnabled, errors),
            TurnstileSiteKey = Text(body, "turnstileSiteKey", patch.TurnstileSiteKey, before.TurnstileSiteKey, MaxSiteKey, errors),
            TurnstileSecret = Text(body, "turnstileSecret", patch.TurnstileSecret, before.TurnstileSecret, MaxSecret, errors),
            GoogleEnabled = Switch(body, "googleEnabled", patch.GoogleEnabled, before.GoogleEnabled, errors),
            GoogleClientId = Text(body, "googleClientId", patch.GoogleClientId, before.GoogleClientId, MaxClientId, errors),
            GoogleClientSecret = Text(body, "googleClientSecret", patch.GoogleClientSecret, before.GoogleClientSecret, MaxSecret, errors),
        };

        if (errors.Count == 0 && after.CaptchaEnabled && (after.TurnstileSiteKey is null || after.TurnstileSecret is null))
        {
            errors["captchaEnabled"] = ["Add the site key and the secret before turning the captcha on."];
        }

        var newKeys = after.TurnstileSiteKey != before.TurnstileSiteKey || after.TurnstileSecret != before.TurnstileSecret;
        if (errors.Count == 0 && after.CaptchaEnabled && (!before.CaptchaEnabled || newKeys)
            && !await turnstile.VerifyAsync(after.TurnstileSecret!, patch.CaptchaToken, CaptchaActions.SettingsCheck, http.Connection.RemoteIpAddress, http.RequestAborted))
        {
            errors["captchaToken"] = ["Pass the check with these keys first, so a wrong key can not lock everyone out."];
        }

        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        var changed = after.ChangedFrom(before);
        if (changed.Count > 0)
        {
            row.CaptchaEnabled = after.CaptchaEnabled;
            row.TurnstileSiteKey = after.TurnstileSiteKey;
            row.TurnstileSecretSealed = after.TurnstileSecret is null ? null : secrets.Seal(after.TurnstileSecret);
            row.GoogleEnabled = after.GoogleEnabled;
            row.GoogleClientId = after.GoogleClientId;
            row.GoogleClientSecretSealed = after.GoogleClientSecret is null ? null : secrets.Seal(after.GoogleClientSecret);
            row.UpdatedAt = time.GetUtcNow();
            audit.Add(AuditActions.SignInSettingsUpdate, AuditTargetTypes.SignInSettings, row.Id, new { fields = changed });
            try
            {
                await db.SaveChangesAsync();
            }
            catch (DbUpdateConcurrencyException)
            {
                var current = await db.SignInSettings.AsNoTracking().SingleAsync();
                return Versions.Stale(current.Version);
            }

            await store.ReloadAsync(http.RequestAborted);
        }

        return await AnswerAsync(http, db, store, configuration, row);
    }

    private static async Task<Ok<SignInSettingsDto>> AnswerAsync(
        HttpContext http, AppDbContext db, SignInSettingsStore store, IConfiguration configuration, SignInSettings row)
    {
        var effective = await store.GetAsync(http.RequestAborted);
        var googleOnly = await db.Users.CountAsync(u => u.PasswordHash == null && db.UserLogins.Any(l => l.UserId == u.Id));
        Versions.SetETag(http.Response, row.Version);
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(SignInSettingsMapper.ToDto(
            row, effective.GoogleActive, effective.GoogleFromEnvironment, SiteUrl.From(configuration) + GoogleSignIn.CallbackPath, googleOnly));
    }

    /// <summary>A switch the patch names, or the current value. null is not a switch.</summary>
    private static bool Switch(JsonObject body, string name, bool? value, bool current, Dictionary<string, string[]> errors)
    {
        if (!body.ContainsKey(name))
        {
            return current;
        }

        if (value is null)
        {
            errors[name] = ["Give true or false."];
            return current;
        }

        return value.Value;
    }

    /// <summary>A key the patch names, trimmed, with empty and null both meaning none; or the current value.</summary>
    private static string? Text(JsonObject body, string name, string? value, string? current, int max, Dictionary<string, string[]> errors)
    {
        if (!body.ContainsKey(name))
        {
            return current;
        }

        var trimmed = string.IsNullOrWhiteSpace(value) ? null : value.Trim();
        if (trimmed?.Length > max)
        {
            errors[name] = [$"Give at most {max} characters."];
            return current;
        }

        return trimmed;
    }

    private sealed record Values(
        bool CaptchaEnabled, string? TurnstileSiteKey, string? TurnstileSecret, bool GoogleEnabled, string? GoogleClientId, string? GoogleClientSecret)
    {
        /// <summary>The names of the fields that differ, for the audit entry. Never their values.</summary>
        public List<string> ChangedFrom(Values before)
        {
            var changed = new List<string>();
            if (CaptchaEnabled != before.CaptchaEnabled) changed.Add("captchaEnabled");
            if (TurnstileSiteKey != before.TurnstileSiteKey) changed.Add("turnstileSiteKey");
            if (TurnstileSecret != before.TurnstileSecret) changed.Add("turnstileSecret");
            if (GoogleEnabled != before.GoogleEnabled) changed.Add("googleEnabled");
            if (GoogleClientId != before.GoogleClientId) changed.Add("googleClientId");
            if (GoogleClientSecret != before.GoogleClientSecret) changed.Add("googleClientSecret");
            return changed;
        }
    }
}
