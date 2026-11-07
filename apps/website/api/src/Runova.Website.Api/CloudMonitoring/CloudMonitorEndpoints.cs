using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Runova.Website.Api.Accounts;
using Runova.Website.Api.Billing;
using Runova.Website.Api.Dependencies;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Paging;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Billing;
using Runova.Website.Core.Monitoring;
using Runova.Website.Core.Paging;
using Runova.Website.Core.Problems;
using Runova.Website.Data;
using Runova.Website.Data.Monitoring;
using JsonOptions = Microsoft.AspNetCore.Http.Json.JsonOptions;

namespace Runova.Website.Api.CloudMonitoring;

/// <summary>
/// Online monitors (E55). Everyone who can see a scope reads its monitors; Owners, Admins and
/// Members change them; a Viewer only reads, and can mute one for themselves. A scope or monitor
/// the account can not see answers 404. Creating, resuming or shortening an interval checks the
/// scope's account type (a team's is its owner's).
/// </summary>
internal static partial class CloudMonitorEndpoints
{
    public const int MaxSamples = 2000;
    public static readonly TimeSpan MaxSampleRange = TimeSpan.FromDays(31);
    public static readonly TimeSpan MaxHourRange = TimeSpan.FromDays(400);

    [GeneratedRegex("^[A-Za-z0-9_.:-]{1,64}$", RegexOptions.CultureInvariant)]
    private static partial Regex ItemId();

    public static RouteGroupBuilder MapCloudMonitors(this RouteGroupBuilder api)
    {
        var monitors = api.MapGroup("/cloud-monitors").RequireAuthorization(Policies.Account);
        monitors.MapGet("", ListAsync);
        monitors.MapPost("", CreateAsync).Accepts<CloudMonitorWriteRequest>("application/json");
        monitors.MapGet("/usage", UsageAsync);
        monitors.MapGet("/{id:long}", GetAsync);
        monitors.MapPatch("/{id:long}", PatchAsync).Accepts<CloudMonitorWriteRequest>("application/merge-patch+json", "application/json");
        monitors.MapDelete("/{id:long}", DeleteAsync);
        monitors.MapPut("/{id:long}/secrets/current", PutSecretAsync);
        monitors.MapGet("/{id:long}/samples", SamplesAsync);
        monitors.MapGet("/{id:long}/hours", HoursAsync);
        monitors.MapGet("/{id:long}/incidents", IncidentsAsync);
        monitors.MapPut("/{id:long}/mutes/me", MuteAsync);
        monitors.MapDelete("/{id:long}/mutes/me", UnmuteAsync);
        return api;
    }

    private static ProblemHttpResult NotFound() => ApiProblems.Of(ProblemTypes.NotFound, "There is no such online monitor for this account.");

    private static ProblemHttpResult NoScope() => ApiProblems.Of(ProblemTypes.NotFound, "There is no such sync scope for this account.");

    private static ProblemHttpResult ReadOnly() => ApiProblems.Of(ProblemTypes.Forbidden, "A Viewer can read the team's monitors but not change them.");

    private static ProblemHttpResult OverLimit(Entitlement entitlement) =>
        ApiProblems.Of(
            ProblemTypes.Conflict,
            entitlement.MaxCloudMonitors == 1
                ? $"{entitlement.Name} allows 1 online monitor. Pause one, or choose a type with more."
                : $"{entitlement.Name} allows {entitlement.MaxCloudMonitors} online monitors. Pause one, or choose a type with more.",
            new Dictionary<string, object?> { ["limit"] = entitlement.MaxCloudMonitors, ["accountType"] = entitlement.Key });

    /// <summary>The monitor and what the account may do with it, or null when it can not see it.</summary>
    private static async Task<(CloudMonitor Monitor, ScopeAccess Access)?> FindAsync(AppDbContext db, SyncAccess access, long userId, long id)
    {
        if (await db.CloudMonitors.SingleOrDefaultAsync(m => m.Id == id) is not { } monitor)
        {
            return null;
        }

        return await access.FindAsync(userId, monitor.ScopeId) is { } found ? (monitor, found) : null;
    }

    private static async Task<Results<Ok<CloudMonitorListDto>, ProblemHttpResult>> ListAsync(
        long? scopeId, HttpContext http, AppDbContext db, SyncAccess access, CloudMonitorViews views)
    {
        var userId = CurrentAccount.Id(http);
        var scopes = await access.ListAsync(userId);
        if (scopeId is { } only)
        {
            scopes = [.. scopes.Where(s => s.Scope.Id == only)];
            if (scopes.Count == 0)
            {
                return NoScope();
            }
        }

        var ids = scopes.Select(s => s.Scope.Id).ToList();
        var items = await views.ListAsync(db.CloudMonitors.Where(m => ids.Contains(m.ScopeId)), userId, scopes.ToDictionary(s => s.Scope.Id, s => s.CanWrite), http.RequestAborted);
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(new CloudMonitorListDto(items));
    }

    private static async Task<Results<Ok<CloudMonitorDto>, ProblemHttpResult>> GetAsync(
        long id, HttpContext http, AppDbContext db, SyncAccess access, CloudMonitorViews views)
    {
        var userId = CurrentAccount.Id(http);
        if (await FindAsync(db, access, userId, id) is not var (monitor, found))
        {
            return NotFound();
        }

        Versions.SetETag(http.Response, monitor.Version);
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(await views.OneAsync(id, userId, found.CanWrite, http.RequestAborted));
    }

    private static async Task<Results<Created<CloudMonitorDto>, ValidationProblem, ProblemHttpResult>> CreateAsync(
        HttpContext http,
        AppDbContext db,
        SyncAccess access,
        Entitlements entitlements,
        CloudMonitorSecrets secrets,
        MonitorAssigner assigner,
        CloudMonitorNotifier notifier,
        CloudMonitorViews views,
        TimeProvider time,
        IOptions<JsonOptions> json)
    {
        var errors = new Dictionary<string, string[]>();
        if (await RequestBodies.ReadObjectAsync(http.Request, errors) is not { } body
            || RequestBodies.Deserialize<CloudMonitorWriteRequest>(body, json.Value.SerializerOptions, errors) is not { } request)
        {
            return ApiProblems.Invalid(errors);
        }

        if (request.ScopeId is not { } scopeId)
        {
            return ApiProblems.Invalid("scopeId", "Give the sync scope the monitor belongs to.");
        }

        var userId = CurrentAccount.Id(http);
        if (await access.FindAsync(userId, scopeId) is not { } found)
        {
            return NoScope();
        }

        if (!found.CanWrite)
        {
            return ReadOnly();
        }

        var now = time.GetUtcNow();
        var monitor = new CloudMonitor
        {
            ScopeId = scopeId,
            ItemId = "",
            Name = "",
            ProjectName = "",
            Url = "",
            IntervalSec = 300,
            TimeoutSec = 10,
            CreatedAt = now,
            UpdatedAt = now,
            CreatedBy = userId,
        };
        if (!ItemId().IsMatch(request.ItemId ?? ""))
        {
            errors["itemId"] = ["An item id is 1 to 64 letters, digits, dots, colons, dashes or underscores."];
        }
        else
        {
            monitor.ItemId = request.ItemId!;
        }

        foreach (var required in new[] { "name", "projectName", "url", "intervalSec" })
        {
            if (!body.ContainsKey(required))
            {
                errors[required] = ["This field is required."];
            }
        }

        var entitlement = await entitlements.ForScopeAsync(scopeId, http.RequestAborted);
        Apply(body, request, monitor, entitlement, secrets, now, errors);
        if (monitor.AuthMode != CloudAuthModes.None && monitor.SealedSecret is null && !errors.ContainsKey("secret"))
        {
            errors["secret"] = ["Give the access key the endpoint expects."];
        }

        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        await using var transaction = await db.Database.BeginTransactionAsync(http.RequestAborted);
        await LockScopeAsync(db, scopeId, http.RequestAborted);
        if (!monitor.Paused && !entitlement.AllowsMonitors(await ActiveAsync(db, scopeId, null) + 1))
        {
            return OverLimit(entitlement);
        }

        if (await db.CloudMonitors.AnyAsync(m => m.ScopeId == scopeId && m.ItemId == monitor.ItemId))
        {
            return ApiProblems.Of(ProblemTypes.Conflict, "This monitor is online already.");
        }

        db.CloudMonitors.Add(monitor);
        await db.SaveChangesAsync(http.RequestAborted);
        db.CloudMonitorStatuses.Add(new CloudMonitorStatus { MonitorId = monitor.Id });
        await db.SaveChangesAsync(http.RequestAborted);
        await transaction.CommitAsync(http.RequestAborted);

        await assigner.SyncAsync([monitor.Id], [], http.RequestAborted);
        await notifier.ScopeChangedAsync(scopeId, http.RequestAborted);
        Versions.SetETag(http.Response, monitor.Version);
        return TypedResults.Created($"{ApiV1.Prefix}/cloud-monitors/{monitor.Id}", await views.OneAsync(monitor.Id, userId, true, http.RequestAborted));
    }

    private static async Task<Results<Ok<CloudMonitorDto>, ValidationProblem, ProblemHttpResult>> PatchAsync(
        long id,
        HttpContext http,
        AppDbContext db,
        SyncAccess access,
        Entitlements entitlements,
        CloudMonitorSecrets secrets,
        MonitorAssigner assigner,
        CloudMonitorNotifier notifier,
        CloudMonitorViews views,
        TimeProvider time,
        IOptions<JsonOptions> json)
    {
        var userId = CurrentAccount.Id(http);
        if (await FindAsync(db, access, userId, id) is not var (monitor, found))
        {
            return NotFound();
        }

        if (!found.CanWrite)
        {
            return ReadOnly();
        }

        if (Versions.CheckIfMatch(http.Request, monitor.Version) is { } precondition)
        {
            return precondition;
        }

        var errors = new Dictionary<string, string[]>();
        if (await RequestBodies.ReadObjectAsync(http.Request, errors) is not { } body
            || RequestBodies.Deserialize<CloudMonitorWriteRequest>(body, json.Value.SerializerOptions, errors) is not { } request)
        {
            return ApiProblems.Invalid(errors);
        }

        foreach (var fixedField in new[] { "scopeId", "itemId" })
        {
            if (body.ContainsKey(fixedField))
            {
                errors[fixedField] = ["This is set when the monitor is made and does not change."];
            }
        }

        var wasPaused = monitor.Paused;
        var definition = monitor.DefinitionVersion;
        var entitlement = await entitlements.ForScopeAsync(monitor.ScopeId, http.RequestAborted);
        Apply(body, request, monitor, entitlement, secrets, time.GetUtcNow(), errors);
        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        await using var transaction = await db.Database.BeginTransactionAsync(http.RequestAborted);
        if (wasPaused && !monitor.Paused)
        {
            await LockScopeAsync(db, monitor.ScopeId, http.RequestAborted);
            if (!entitlement.AllowsMonitors(await ActiveAsync(db, monitor.ScopeId, monitor.Id) + 1))
            {
                return OverLimit(entitlement);
            }
        }

        try
        {
            await db.SaveChangesAsync(http.RequestAborted);
        }
        catch (DbUpdateConcurrencyException)
        {
            return Versions.Stale(await db.CloudMonitors.AsNoTracking().Where(m => m.Id == id).Select(m => m.Version).SingleAsync());
        }

        await transaction.CommitAsync(http.RequestAborted);
        if (monitor.Paused != wasPaused || monitor.DefinitionVersion != definition)
        {
            await assigner.SyncAsync([monitor.Id], [], http.RequestAborted);
        }

        await notifier.ScopeChangedAsync(monitor.ScopeId, http.RequestAborted);
        Versions.SetETag(http.Response, monitor.Version);
        return TypedResults.Ok(await views.OneAsync(monitor.Id, userId, true, http.RequestAborted));
    }

    private static async Task<Results<NoContent, ProblemHttpResult>> DeleteAsync(
        long id, HttpContext http, AppDbContext db, SyncAccess access, MonitorAssigner assigner, CloudMonitorNotifier notifier)
    {
        var userId = CurrentAccount.Id(http);
        if (await FindAsync(db, access, userId, id) is not var (monitor, found))
        {
            return NotFound();
        }

        if (!found.CanWrite)
        {
            return ReadOnly();
        }

        if (Versions.CheckIfMatch(http.Request, monitor.Version) is { } precondition)
        {
            return precondition;
        }

        var node = await db.CloudMonitorStatuses.Where(s => s.MonitorId == id).Select(s => s.NodeId).SingleOrDefaultAsync();
        db.CloudMonitors.Remove(monitor);
        try
        {
            await db.SaveChangesAsync(http.RequestAborted);
        }
        catch (DbUpdateConcurrencyException)
        {
            return NotFound();
        }

        await assigner.SyncAsync([], node is { } on ? [(id, on)] : [], http.RequestAborted);
        await notifier.ScopeChangedAsync(monitor.ScopeId, http.RequestAborted);
        return TypedResults.NoContent();
    }

    /// <summary>Replaces the access key. It is sealed at once and never comes back.</summary>
    private static async Task<Results<NoContent, ValidationProblem, ProblemHttpResult>> PutSecretAsync(
        long id,
        CloudMonitorSecretRequest request,
        HttpContext http,
        AppDbContext db,
        SyncAccess access,
        CloudMonitorSecrets secrets,
        MonitorAssigner assigner,
        TimeProvider time)
    {
        var userId = CurrentAccount.Id(http);
        if (await FindAsync(db, access, userId, id) is not var (monitor, found))
        {
            return NotFound();
        }

        if (!found.CanWrite)
        {
            return ReadOnly();
        }

        if (monitor.AuthMode == CloudAuthModes.None)
        {
            return ApiProblems.Invalid("secret", "This monitor sends no access key. Choose bearer or basic first.");
        }

        if (SecretProblem(request.Secret, monitor.AuthMode) is { } problem)
        {
            return ApiProblems.Invalid("secret", problem);
        }

        monitor.SealedSecret = secrets.Seal(request.Secret!);
        monitor.SecretChangedAt = time.GetUtcNow();
        monitor.UpdatedAt = monitor.SecretChangedAt.Value;
        monitor.DefinitionVersion++;
        await db.SaveChangesAsync(http.RequestAborted);
        await assigner.SyncAsync([monitor.Id], [], http.RequestAborted);
        return TypedResults.NoContent();
    }

    private static async Task<Results<Ok<CloudMonitorSampleListDto>, ValidationProblem, ProblemHttpResult>> SamplesAsync(
        long id, string? from, string? to, HttpContext http, AppDbContext db, SyncAccess access, TimeProvider time)
    {
        if (await FindAsync(db, access, CurrentAccount.Id(http), id) is null)
        {
            return NotFound();
        }

        if (Range(from, to, time.GetUtcNow(), TimeSpan.FromHours(24), MaxSampleRange, out var errors) is not var (start, end))
        {
            return ApiProblems.Invalid(errors);
        }

        var rows = await (from s in db.CloudMonitorSamples.AsNoTracking()
                          where s.MonitorId == id && s.CheckedAt >= start && s.CheckedAt <= end
                          orderby s.CheckedAt descending
                          join n in db.MonitoringNodes on s.NodeId equals n.Id into nodes
                          from n in nodes.DefaultIfEmpty()
                          select new CloudMonitorSampleRow { Sample = s, Node = n })
            .ProjectToDto()
            .Take(MaxSamples).ToListAsync(http.RequestAborted);
        rows.Reverse();
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(new CloudMonitorSampleListDto(rows));
    }

    private static async Task<Results<Ok<CloudMonitorHourListDto>, ValidationProblem, ProblemHttpResult>> HoursAsync(
        long id, string? from, string? to, HttpContext http, AppDbContext db, SyncAccess access, TimeProvider time)
    {
        if (await FindAsync(db, access, CurrentAccount.Id(http), id) is null)
        {
            return NotFound();
        }

        if (Range(from, to, time.GetUtcNow(), TimeSpan.FromDays(30), MaxHourRange, out var errors) is not var (start, end))
        {
            return ApiProblems.Invalid(errors);
        }

        var first = CloudMonitorRules.HourOf(start);
        var rows = await db.CloudMonitorHours.AsNoTracking()
            .Where(h => h.MonitorId == id && h.Hour >= first && h.Hour <= end)
            .OrderBy(h => h.Hour)
            .ToListAsync(http.RequestAborted);
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(new CloudMonitorHourListDto([.. rows.Select(CloudMonitorMapper.ToDto)]));
    }

    private static async Task<Results<Ok<Page<CloudMonitorIncidentDto>>, ValidationProblem, ProblemHttpResult>> IncidentsAsync(
        long id, int? page, int? pageSize, HttpContext http, AppDbContext db, SyncAccess access, CloudMonitorViews views)
    {
        var request = PageRequest.Parse(page, pageSize, out var errors);
        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        if (await FindAsync(db, access, CurrentAccount.Id(http), id) is null)
        {
            return NotFound();
        }

        var mine = db.CloudMonitorIncidents.Where(i => i.MonitorId == id);
        var total = await mine.CountAsync(http.RequestAborted);
        var rows = await views.IncidentsAsync(mine.OrderByDescending(i => i.OpenedAt).ThenByDescending(i => i.Id).Skip(request.Skip).Take(request.Size), http.RequestAborted);
        var result = Page.Of(rows, request, total);
        PageLinks.Set(http, result);
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(result);
    }

    private static async Task<Results<NoContent, ProblemHttpResult>> MuteAsync(long id, HttpContext http, AppDbContext db, SyncAccess access, TimeProvider time)
    {
        var userId = CurrentAccount.Id(http);
        if (await FindAsync(db, access, userId, id) is null)
        {
            return NotFound();
        }

        await db.Database.ExecuteSqlAsync(
            $"""INSERT INTO "CloudMonitorMutes" ("MonitorId", "UserId", "At") VALUES ({id}, {userId}, {time.GetUtcNow()}) ON CONFLICT DO NOTHING""",
            http.RequestAborted);
        return TypedResults.NoContent();
    }

    private static async Task<Results<NoContent, ProblemHttpResult>> UnmuteAsync(long id, HttpContext http, AppDbContext db, SyncAccess access)
    {
        var userId = CurrentAccount.Id(http);
        if (await FindAsync(db, access, userId, id) is null)
        {
            return NotFound();
        }

        await db.CloudMonitorMutes.Where(m => m.MonitorId == id && m.UserId == userId).ExecuteDeleteAsync(http.RequestAborted);
        return TypedResults.NoContent();
    }

    /// <summary>What each scope the account sees may have and has, for the plan chip and the limits in the dialogs.</summary>
    private static async Task<Ok<MonitoringUsageDto>> UsageAsync(HttpContext http, AppDbContext db, SyncAccess access, Entitlements entitlements)
    {
        var scopes = await access.ListAsync(CurrentAccount.Id(http));
        var ids = scopes.Select(s => s.Scope.Id).ToList();
        var counts = await db.CloudMonitors.AsNoTracking().Where(m => ids.Contains(m.ScopeId))
            .GroupBy(m => m.ScopeId)
            .Select(g => new { g.Key, Active = g.Count(m => !m.Paused), Paused = g.Count(m => m.Paused) })
            .ToDictionaryAsync(x => x.Key, http.RequestAborted);
        var items = new List<ScopeMonitoringUsageDto>();
        foreach (var scope in scopes)
        {
            var entitlement = await entitlements.ForScopeAsync(scope.Scope.Id, http.RequestAborted);
            var count = counts.GetValueOrDefault(scope.Scope.Id);
            items.Add(new ScopeMonitoringUsageDto(
                scope.Scope.Id, scope.Scope.Kind, scope.Name, scope.CanWrite, entitlement.Key, entitlement.Name,
                entitlement.MaxCloudMonitors, CloudMonitorRules.Floor(entitlement), entitlement.HistoryDays,
                count?.Active ?? 0, count?.Paused ?? 0));
        }

        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(new MonitoringUsageDto(items));
    }

    private static Task<int> LockScopeAsync(AppDbContext db, long scopeId, CancellationToken ct) =>
        db.Database.ExecuteSqlAsync($"SELECT 1 FROM \"SyncScopes\" WHERE \"Id\" = {scopeId} FOR UPDATE", ct);

    private static Task<int> ActiveAsync(AppDbContext db, long scopeId, long? except) =>
        db.CloudMonitors.CountAsync(m => m.ScopeId == scopeId && !m.Paused && m.Id != except);

    /// <summary>The fields the body names, checked against each other and the scope's type.</summary>
    private static void Apply(
        JsonObject body, CloudMonitorWriteRequest request, CloudMonitor monitor, Entitlement entitlement, CloudMonitorSecrets secrets,
        DateTimeOffset now, Dictionary<string, string[]> errors)
    {
        var before = (monitor.Url, monitor.IntervalSec, monitor.TimeoutSec, monitor.AuthMode, monitor.AllowInsecure, monitor.SealedSecret);
        string? Text(string field, string? value, int max, bool required)
        {
            var text = value?.Trim() ?? "";
            if (text.Length == 0 && !required)
            {
                return null;
            }

            if (text.Length is 0 || text.Length > max || text.Any(char.IsControl))
            {
                errors[field] = [$"Give 1 to {max} characters."];
                return null;
            }

            return text;
        }

        if (body.ContainsKey("name") && Text("name", request.Name, CloudMonitorRules.NameMax, true) is { } name)
        {
            monitor.Name = name;
        }

        if (body.ContainsKey("projectName") && Text("projectName", request.ProjectName, CloudMonitorRules.NameMax, true) is { } project)
        {
            monitor.ProjectName = project;
        }

        if (body.ContainsKey("environmentName"))
        {
            monitor.EnvironmentName = Text("environmentName", request.EnvironmentName, CloudMonitorRules.NameMax, false);
        }

        if (body.ContainsKey("allowInsecure"))
        {
            monitor.AllowInsecure = request.AllowInsecure ?? false;
        }

        if (body.ContainsKey("url"))
        {
            monitor.Url = request.Url?.Trim() ?? "";
        }

        if ((body.ContainsKey("url") || body.ContainsKey("allowInsecure")) && CloudMonitorRules.UrlProblem(monitor.Url, monitor.AllowInsecure) is { } urlProblem)
        {
            errors["url"] = [urlProblem];
        }

        if (body.ContainsKey("intervalSec"))
        {
            if (CloudMonitorRules.IntervalProblem(request.IntervalSec, entitlement) is { } intervalProblem)
            {
                errors["intervalSec"] = [intervalProblem];
            }
            else
            {
                monitor.IntervalSec = request.IntervalSec!.Value;
            }
        }

        if (body.ContainsKey("timeoutSec"))
        {
            monitor.TimeoutSec = request.TimeoutSec ?? 0;
        }

        if (!errors.ContainsKey("intervalSec") && CloudMonitorRules.TimeoutProblem(monitor.TimeoutSec, monitor.IntervalSec) is { } timeoutProblem)
        {
            errors["timeoutSec"] = [timeoutProblem];
        }

        if (body.ContainsKey("authMode"))
        {
            if (request.AuthMode is not { } mode || !CloudAuthModes.All.Contains(mode))
            {
                errors["authMode"] = ["The access is none, bearer or basic."];
            }
            else
            {
                if (mode != monitor.AuthMode)
                {
                    monitor.SealedSecret = null;
                    monitor.SecretChangedAt = null;
                }

                monitor.AuthMode = mode;
            }
        }

        if (body.ContainsKey("secret") && !errors.ContainsKey("authMode"))
        {
            if (monitor.AuthMode == CloudAuthModes.None)
            {
                if (!string.IsNullOrEmpty(request.Secret))
                {
                    errors["secret"] = ["This monitor sends no access key. Choose bearer or basic first."];
                }
            }
            else if (SecretProblem(request.Secret, monitor.AuthMode) is { } secretProblem)
            {
                errors["secret"] = [secretProblem];
            }
            else
            {
                monitor.SealedSecret = secrets.Seal(request.Secret!);
                monitor.SecretChangedAt = now;
            }
        }

        if (body.ContainsKey("paused"))
        {
            monitor.Paused = request.Paused ?? false;
            monitor.SuspendedReason = null;
        }

        if (body.ContainsKey("notifyInApp"))
        {
            monitor.NotifyInApp = request.NotifyInApp ?? true;
        }

        if (body.ContainsKey("notifyTelegram"))
        {
            monitor.NotifyTelegram = request.NotifyTelegram ?? false;
        }

        if ((monitor.Url, monitor.IntervalSec, monitor.TimeoutSec, monitor.AuthMode, monitor.AllowInsecure, monitor.SealedSecret) != before && monitor.Id != 0)
        {
            monitor.DefinitionVersion++;
        }

        monitor.UpdatedAt = now;
    }

    private static string? SecretProblem(string? secret, string authMode)
    {
        if (string.IsNullOrEmpty(secret) || secret.Length > CloudMonitorRules.SecretMax || secret.Any(char.IsControl))
        {
            return $"Give the access key, up to {CloudMonitorRules.SecretMax} characters.";
        }

        return authMode == CloudAuthModes.Basic && secret.IndexOf(':', StringComparison.Ordinal) is < 1
            ? "For basic, give user:password."
            : null;
    }

    /// <summary>The time range asked for, or null with the errors. ISO 8601 times; the default ends now.</summary>
    private static (DateTimeOffset Start, DateTimeOffset End)? Range(
        string? from, string? to, DateTimeOffset now, TimeSpan defaultSpan, TimeSpan maxSpan, out Dictionary<string, string[]> errors)
    {
        errors = [];
        static bool Parse(string? text, out DateTimeOffset value) =>
            DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out value);
        var end = now;
        if (to is not null && !Parse(to, out end))
        {
            errors["to"] = ["Give an ISO 8601 time, such as 2026-11-07T09:00:00Z."];
        }

        var start = end - defaultSpan;
        if (from is not null && !Parse(from, out start))
        {
            errors["from"] = ["Give an ISO 8601 time, such as 2026-11-07T09:00:00Z."];
        }

        if (errors.Count == 0 && (start > end || end - start > maxSpan))
        {
            errors["from"] = [$"Ask for {maxSpan.TotalDays:0} days at most, with from before to."];
        }

        return errors.Count == 0 ? (start, end) : null;
    }
}
