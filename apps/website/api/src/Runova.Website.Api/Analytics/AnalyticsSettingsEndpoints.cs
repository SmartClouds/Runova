using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using Runova.Website.Api.Audit;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Audit;
using Runova.Website.Data;
using Runova.Website.Data.Analytics;
using JsonOptions = Microsoft.AspNetCore.Http.Json.JsonOptions;

namespace Runova.Website.Api.Analytics;

/// <summary>
/// The tracking tags and site verifications of the public site (E59), set by an Admin. The pages
/// are prerendered, so they read these from <c>/site-analytics</c> in the browser and load the
/// tags themselves; a change shows up without a rebuild.
/// </summary>
internal static partial class AnalyticsSettingsEndpoints
{
    /// <summary>How long the API keeps the public answer before reading the row again.</summary>
    public static readonly TimeSpan PublicCacheAge = TimeSpan.FromSeconds(30);

    private const string PublicCacheKey = "site-analytics";

    /// <summary>How each kind of ID is tidied and checked. Every one of them ends up in a script URL or a file.</summary>
    private sealed record Rule(string Name, Regex Pattern, Func<string, string> Tidy, string Message);

    private static readonly Rule _googleAnalytics = new(
        "googleAnalyticsIds", GoogleAnalyticsId(), Upper, "Give Google Analytics measurement IDs, such as G-ABC123XYZ9.");

    private static readonly Rule _googleAds = new(
        "googleAdsIds", GoogleAdsId(), Upper, "Give Google Ads tag IDs, such as AW-123456789.");

    private static readonly Rule _googleTagManager = new(
        "googleTagManagerId", GoogleTagManagerId(), Upper, "Give a Tag Manager container ID, such as GTM-ABC1234.");

    private static readonly Rule _clarity = new(
        "clarityProjectId", ClarityProjectId(), Lower, "Give the Clarity project ID from its setup page, such as abcd1234ef.");

    private static readonly Rule _bingUet = new(
        "bingUetTagId", BingUetTagId(), s => s, "Give the UET tag ID, digits only, such as 187654321.");

    private static readonly Rule _googleVerification = new(
        "googleSiteVerification", GoogleSiteVerification(), GoogleFileName,
        "Give the name of Search Console's HTML verification file, such as google1234567890abcdef.html.");

    private static readonly Rule _bingVerification = new(
        "bingSiteVerification", BingSiteVerification(), s => s, "Give the code from BingSiteAuth.xml, letters and digits only.");

    public static RouteGroupBuilder MapAnalyticsSettings(this RouteGroupBuilder api)
    {
        var settings = api.MapGroup("/analytics-settings").RequireAuthorization(Policies.Admin);
        settings.MapGet("", GetAsync);
        settings.MapPatch("", PatchAsync).Accepts<AnalyticsSettingsPatch>("application/merge-patch+json", "application/json");
        api.MapGet("/site-analytics", GetPublicAsync).AllowAnonymous();
        return api;
    }

    [GeneratedRegex("^G-[A-Z0-9]{4,20}$")]
    internal static partial Regex GoogleAnalyticsId();

    [GeneratedRegex("^AW-[0-9]{6,15}$")]
    internal static partial Regex GoogleAdsId();

    [GeneratedRegex("^GTM-[A-Z0-9]{4,12}$")]
    internal static partial Regex GoogleTagManagerId();

    [GeneratedRegex("^[a-z0-9]{6,20}$")]
    internal static partial Regex ClarityProjectId();

    [GeneratedRegex("^[0-9]{4,12}$")]
    internal static partial Regex BingUetTagId();

    [GeneratedRegex("^google[a-z0-9]{8,54}$")]
    internal static partial Regex GoogleSiteVerification();

    [GeneratedRegex("^[A-Za-z0-9]{16,64}$")]
    internal static partial Regex BingSiteVerification();

    private static string Upper(string value) => value.ToUpperInvariant();

    private static string Lower(string value) => value.ToLowerInvariant();

    /// <summary>The file name as Search Console shows it, with or without a leading slash or <c>.html</c>.</summary>
    private static string GoogleFileName(string value)
    {
        var name = value.TrimStart('/').ToLowerInvariant();
        return name.EndsWith(".html", StringComparison.Ordinal) ? name[..^5] : name;
    }

    private static async Task<Ok<AnalyticsSettingsDto>> GetAsync(HttpContext http, AppDbContext db)
    {
        var row = await db.AnalyticsSettings.AsNoTracking().SingleAsync();
        return Answer(http, row);
    }

    private static async Task<Ok<SiteAnalyticsDto>> GetPublicAsync(HttpContext http, AppDbContext db, IMemoryCache cache)
    {
        var answer = await cache.GetOrCreateAsync(PublicCacheKey, async entry =>
        {
            entry.AbsoluteExpirationRelativeToNow = PublicCacheAge;
            return AnalyticsMapper.ToSiteDto(await db.AnalyticsSettings.AsNoTracking().SingleAsync(http.RequestAborted));
        });
        http.Response.Headers.CacheControl = HttpCaching.PublicList;
        return TypedResults.Ok(answer!);
    }

    private static async Task<Results<Ok<AnalyticsSettingsDto>, ValidationProblem, ProblemHttpResult>> PatchAsync(
        HttpContext http,
        AppDbContext db,
        AuditLog audit,
        IMemoryCache cache,
        TimeProvider time,
        IOptions<JsonOptions> json)
    {
        var row = await db.AnalyticsSettings.SingleAsync();
        if (Versions.CheckIfMatch(http.Request, row.Version) is { } precondition)
        {
            return precondition;
        }

        var errors = new Dictionary<string, string[]>();
        if (await RequestBodies.ReadObjectAsync(http.Request, errors) is not { } body
            || RequestBodies.Deserialize<AnalyticsSettingsPatch>(body, json.Value.SerializerOptions, errors) is not { } patch)
        {
            return ApiProblems.Invalid(errors);
        }

        var before = AnalyticsMapper.ToValues(row);
        var after = new AnalyticsValues(
            Switch(body, "tagsEnabled", patch.TagsEnabled, before.TagsEnabled, errors),
            List(body, _googleAnalytics, patch.GoogleAnalyticsIds, before.GoogleAnalyticsIds, errors),
            List(body, _googleAds, patch.GoogleAdsIds, before.GoogleAdsIds, errors),
            Text(body, _googleTagManager, patch.GoogleTagManagerId, before.GoogleTagManagerId, errors),
            Text(body, _clarity, patch.ClarityProjectId, before.ClarityProjectId, errors),
            Text(body, _bingUet, patch.BingUetTagId, before.BingUetTagId, errors),
            Text(body, _googleVerification, patch.GoogleSiteVerification, before.GoogleSiteVerification, errors),
            Text(body, _bingVerification, patch.BingSiteVerification, before.BingSiteVerification, errors),
            Switch(body, "consentBannerEnabled", patch.ConsentBannerEnabled, before.ConsentBannerEnabled, errors));

        if (errors.Count == 0 && after.TagsEnabled && !after.HasTag)
        {
            errors["tagsEnabled"] = ["Add at least one tag ID before turning the tags on."];
        }

        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        var changed = after.ChangedFrom(before);
        if (changed.Count > 0)
        {
            AnalyticsMapper.ApplyTo(after, row);
            row.UpdatedAt = time.GetUtcNow();
            audit.Add(AuditActions.AnalyticsSettingsUpdate, AuditTargetTypes.AnalyticsSettings, row.Id, new { fields = changed });
            try
            {
                await db.SaveChangesAsync();
            }
            catch (DbUpdateConcurrencyException)
            {
                var current = await db.AnalyticsSettings.AsNoTracking().SingleAsync();
                return Versions.Stale(current.Version);
            }

            cache.Remove(PublicCacheKey);
        }

        return Answer(http, row);
    }

    private static Ok<AnalyticsSettingsDto> Answer(HttpContext http, AnalyticsSettings row)
    {
        Versions.SetETag(http.Response, row.Version);
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(AnalyticsMapper.ToDto(row));
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

    /// <summary>An ID the patch names, tidied, with empty and null both meaning none; or the current one.</summary>
    private static string? Text(JsonObject body, Rule rule, string? value, string? current, Dictionary<string, string[]> errors)
    {
        if (!body.ContainsKey(rule.Name))
        {
            return current;
        }

        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var tidy = rule.Tidy(value.Trim());
        if (!rule.Pattern.IsMatch(tidy))
        {
            errors[rule.Name] = [rule.Message];
            return current;
        }

        return tidy;
    }

    /// <summary>A list the patch names, each ID tidied, blanks and repeats dropped; or the current one.</summary>
    private static string[] List(JsonObject body, Rule rule, string[]? values, string[] current, Dictionary<string, string[]> errors)
    {
        if (!body.ContainsKey(rule.Name))
        {
            return current;
        }

        var ids = (values ?? [])
            .Where(v => !string.IsNullOrWhiteSpace(v))
            .Select(v => rule.Tidy(v.Trim()))
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        var wrong = ids.Where(id => !rule.Pattern.IsMatch(id)).ToList();
        if (wrong.Count > 0)
        {
            errors[rule.Name] = [$"{rule.Message} Not one: {string.Join(", ", wrong.Select(w => w.Length > 30 ? w[..30] + "..." : w))}."];
            return current;
        }

        if (ids.Length > AnalyticsSettings.MaxIds)
        {
            errors[rule.Name] = [$"Give at most {AnalyticsSettings.MaxIds}."];
            return current;
        }

        return ids;
    }
}
