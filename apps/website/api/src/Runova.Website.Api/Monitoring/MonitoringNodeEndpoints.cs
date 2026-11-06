using System.Net;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Runova.Monitoring.Contracts.Grpc;
using Runova.Website.Api.Audit;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Audit;
using Runova.Website.Core.Problems;
using Runova.Website.Data;
using Runova.Website.Data.Monitoring;
using JsonOptions = Microsoft.AspNetCore.Http.Json.JsonOptions;

namespace Runova.Website.Api.Monitoring;

public sealed record MonitoringNodeDto(
    long Id,
    string Name,
    string Region,
    int Capacity,
    string Status,
    bool Draining,
    string? SoftwareVersion,
    string? RemoteAddress,
    DateTimeOffset? EnrolledAt,
    DateTimeOffset? ConnectedAt,
    DateTimeOffset? LastSeenAt,
    int Monitors,
    int ChecksLastMinute,
    int QueuedResults,
    int LagMs,
    IReadOnlyList<string> AllowedAddresses,
    DateTimeOffset? EnrollmentTokenExpiresAt,
    DateTimeOffset? CertificateExpiresAt,
    DateTimeOffset CreatedAt,
    DateTimeOffset? RevokedAt,
    string Version);

/// <summary>The fields a node is written with. On a patch, a field left out keeps its value.</summary>
public sealed record MonitoringNodeWriteRequest(string? Name, string? Region, int? Capacity, IReadOnlyList<string>? AllowedAddresses, bool? Draining);

/// <summary>A one-time enrollment token. It is shown once and only its hash is kept.</summary>
public sealed record EnrollmentTokenDto(string Token, DateTimeOffset ExpiresAt, string ApiUrl);

public sealed record CreatedMonitoringNodeDto(MonitoringNodeDto Node, EnrollmentTokenDto Enrollment);

public sealed record NodeEnrollmentRequest(string? Token, string? Csr);

/// <summary>What a node keeps after enrolling. Certificates are base64 DER.</summary>
public sealed record NodeEnrollmentDto(long NodeId, string Certificate, IReadOnlyList<string> CaCertificates, string GatewayAddress, DateTimeOffset ExpiresAt);

/// <summary>Monitoring settings from <c>Monitoring:*</c>.</summary>
public sealed class MonitoringOptions
{
    /// <summary>Where nodes reach the gateway, such as <c>https://nodes.runovahq.com</c>. Enrollment is off without it.</summary>
    public string? GatewayAddress { get; set; }

    /// <summary>The address nodes enroll through, when it differs from the one the request came in on.</summary>
    public string? PublicApiUrl { get; set; }

    /// <summary>A node with no heartbeat for this long is offline.</summary>
    public TimeSpan OfflineAfter { get; set; } = TimeSpan.FromSeconds(45);
}

/// <summary>
/// Monitoring nodes (E54): Admins add, change, drain, revoke and remove them; a node enrolls
/// itself with the one-time token an Admin made for it.
/// </summary>
internal static partial class MonitoringNodeEndpoints
{
    public const int MaxAllowedAddresses = 20;
    public const int MaxCapacity = 10_000;
    public const int MaxCsrBytes = 8 * 1024;

    public static RouteGroupBuilder MapMonitoringNodes(this RouteGroupBuilder api)
    {
        var nodes = api.MapGroup("/monitoring-nodes").RequireAuthorization(Policies.Admin);
        nodes.MapGet("", ListAsync);
        nodes.MapPost("", CreateAsync);
        nodes.MapGet("/{id:long}", GetAsync);
        nodes.MapPatch("/{id:long}", PatchAsync)
            .Accepts<MonitoringNodeWriteRequest>("application/merge-patch+json", "application/json");
        nodes.MapDelete("/{id:long}", DeleteAsync);
        nodes.MapPost("/{id:long}/enrollment-tokens", NewTokenAsync);
        nodes.MapPost("/{id:long}/revocations", RevokeAsync);

        api.MapPost("/monitoring-node-enrollments", EnrollAsync)
            .AllowAnonymous()
            .RequireRateLimiting(AuthRateLimits.Policy)
            .Accepts<NodeEnrollmentRequest>("application/json");
        return api;
    }

    private static async Task<Ok<List<MonitoringNodeDto>>> ListAsync(HttpContext http, AppDbContext db, TimeProvider time, IOptions<MonitoringOptions> options)
    {
        var nodes = await db.MonitoringNodes.AsNoTracking().OrderBy(n => n.Region).ThenBy(n => n.Name).ToListAsync();
        var expiry = await CertificateExpiryAsync(db, nodes.Select(n => n.Id).ToList());
        var now = time.GetUtcNow();
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(nodes.Select(n => ToDto(n, now, options.Value, expiry.GetValueOrDefault(n.Id))).ToList());
    }

    private static async Task<Results<Ok<MonitoringNodeDto>, ProblemHttpResult>> GetAsync(
        long id, HttpContext http, AppDbContext db, TimeProvider time, IOptions<MonitoringOptions> options)
    {
        if (await db.MonitoringNodes.AsNoTracking().SingleOrDefaultAsync(n => n.Id == id) is not { } node)
        {
            return NotFound();
        }

        Versions.SetETag(http.Response, node.Version);
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(await DtoAsync(db, node, time, options.Value));
    }

    private static async Task<Results<Created<CreatedMonitoringNodeDto>, ValidationProblem, ProblemHttpResult>> CreateAsync(
        HttpContext http, AppDbContext db, AuditLog audit, TimeProvider time, IOptions<MonitoringOptions> options, IOptions<JsonOptions> json)
    {
        var errors = new Dictionary<string, string[]>();
        if (await RequestBodies.ReadObjectAsync(http.Request, errors) is not { } body
            || RequestBodies.Deserialize<MonitoringNodeWriteRequest>(body, json.Value.SerializerOptions, errors) is not { } request)
        {
            return ApiProblems.Invalid(errors);
        }

        var now = time.GetUtcNow();
        var node = new MonitoringNode { Name = "", Region = "", CreatedAt = now, CreatedBy = AuditLog.SignedInUserId(http.User) };
        if (!body.ContainsKey("name"))
        {
            errors["name"] = ["Give the node a name."];
        }

        if (!body.ContainsKey("region"))
        {
            errors["region"] = ["Give the node a region."];
        }

        Apply(body, request, node, errors);
        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        if (await db.MonitoringNodes.AnyAsync(n => n.Name == node.Name))
        {
            return ApiProblems.Of(ProblemTypes.Conflict, $"There is already a node named '{node.Name}'.");
        }

        var token = NodeTokens.New();
        node.EnrollmentTokenHash = NodeTokens.Hash(token);
        node.EnrollmentTokenExpiresAt = now + NodeTokens.Lifetime;
        db.MonitoringNodes.Add(node);
        await db.SaveChangesAsync();
        audit.Add(AuditActions.MonitoringNodeCreate, AuditTargetTypes.MonitoringNode, node.Id, new { node.Name, node.Region, node.Capacity });
        await db.SaveChangesAsync();

        Versions.SetETag(http.Response, node.Version);
        var created = new CreatedMonitoringNodeDto(
            ToDto(node, now, options.Value, null),
            new EnrollmentTokenDto(token, node.EnrollmentTokenExpiresAt.Value, ApiUrl(http, options.Value)));
        return TypedResults.Created($"{ApiV1.Prefix}/monitoring-nodes/{node.Id}", created);
    }

    private static async Task<Results<Ok<MonitoringNodeDto>, ValidationProblem, ProblemHttpResult>> PatchAsync(
        long id, HttpContext http, AppDbContext db, AuditLog audit, NodeEvents events, INodeBus bus, TimeProvider time,
        IOptions<MonitoringOptions> options, IOptions<JsonOptions> json)
    {
        if (await db.MonitoringNodes.SingleOrDefaultAsync(n => n.Id == id) is not { } node)
        {
            return NotFound();
        }

        if (Versions.CheckIfMatch(http.Request, node.Version) is { } precondition)
        {
            return precondition;
        }

        var errors = new Dictionary<string, string[]>();
        if (await RequestBodies.ReadObjectAsync(http.Request, errors) is not { } body
            || RequestBodies.Deserialize<MonitoringNodeWriteRequest>(body, json.Value.SerializerOptions, errors) is not { } request)
        {
            return ApiProblems.Invalid(errors);
        }

        if (node.Status == NodeStatuses.Revoked)
        {
            return ApiProblems.Of(ProblemTypes.Conflict, "A revoked node can not be changed.");
        }

        var wasDraining = node.Draining;
        var oldName = node.Name;
        Apply(body, request, node, errors);
        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        if (node.Name != oldName && await db.MonitoringNodes.AnyAsync(n => n.Name == node.Name && n.Id != node.Id))
        {
            return ApiProblems.Of(ProblemTypes.Conflict, $"There is already a node named '{node.Name}'.");
        }

        var changed = db.ChangeTracker.Entries().Where(e => e.State == EntityState.Modified)
            .SelectMany(e => e.Properties.Where(p => p.IsModified).Select(p => p.Metadata.Name)).ToList();
        if (changed.Count > 0)
        {
            audit.Add(
                node.Draining != wasDraining ? AuditActions.MonitoringNodeDrain : AuditActions.MonitoringNodeUpdate,
                AuditTargetTypes.MonitoringNode, node.Id, new { fields = changed });
        }

        await db.SaveChangesAsync();
        if (node.Status == NodeStatuses.Online && node.Draining != wasDraining)
        {
            if (node.Draining)
            {
                await bus.SendAsync(node.Id, new ServerMessage { Drain = new Drain { Reason = "An Admin is draining this node." } });
            }
            else
            {
                await events.SendSnapshotAsync(node);
            }
        }

        Versions.SetETag(http.Response, node.Version);
        return TypedResults.Ok(await DtoAsync(db, node, time, options.Value));
    }

    private static async Task<Results<NoContent, ProblemHttpResult>> DeleteAsync(long id, HttpContext http, AppDbContext db, AuditLog audit)
    {
        if (await db.MonitoringNodes.SingleOrDefaultAsync(n => n.Id == id) is not { } node)
        {
            return NotFound();
        }

        if (Versions.CheckIfMatch(http.Request, node.Version) is { } precondition)
        {
            return precondition;
        }

        if (node.Status is not (NodeStatuses.Pending or NodeStatuses.Revoked))
        {
            return ApiProblems.Of(ProblemTypes.Conflict, "Revoke the node first. Only a node that never enrolled or was revoked can be removed.");
        }

        db.MonitoringNodes.Remove(node);
        audit.Add(AuditActions.MonitoringNodeDelete, AuditTargetTypes.MonitoringNode, node.Id, new { node.Name });
        await db.SaveChangesAsync();
        return TypedResults.NoContent();
    }

    /// <summary>A new one-time token, replacing any unused one: for a first enrollment, or a node that lost its data.</summary>
    private static async Task<Results<Created<EnrollmentTokenDto>, ProblemHttpResult>> NewTokenAsync(
        long id, HttpContext http, AppDbContext db, AuditLog audit, TimeProvider time, IOptions<MonitoringOptions> options)
    {
        if (await db.MonitoringNodes.SingleOrDefaultAsync(n => n.Id == id) is not { } node)
        {
            return NotFound();
        }

        if (node.Status == NodeStatuses.Revoked)
        {
            return ApiProblems.Of(ProblemTypes.Conflict, "A revoked node can not enroll again. Add a new node.");
        }

        var token = NodeTokens.New();
        node.EnrollmentTokenHash = NodeTokens.Hash(token);
        node.EnrollmentTokenExpiresAt = time.GetUtcNow() + NodeTokens.Lifetime;
        audit.Add(AuditActions.MonitoringNodeEnrollmentToken, AuditTargetTypes.MonitoringNode, node.Id);
        await db.SaveChangesAsync();
        Versions.SetETag(http.Response, node.Version);
        return TypedResults.Created(
            $"{ApiV1.Prefix}/monitoring-nodes/{node.Id}",
            new EnrollmentTokenDto(token, node.EnrollmentTokenExpiresAt.Value, ApiUrl(http, options.Value)));
    }

    /// <summary>Revokes the node for good: its certificates are refused and its stream closes at once.</summary>
    private static async Task<Results<Ok<MonitoringNodeDto>, ProblemHttpResult>> RevokeAsync(
        long id, HttpContext http, AppDbContext db, AuditLog audit, INodeBus bus, TimeProvider time, IOptions<MonitoringOptions> options)
    {
        if (await db.MonitoringNodes.SingleOrDefaultAsync(n => n.Id == id) is not { } node)
        {
            return NotFound();
        }

        var now = time.GetUtcNow();
        var certificates = await db.NodeCertificates.Where(c => c.NodeId == node.Id).ToListAsync();
        if (node.Status != NodeStatuses.Revoked)
        {
            node.Status = NodeStatuses.Revoked;
            node.RevokedAt = now;
            node.GatewayId = null;
            node.EnrollmentTokenHash = null;
            node.EnrollmentTokenExpiresAt = null;
            node.Monitors = 0;
            foreach (var certificate in certificates.Where(c => c.RevokedAt is null))
            {
                certificate.RevokedAt = now;
            }

            audit.Add(AuditActions.MonitoringNodeRevoke, AuditTargetTypes.MonitoringNode, node.Id, new { node.Name });
            await db.SaveChangesAsync();
        }

        await bus.RevokedAsync(node.Id, certificates.Select(c => c.Serial).ToList());
        Versions.SetETag(http.Response, node.Version);
        return TypedResults.Ok(await DtoAsync(db, node, time, options.Value));
    }

    /// <summary>A node trades its one-time token and a CSR for its client certificate.</summary>
    private static async Task<Results<Created<NodeEnrollmentDto>, ValidationProblem, ProblemHttpResult>> EnrollAsync(
        HttpContext http, AppDbContext db, NodeCertificateAuthority authority, INodeBus bus, TimeProvider time,
        IOptions<MonitoringOptions> options, IOptions<JsonOptions> json)
    {
        if (string.IsNullOrWhiteSpace(options.Value.GatewayAddress))
        {
            return ApiProblems.Of(ProblemTypes.Unavailable, "Online monitoring is not set up on this server.");
        }

        var errors = new Dictionary<string, string[]>();
        if (await RequestBodies.ReadObjectAsync(http.Request, errors) is not { } body
            || RequestBodies.Deserialize<NodeEnrollmentRequest>(body, json.Value.SerializerOptions, errors) is not { } request)
        {
            return ApiProblems.Invalid(errors);
        }

        if (string.IsNullOrWhiteSpace(request.Token))
        {
            errors["token"] = ["Give the enrollment token from the node's page."];
        }

        byte[]? csr = null;
        if (string.IsNullOrWhiteSpace(request.Csr))
        {
            errors["csr"] = ["Give a certificate request."];
        }
        else if (request.Csr.Length > MaxCsrBytes * 2 || !TryBase64(request.Csr, out csr))
        {
            errors["csr"] = ["The certificate request must be base64 DER, 8 KB at most."];
        }

        if (errors.Count > 0 || csr is null)
        {
            return ApiProblems.Invalid(errors);
        }

        var now = time.GetUtcNow();
        var hash = NodeTokens.Hash(request.Token!.Trim());
        var node = await db.MonitoringNodes.SingleOrDefaultAsync(n => n.EnrollmentTokenHash == hash);
        if (node is null || node.Status == NodeStatuses.Revoked || node.EnrollmentTokenExpiresAt is not { } expires || expires <= now)
        {
            return ApiProblems.Of(ProblemTypes.Unauthorized, "This enrollment token is not good, was used already or has run out. Make a new one on the node's page.");
        }

        IssuedCertificate issued;
        try
        {
            issued = await authority.IssueAsync(node.Id, csr, null);
        }
        catch (CertificateRequestException e)
        {
            return ApiProblems.Invalid("csr", e.Message);
        }

        // A node that enrolls again (it lost its data) gives up the certificates it had.
        var older = await db.NodeCertificates.Where(c => c.NodeId == node.Id && c.RevokedAt == null).ToListAsync();
        foreach (var certificate in older)
        {
            certificate.RevokedAt = now;
        }

        node.EnrollmentTokenHash = null;
        node.EnrollmentTokenExpiresAt = null;
        node.EnrolledAt = now;
        if (node.Status == NodeStatuses.Pending)
        {
            node.Status = NodeStatuses.Offline;
        }

        await db.SaveChangesAsync();
        if (older.Count > 0)
        {
            await bus.RevokedAsync(node.Id, older.Select(c => c.Serial).ToList());
        }

        return TypedResults.Created(
            (string?)null,
            new NodeEnrollmentDto(
                node.Id,
                Convert.ToBase64String(issued.Certificate),
                [Convert.ToBase64String(issued.CaCertificate)],
                options.Value.GatewayAddress!,
                issued.NotAfter));
    }

    private static void Apply(JsonObject body, MonitoringNodeWriteRequest request, MonitoringNode node, Dictionary<string, string[]> errors)
    {
        if (body.ContainsKey("name"))
        {
            var name = request.Name?.Trim() ?? "";
            if (name.Length is < 1 or > 60)
            {
                errors["name"] = ["Give a name of 1 to 60 characters."];
            }
            else
            {
                node.Name = name;
            }
        }

        if (body.ContainsKey("region"))
        {
            var region = request.Region?.Trim() ?? "";
            if (!RegionPattern().IsMatch(region))
            {
                errors["region"] = ["Give 2 to 32 lower-case letters, digits and dashes, such as eu-central."];
            }
            else
            {
                node.Region = region;
            }
        }

        if (body.ContainsKey("capacity"))
        {
            if (request.Capacity is not (>= 1 and <= MaxCapacity) || request.Capacity is null)
            {
                errors["capacity"] = [$"Give a whole number from 1 to {MaxCapacity}. A normal node is 100."];
            }
            else
            {
                node.Capacity = request.Capacity.Value;
            }
        }

        if (body.ContainsKey("allowedAddresses"))
        {
            var list = request.AllowedAddresses ?? [];
            var normal = new List<string>();
            foreach (var entry in list)
            {
                if (NormalNetwork(entry) is { } network)
                {
                    normal.Add(network);
                }
                else
                {
                    errors["allowedAddresses"] = [$"'{entry}' is not an IP address or a CIDR range such as 203.0.113.0/24."];
                    break;
                }
            }

            if (normal.Count > MaxAllowedAddresses)
            {
                errors["allowedAddresses"] = [$"Give {MaxAllowedAddresses} addresses at most."];
            }
            else if (!errors.ContainsKey("allowedAddresses"))
            {
                node.AllowedAddresses = [.. normal.Distinct(StringComparer.Ordinal)];
            }
        }

        if (body.ContainsKey("draining"))
        {
            if (request.Draining is null)
            {
                errors["draining"] = ["Give true or false."];
            }
            else
            {
                node.Draining = request.Draining.Value;
            }
        }
    }

    /// <summary>An address becomes its /32 or /128; a range is kept as written once it parses.</summary>
    private static string? NormalNetwork(string? entry)
    {
        var text = entry?.Trim() ?? "";
        if (IPAddress.TryParse(text, out var address) && !text.Contains('/', StringComparison.Ordinal))
        {
            return new IPNetwork(address, address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork ? 32 : 128).ToString();
        }

        return IPNetwork.TryParse(text, out var network) ? network.ToString() : null;
    }

    private static bool TryBase64(string text, out byte[]? bytes)
    {
        bytes = new byte[text.Length];
        if (Convert.TryFromBase64String(text.Trim(), bytes, out var written))
        {
            bytes = bytes[..written];
            return written > 0;
        }

        bytes = null;
        return false;
    }

    private static string ApiUrl(HttpContext http, MonitoringOptions options) =>
        string.IsNullOrWhiteSpace(options.PublicApiUrl) ? $"{http.Request.Scheme}://{http.Request.Host}" : options.PublicApiUrl.TrimEnd('/');

    private static async Task<Dictionary<long, DateTimeOffset>> CertificateExpiryAsync(AppDbContext db, List<long> ids) =>
        await db.NodeCertificates.AsNoTracking()
            .Where(c => ids.Contains(c.NodeId) && c.RevokedAt == null)
            .GroupBy(c => c.NodeId)
            .Select(g => new { g.Key, NotAfter = g.Max(c => c.NotAfter) })
            .ToDictionaryAsync(x => x.Key, x => x.NotAfter);

    private static async Task<MonitoringNodeDto> DtoAsync(AppDbContext db, MonitoringNode node, TimeProvider time, MonitoringOptions options)
    {
        var expiry = await CertificateExpiryAsync(db, [node.Id]);
        return ToDto(node, time.GetUtcNow(), options, expiry.TryGetValue(node.Id, out var at) ? at : null);
    }

    /// <summary>An online node whose heartbeats stopped shows as offline before the liveness job writes it.</summary>
    internal static MonitoringNodeDto ToDto(MonitoringNode node, DateTimeOffset now, MonitoringOptions options, DateTimeOffset? certificateExpires)
    {
        var status = node.Status == NodeStatuses.Online && (node.LastSeenAt is null || now - node.LastSeenAt.Value > options.OfflineAfter)
            ? NodeStatuses.Offline
            : node.Status;
        return new MonitoringNodeDto(
            node.Id, node.Name, node.Region, node.Capacity, status, node.Draining, node.SoftwareVersion, node.RemoteAddress,
            node.EnrolledAt, node.ConnectedAt, node.LastSeenAt, node.Monitors, node.ChecksLastMinute, node.QueuedResults, node.LagMs,
            node.AllowedAddresses, node.EnrollmentTokenHash is null ? null : node.EnrollmentTokenExpiresAt, certificateExpires,
            node.CreatedAt, node.RevokedAt, node.Version.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }

    private static ProblemHttpResult NotFound() => ApiProblems.Of(ProblemTypes.NotFound, "There is no such monitoring node.");

    [GeneratedRegex("^[a-z][a-z0-9-]{1,31}$")]
    private static partial Regex RegionPattern();
}
