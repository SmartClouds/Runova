using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Npgsql;
using Runova.Website.Api.Dependencies;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Paging;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Paging;
using Runova.Website.Core.Problems;
using Runova.Website.Data;
using Runova.Website.Data.Remote;
using JsonOptions = Microsoft.AspNetCore.Http.Json.JsonOptions;

namespace Runova.Website.Api.Remote;

/// <summary>
/// Runova Anywhere (E60): an account's computers and their access settings, the computers it may
/// connect to, and the record of its sessions. Connecting itself goes through <see cref="RemoteHub"/>.
/// </summary>
internal static class RemoteEndpoints
{
    public const int NameMax = 100;

    public static readonly IReadOnlySet<string> Platforms = new HashSet<string>(StringComparer.Ordinal) { "windows", "macos", "linux" };

    /// <summary>How long a session record is kept.</summary>
    public static readonly TimeSpan KeepRecordsFor = TimeSpan.FromDays(30);

    public static RouteGroupBuilder MapRemote(this RouteGroupBuilder api)
    {
        var devices = api.MapGroup("/remote-devices").RequireAuthorization(Policies.Account);
        devices.MapGet("", ListAsync);
        devices.MapPost("", RegisterAsync);
        devices.MapPatch("/{id:long}", UpdateAsync).Accepts<UpdateRemoteDeviceRequest>("application/merge-patch+json", "application/json");
        devices.MapDelete("/{id:long}", RemoveAsync);
        api.MapGet("/reachable-devices", ReachableAsync).RequireAuthorization(Policies.Account);
        api.MapGet("/remote-sessions", SessionsAsync).RequireAuthorization(Policies.Account);
        api.MapDelete("/remote-sessions/{id:long}", DeleteSessionAsync).RequireAuthorization(Policies.Account);
        return api;
    }

    private static async Task<Ok<RemoteDeviceListDto>> ListAsync(HttpContext http, AppDbContext db, RemotePresence presence)
    {
        var me = CurrentAccount.Id(http);
        var devices = await db.RemoteDevices.AsNoTracking()
            .Where(d => d.UserId == me && d.RevokedAt == null)
            .OrderBy(d => d.Name).ThenBy(d => d.Id)
            .ToListAsync();
        var teams = await TeamIdsAsync(db, devices.Select(d => d.Id));
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(new RemoteDeviceListDto([.. devices.Select(d => RemoteMapper.ToDto(d, [.. teams[d.Id]], presence.IsOnline(d.Id)))]));
    }

    private static async Task<Results<Created<RemoteDeviceDto>, Ok<RemoteDeviceDto>, ValidationProblem>> RegisterAsync(
        [FromBody] RegisterRemoteDeviceRequest request, HttpContext http, AppDbContext db, RemotePresence presence, TimeProvider time)
    {
        var errors = new Dictionary<string, string[]>();
        var name = request.Name?.Trim() ?? "";
        if (name.Length is 0 or > NameMax)
        {
            errors["name"] = [$"Name the computer, up to {NameMax} characters."];
        }

        if (request.Platform is null || !Platforms.Contains(request.Platform))
        {
            errors["platform"] = ["platform is windows, macos or linux."];
        }

        if (!IsIdentityKey(request.IdentityKey))
        {
            errors["identityKey"] = ["identityKey is an Ed25519 public key: 32 bytes in base64url."];
        }

        if (request.DeviceId == Guid.Empty)
        {
            errors["deviceId"] = ["deviceId is the app's id for this computer."];
        }

        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        var me = CurrentAccount.Id(http);
        var now = time.GetUtcNow();
        if (await db.RemoteDevices.SingleOrDefaultAsync(d => d.UserId == me && d.DeviceId == request.DeviceId && d.Kind == RemoteDeviceKinds.App && d.RevokedAt == null) is { } existing)
        {
            existing.Name = name;
            existing.Platform = request.Platform!;
            existing.IdentityKey = request.IdentityKey;
            existing.LastSeenAt = now;
            await db.SaveChangesAsync();
            var teams = await TeamIdsAsync(db, [existing.Id]);
            return TypedResults.Ok(RemoteMapper.ToDto(existing, [.. teams[existing.Id]], presence.IsOnline(existing.Id)));
        }

        var device = new RemoteDevice
        {
            UserId = me,
            DeviceId = request.DeviceId,
            Kind = RemoteDeviceKinds.App,
            Name = name,
            Platform = request.Platform!,
            IdentityKey = request.IdentityKey,
            CreatedAt = now,
            LastSeenAt = now,
        };
        db.RemoteDevices.Add(device);
        // An id is drawn from 900 million, so a clash is rare; on one, draw again.
        for (var attempt = 0; ; attempt++)
        {
            device.RemoteId = RemoteIds.New();
            try
            {
                await db.SaveChangesAsync();
                break;
            }
            catch (DbUpdateException e) when (e.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation } && attempt < 5)
            {
            }
        }

        return TypedResults.Created($"{ApiV1.Prefix}/remote-devices/{device.Id}", RemoteMapper.ToDto(device, [], online: false));
    }

    private static async Task<Results<Ok<RemoteDeviceDto>, ValidationProblem, ProblemHttpResult>> UpdateAsync(
        long id, HttpContext http, AppDbContext db, RemotePresence presence, IOptions<JsonOptions> json)
    {
        var me = CurrentAccount.Id(http);
        if (await db.RemoteDevices.SingleOrDefaultAsync(d => d.Id == id && d.UserId == me && d.RevokedAt == null) is not { } device)
        {
            return NotFound();
        }

        var errors = new Dictionary<string, string[]>();
        if (await RequestBodies.ReadObjectAsync(http.Request, errors) is not { } body
            || RequestBodies.Deserialize<UpdateRemoteDeviceRequest>(body, json.Value.SerializerOptions, errors) is not { } request)
        {
            return ApiProblems.Invalid(errors);
        }

        var name = request.Name?.Trim();
        if (name is { Length: 0 or > NameMax })
        {
            errors["name"] = [$"Name the computer, up to {NameMax} characters."];
        }

        var teamIds = request.TeamIds?.Distinct().ToList();
        if (teamIds is { Count: > 0 })
        {
            var mine = await db.TeamMembers.Where(m => m.UserId == me && teamIds.Contains(m.TeamId)).CountAsync();
            if (mine != teamIds.Count)
            {
                errors["teamIds"] = ["A computer can be shown only to teams you are in."];
            }
        }

        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        device.Name = name ?? device.Name;
        device.AllowOwnDevices = request.AllowOwnDevices ?? device.AllowOwnDevices;
        device.UnattendedEnabled = request.UnattendedEnabled ?? device.UnattendedEnabled;
        if (teamIds is not null)
        {
            await db.RemoteDeviceTeams.Where(l => l.RemoteDeviceId == id).ExecuteDeleteAsync();
            db.RemoteDeviceTeams.AddRange(teamIds.Select(t => new RemoteDeviceTeam { RemoteDeviceId = id, TeamId = t }));
        }

        await db.SaveChangesAsync();
        var teams = await TeamIdsAsync(db, [id]);
        return TypedResults.Ok(RemoteMapper.ToDto(device, [.. teams[id]], presence.IsOnline(id)));
    }

    private static async Task<Results<NoContent, ProblemHttpResult>> RemoveAsync(
        long id, HttpContext http, AppDbContext db, RemotePresence presence, RemoteAudience audience, TimeProvider time)
    {
        var me = CurrentAccount.Id(http);
        if (await db.RemoteDevices.SingleOrDefaultAsync(d => d.Id == id && d.UserId == me && d.RevokedAt == null) is not { } device)
        {
            return NotFound();
        }

        var wasOnline = presence.Remove(id).Count > 0;
        if (wasOnline)
        {
            await audience.PresenceAsync(device, online: false);
        }

        device.RevokedAt = time.GetUtcNow();
        await db.RemoteDeviceTeams.Where(l => l.RemoteDeviceId == id).ExecuteDeleteAsync();
        await db.SaveChangesAsync();
        return TypedResults.NoContent();
    }

    private static async Task<Ok<RemoteDirectoryDto>> ReachableAsync(HttpContext http, AppDbContext db, RemotePresence presence)
    {
        var me = CurrentAccount.Id(http);
        var user = await db.Users.AsNoTracking().SingleAsync(u => u.Id == me);
        var mine = await db.RemoteDevices.AsNoTracking()
            .Where(d => d.UserId == me && d.RevokedAt == null)
            .OrderBy(d => d.Name).ThenBy(d => d.Id)
            .ToListAsync();

        var myTeams = db.TeamMembers.Where(m => m.UserId == me).Select(m => m.TeamId);
        var shown = await (from link in db.RemoteDeviceTeams
                           join device in db.RemoteDevices on link.RemoteDeviceId equals device.Id
                           join team in db.Teams on link.TeamId equals team.Id
                           where device.RevokedAt == null
                               && device.UserId != me
                               && myTeams.Contains(link.TeamId)
                               && db.TeamMembers.Any(m => m.TeamId == link.TeamId && m.UserId == device.UserId)
                           select new { Device = device, Team = team }).AsNoTracking().ToListAsync();
        var ownerIds = shown.Select(s => s.Device.UserId).Distinct().ToList();
        var owners = await db.Users.AsNoTracking().Where(u => ownerIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, RemoteMapper.ToOwner);

        var self = RemoteMapper.ToOwner(user);
        var teammates = shown
            .GroupBy(s => s.Device.Id)
            .Select(g => RemoteMapper.ToEntry(
                g.First().Device,
                owners[g.First().Device.UserId],
                [.. g.Select(s => new RemoteTeamDto(s.Team.Id, s.Team.Name)).OrderBy(t => t.Name, StringComparer.Ordinal)],
                presence.IsOnline(g.Key)))
            .OrderBy(e => e.Owner.DisplayName, StringComparer.Ordinal).ThenBy(e => e.Name, StringComparer.Ordinal)
            .ToList();

        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(new RemoteDirectoryDto(
            [.. mine.Select(d => RemoteMapper.ToEntry(d, self, [], presence.IsOnline(d.Id)))],
            teammates));
    }

    private static async Task<Results<Ok<Page<RemoteSessionDto>>, ValidationProblem>> SessionsAsync(
        int? page, int? pageSize, HttpContext http, AppDbContext db, TimeProvider time)
    {
        var request = PageRequest.Parse(page, pageSize, out var errors);
        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        var me = CurrentAccount.Id(http);
        var since = time.GetUtcNow() - KeepRecordsFor;
        var records = db.RemoteSessionRecords.AsNoTracking()
            .Where(r => (r.HostUserId == me || r.ControllerUserId == me) && r.StartedAt >= since);
        var total = await records.CountAsync();
        var items = await (from record in records
                           join device in db.RemoteDevices on record.HostDeviceId equals device.Id
                           join host in db.Users on record.HostUserId equals host.Id
                           join controller in db.Users on record.ControllerUserId equals controller.Id
                           orderby record.StartedAt descending, record.Id descending
                           select new RemoteSessionRow
                           {
                               Record = record,
                               Role = record.HostUserId == me ? "host" : "controller",
                               HostDevice = device,
                               HostUser = host,
                               ControllerUser = controller,
                           })
            .Skip(request.Skip).Take(request.Size)
            .ProjectToDto()
            .ToListAsync();

        var result = Page.Of(items, request, total);
        PageLinks.Set(http, result);
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(result);
    }

    private static async Task<Results<NoContent, ProblemHttpResult>> DeleteSessionAsync(long id, HttpContext http, AppDbContext db)
    {
        var me = CurrentAccount.Id(http);
        var deleted = await db.RemoteSessionRecords.Where(r => r.Id == id && (r.HostUserId == me || r.ControllerUserId == me)).ExecuteDeleteAsync();
        return deleted == 0
            ? ApiProblems.Of(ProblemTypes.NotFound, "There is no such session record for this account.")
            : TypedResults.NoContent();
    }

    /// <summary>A 32-byte Ed25519 public key in base64url, with no padding.</summary>
    public static bool IsIdentityKey(string? value)
    {
        if (value is not { Length: 43 })
        {
            return false;
        }

        try
        {
            return WebEncoders.Base64UrlDecode(value).Length == 32;
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private static async Task<ILookup<long, long>> TeamIdsAsync(AppDbContext db, IEnumerable<long> deviceIds)
    {
        var ids = deviceIds.ToList();
        var links = await db.RemoteDeviceTeams.AsNoTracking().Where(l => ids.Contains(l.RemoteDeviceId)).OrderBy(l => l.TeamId).ToListAsync();
        return links.ToLookup(l => l.RemoteDeviceId, l => l.TeamId);
    }

    private static ProblemHttpResult NotFound() => ApiProblems.Of(ProblemTypes.NotFound, "There is no such computer on this account.");
}
