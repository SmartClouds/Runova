using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Runova.Website.Api.Audit;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Audit;
using Runova.Website.Core.Identity;
using Runova.Website.Core.Problems;
using Runova.Website.Data;
using Runova.Website.Data.Billing;
using JsonOptions = Microsoft.AspNetCore.Http.Json.JsonOptions;

namespace Runova.Website.Api.Billing;

/// <summary>The fields an account type is written with. On a patch, a field left out keeps its value.</summary>
public sealed record AccountTypeWriteRequest(
    string? Key,
    string? Name,
    string? Description,
    IReadOnlyList<string>? Features,
    int? SortOrder,
    bool? IsActive,
    bool? Highlight,
    int? MaxCloudMonitors,
    int? MinIntervalSec,
    int? HistoryDays,
    int? MonthlyPriceCents,
    int? YearlyPriceCents,
    string? Currency);

/// <summary>
/// Account types (E53): anyone may read the ones on offer, for the pricing page; Admins see the
/// archived ones too and make, change and remove them. The Free type is always there and free.
/// </summary>
internal static partial class AccountTypeEndpoints
{
    public const int MaxFeatures = 12;
    public const int MaxFeature = 100;
    public const int MaxIntervalSec = 86_400;
    public const int MaxHistoryDays = 3650;
    public const int MaxPriceCents = 10_000_000;
    public const int MaxMonitors = 100_000;

    public static RouteGroupBuilder MapAccountTypes(this RouteGroupBuilder api)
    {
        var types = api.MapGroup("/account-types");
        types.MapGet("", ListAsync).AllowAnonymous();
        types.MapPost("", CreateAsync).RequireAuthorization(Policies.Admin);
        types.MapGet("/{id:long}", GetAsync).RequireAuthorization(Policies.Admin);
        types.MapPatch("/{id:long}", PatchAsync).RequireAuthorization(Policies.Admin)
            .Accepts<AccountTypeWriteRequest>("application/merge-patch+json", "application/json");
        types.MapDelete("/{id:long}", DeleteAsync).RequireAuthorization(Policies.Admin);
        return api;
    }

    /// <summary>The types on offer, cheapest first; with <c>includeInactive</c>, for Admins, the archived ones too.</summary>
    private static async Task<Results<Ok<List<AccountTypeDto>>, ProblemHttpResult>> ListAsync(bool? includeInactive, HttpContext http, AppDbContext db)
    {
        var all = includeInactive == true;
        if (all && !http.User.IsInRole(Roles.Admin))
        {
            return ApiProblems.Of(ProblemTypes.Forbidden, "Only an Admin can see archived account types.");
        }

        var rows = await db.AccountTypes.AsNoTracking().Where(t => all || t.IsActive).OrderBy(t => t.SortOrder).ThenBy(t => t.Id).ToListAsync();
        http.Response.Headers.CacheControl = all ? HttpCaching.Private : HttpCaching.PublicList;
        return TypedResults.Ok(rows.Select(BillingMapper.ToDto).ToList());
    }

    private static async Task<Results<Ok<AccountTypeDto>, ProblemHttpResult>> GetAsync(long id, HttpContext http, AppDbContext db)
    {
        if (await db.AccountTypes.AsNoTracking().SingleOrDefaultAsync(t => t.Id == id) is not { } type)
        {
            return NotFound();
        }

        Versions.SetETag(http.Response, type.Version);
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(BillingMapper.ToDto(type));
    }

    private static async Task<Results<Created<AccountTypeDto>, ValidationProblem, ProblemHttpResult>> CreateAsync(
        HttpContext http, AppDbContext db, AuditLog audit, TimeProvider time, IConfiguration configuration, IOptions<JsonOptions> json)
    {
        var errors = new Dictionary<string, string[]>();
        if (await RequestBodies.ReadObjectAsync(http.Request, errors) is not { } body
            || RequestBodies.Deserialize<AccountTypeWriteRequest>(body, json.Value.SerializerOptions, errors) is not { } request)
        {
            return ApiProblems.Invalid(errors);
        }

        var key = request.Key?.Trim() ?? "";
        if (!KeyPattern().IsMatch(key))
        {
            errors["key"] = ["Give 2 to 32 lower-case letters, digits and dashes, starting with a letter."];
        }
        else if (await db.AccountTypes.AnyAsync(t => t.Key == key))
        {
            return ApiProblems.Of(ProblemTypes.Conflict, $"There is already an account type with the key '{key}'.");
        }

        var type = new AccountType { Key = key, CreatedAt = time.GetUtcNow(), MinIntervalSec = 300, HistoryDays = 30, MaxCloudMonitors = 1 };
        Apply(body, request, type, errors, MinIntervalFloor(configuration), creating: true);
        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        db.AccountTypes.Add(type);
        await db.SaveChangesAsync();
        audit.Add(AuditActions.AccountTypeCreate, AuditTargetTypes.AccountType, type.Id, new { type.Key, type.Name });
        await db.SaveChangesAsync();
        Versions.SetETag(http.Response, type.Version);
        return TypedResults.Created($"{ApiV1.Prefix}/account-types/{type.Id}", BillingMapper.ToDto(type));
    }

    private static async Task<Results<Ok<AccountTypeDto>, ValidationProblem, ProblemHttpResult>> PatchAsync(
        long id, HttpContext http, AppDbContext db, AuditLog audit, TimeProvider time, IConfiguration configuration, IOptions<JsonOptions> json)
    {
        if (await db.AccountTypes.SingleOrDefaultAsync(t => t.Id == id) is not { } type)
        {
            return NotFound();
        }

        if (Versions.CheckIfMatch(http.Request, type.Version) is { } precondition)
        {
            return precondition;
        }

        var errors = new Dictionary<string, string[]>();
        if (await RequestBodies.ReadObjectAsync(http.Request, errors) is not { } body
            || RequestBodies.Deserialize<AccountTypeWriteRequest>(body, json.Value.SerializerOptions, errors) is not { } request)
        {
            return ApiProblems.Invalid(errors);
        }

        if (body.ContainsKey("key") && request.Key != type.Key)
        {
            errors["key"] = ["The key of an account type never changes."];
        }

        var changed = Apply(body, request, type, errors, MinIntervalFloor(configuration), creating: false);
        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        if (changed.Count > 0)
        {
            type.UpdatedAt = time.GetUtcNow();
            audit.Add(AuditActions.AccountTypeUpdate, AuditTargetTypes.AccountType, type.Id, new { fields = changed });
            try
            {
                await db.SaveChangesAsync();
            }
            catch (DbUpdateConcurrencyException)
            {
                return Versions.Stale((await db.AccountTypes.AsNoTracking().SingleAsync(t => t.Id == id)).Version);
            }
        }

        Versions.SetETag(http.Response, type.Version);
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(BillingMapper.ToDto(type));
    }

    /// <summary>Removes a type nobody ever had. One that was used is archived instead (a patch of <c>isActive</c>).</summary>
    private static async Task<Results<NoContent, ProblemHttpResult>> DeleteAsync(long id, HttpContext http, AppDbContext db, AuditLog audit)
    {
        if (await db.AccountTypes.SingleOrDefaultAsync(t => t.Id == id) is not { } type)
        {
            return NotFound();
        }

        if (Versions.CheckIfMatch(http.Request, type.Version) is { } precondition)
        {
            return precondition;
        }

        if (type.IsFree)
        {
            return ApiProblems.Of(ProblemTypes.Conflict, "The Free account type is what every account falls back to, so it can not be removed.");
        }

        if (await db.Subscriptions.AnyAsync(s => s.AccountTypeId == id) || await db.Payments.AnyAsync(p => p.AccountTypeId == id))
        {
            return ApiProblems.Of(ProblemTypes.Conflict, "Accounts have had this type, so archive it instead of removing it.");
        }

        db.AccountTypes.Remove(type);
        audit.Add(AuditActions.AccountTypeDelete, AuditTargetTypes.AccountType, type.Id, new { type.Key });
        await db.SaveChangesAsync();
        return TypedResults.NoContent();
    }

    /// <summary>The shortest interval any type may allow: <c>Monitoring:MinIntervalSec</c>, 30 seconds unless set.</summary>
    public static int MinIntervalFloor(IConfiguration configuration) => configuration.GetValue("Monitoring:MinIntervalSec", 30);

    /// <summary>Writes the fields the body names onto the type, checking each, and returns the names of those that changed.</summary>
    private static List<string> Apply(JsonObject body, AccountTypeWriteRequest request, AccountType type, Dictionary<string, string[]> errors, int intervalFloor, bool creating)
    {
        var changed = new List<string>();

        void Set<T>(string field, T value, T current, Action<T> write)
        {
            if (!EqualityComparer<T>.Default.Equals(value, current))
            {
                write(value);
                changed.Add(field);
            }
        }

        if (creating || body.ContainsKey("name"))
        {
            var name = request.Name?.Trim() ?? "";
            if (name.Length is < 1 or > 60)
            {
                errors["name"] = ["Give a name of 1 to 60 characters."];
            }
            else
            {
                Set("name", name, type.Name, v => type.Name = v);
            }
        }

        if (body.ContainsKey("description"))
        {
            var description = request.Description?.Trim() ?? "";
            if (description.Length > 500)
            {
                errors["description"] = ["Give at most 500 characters."];
            }
            else
            {
                Set("description", description, type.Description, v => type.Description = v);
            }
        }

        if (body.ContainsKey("features"))
        {
            var features = (request.Features ?? []).Select(f => f?.Trim() ?? "").ToList();
            if (features.Count > MaxFeatures || features.Any(f => f.Length is < 1 or > MaxFeature))
            {
                errors["features"] = [$"Give up to {MaxFeatures} lines of 1 to {MaxFeature} characters."];
            }
            else if (!features.SequenceEqual(type.Features))
            {
                type.Features = [.. features];
                changed.Add("features");
            }
        }

        if (body.ContainsKey("sortOrder"))
        {
            if (request.SortOrder is not { } sortOrder || sortOrder is < 0 or > 1000)
            {
                errors["sortOrder"] = ["Give a number from 0 to 1000."];
            }
            else
            {
                Set("sortOrder", sortOrder, type.SortOrder, v => type.SortOrder = v);
            }
        }

        if (body.ContainsKey("isActive"))
        {
            if (request.IsActive is not { } active)
            {
                errors["isActive"] = ["Give true or false."];
            }
            else if (!active && type.IsFree)
            {
                errors["isActive"] = ["The Free account type can not be archived."];
            }
            else
            {
                Set("isActive", active, type.IsActive, v => type.IsActive = v);
            }
        }

        if (body.ContainsKey("highlight"))
        {
            if (request.Highlight is not { } highlight)
            {
                errors["highlight"] = ["Give true or false."];
            }
            else
            {
                Set("highlight", highlight, type.Highlight, v => type.Highlight = v);
            }
        }

        // null is unlimited here, so only a number out of range is wrong.
        if (body.ContainsKey("maxCloudMonitors"))
        {
            if (request.MaxCloudMonitors is < 0 or > MaxMonitors)
            {
                errors["maxCloudMonitors"] = [$"Give a number from 0 to {MaxMonitors}, or null for unlimited."];
            }
            else
            {
                Set("maxCloudMonitors", request.MaxCloudMonitors, type.MaxCloudMonitors, v => type.MaxCloudMonitors = v);
            }
        }

        if (body.ContainsKey("minIntervalSec"))
        {
            if (request.MinIntervalSec is not { } interval || interval < intervalFloor || interval > MaxIntervalSec)
            {
                errors["minIntervalSec"] = [$"Give a number of seconds from {intervalFloor} to {MaxIntervalSec}."];
            }
            else
            {
                Set("minIntervalSec", interval, type.MinIntervalSec, v => type.MinIntervalSec = v);
            }
        }

        if (body.ContainsKey("historyDays"))
        {
            if (request.HistoryDays is not { } days || days is < 1 or > MaxHistoryDays)
            {
                errors["historyDays"] = [$"Give a number of days from 1 to {MaxHistoryDays}."];
            }
            else
            {
                Set("historyDays", days, type.HistoryDays, v => type.HistoryDays = v);
            }
        }

        foreach (var (field, value, current, write) in new (string, int?, int?, Action<int?>)[]
                 {
                     ("monthlyPriceCents", request.MonthlyPriceCents, type.MonthlyPriceCents, v => type.MonthlyPriceCents = v),
                     ("yearlyPriceCents", request.YearlyPriceCents, type.YearlyPriceCents, v => type.YearlyPriceCents = v),
                 })
        {
            if (!body.ContainsKey(field))
            {
                continue;
            }

            if (value is < 0 or > MaxPriceCents)
            {
                errors[field] = [$"Give an amount in cents from 0 to {MaxPriceCents}, or null for none."];
            }
            else if (value is not null && type.IsFree)
            {
                errors[field] = ["The Free account type has no price."];
            }
            else
            {
                Set(field, value, current, write);
            }
        }

        if (body.ContainsKey("currency"))
        {
            var currency = request.Currency?.Trim().ToLowerInvariant() ?? "";
            if (!CurrencyPattern().IsMatch(currency))
            {
                errors["currency"] = ["Give a three-letter ISO 4217 code, such as usd."];
            }
            else
            {
                Set("currency", currency, type.Currency, v => type.Currency = v);
            }
        }

        return changed;
    }

    private static ProblemHttpResult NotFound() => ApiProblems.Of(ProblemTypes.NotFound, "There is no such account type.");

    [GeneratedRegex("^[a-z][a-z0-9-]{1,31}$")]
    private static partial Regex KeyPattern();

    [GeneratedRegex("^[a-z]{3}$")]
    private static partial Regex CurrencyPattern();
}
