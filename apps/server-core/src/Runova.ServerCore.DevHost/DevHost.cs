using System.Net;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Files;
using Runova.ServerCore.Nginx;
using Runova.ServerCore.Security;
using Runova.ServerCore.Traffic;

namespace Runova.ServerCore.DevHost;

/// <summary>
/// Starts the core on 127.0.0.1 (port 7810 unless RUNOVA_DEV_CORE_PORT says otherwise) with a
/// throwaway data folder. Only development builds of the desktop app connect to it, and only when
/// RUNOVA_DEPLOY_DEV_CORE names it.
/// </summary>
/// <remarks>
/// A real server gets its owner and device from `admin` commands run over SSH. The DevHost has no
/// SSH, so it has a fixed development owner and a loopback-only endpoint that enrolls a device for
/// it. The machine it reports on is pretend (Fakes/): metrics that move, a few updates waiting,
/// Docker and nginx running, and a reboot that drops every connection for a few seconds. This
/// project is never published, so none of that can reach a real server.
/// </remarks>
internal static class DevHost
{
    public const int DefaultPort = 7810;

    public const string DevUserName = "dev";

    public const string DevPassword = "runova-local-password";

    /// <summary>The pretend private registry (E08): its images pull only with this user and token.</summary>
    public const string DevRegistry = "registry.runova.test";

    public const string DevRegistryUser = "devhost";

    public const string DevRegistryToken = "devhost-registry-token-4417";

    private static readonly SemaphoreSlim _ownerGate = new(1, 1);

    public static async Task<int> RunAsync(string[] args)
    {
        var port = int.TryParse(Environment.GetEnvironmentVariable("RUNOVA_DEV_CORE_PORT"), out var chosen)
            ? chosen
            : DefaultPort;
        var data = Path.Combine(Path.GetTempPath(), "runova-core-devhost");
        var runtime = Path.Combine(Path.GetTempPath(), "runova-core-devhost-runtime");

        await using var app = CoreApplication.Build(
            [
                $"--Core:Listen:TcpPort={port}",
                $"--Core:DataDirectory={data}",
                $"--Core:RuntimeDirectory={runtime}",
                // No tmpfs on a developer's machine; a real server never sets this (E08).
                "--Core:RegistryAuthOnDisk=allow",
                // Direct TLS (E16) can be tried on the DevHost, on loopback only.
                "--Core:DirectTls:LoopbackOnly=true",
                "--environment",
                "Development",
                .. args,
            ],
            Fakes.FakePlatform.Add);
        app.MapPost("/dev/enroll", EnrollAsync).AllowAnonymous();
        app.MapPost("/dev/files/seed", SeedFile).AllowAnonymous();
        app.MapPost("/dev/containers/crash", Crash).AllowAnonymous();
        app.MapPost("/dev/sites/traffic", SeedTrafficAsync).AllowAnonymous();
        app.MapPost("/dev/sites/attack", SeedAttackAsync).AllowAnonymous();
        await app.StartAsync();
        await EnsureDevOwnerAsync(app.Services);
        await app.WaitForShutdownAsync();
        return 0;
    }

    /// <summary>
    /// Made right after the start, and by an enrollment that comes first: the health endpoint
    /// answers as soon as the server listens, so a test may enroll before the start is done.
    /// </summary>
    private static async Task EnsureDevOwnerAsync(IServiceProvider services)
    {
        await _ownerGate.WaitAsync();
        try
        {
            await CreateDevOwnerAsync(services);
        }
        finally
        {
            _ownerGate.Release();
        }
    }

    private static async Task CreateDevOwnerAsync(IServiceProvider services)
    {
        await using var scope = services.CreateAsyncScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<CoreUser>>();
        if (await users.FindByNameAsync(DevUserName) is not null)
        {
            return;
        }

        var owner = new CoreUser { UserName = DevUserName };
        var created = await users.CreateAsync(owner, DevPassword);
        var result = created.Succeeded ? await users.AddToRoleAsync(owner, CoreRoles.Owner) : created;
        if (!result.Succeeded)
        {
            throw new InvalidOperationException(
                $"The DevHost could not create its development owner: {string.Join(" ", result.Errors.Select(e => e.Description))}");
        }
    }

    private static async Task<IResult> EnrollAsync(DevEnrollRequest request, HttpContext http, CoreDbContext db, UserManager<CoreUser> users)
    {
        if (http.Connection.RemoteIpAddress is not { } remote || !IPAddress.IsLoopback(remote))
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }

        var publicKey = DeviceKeys.ParsePublicKey(request.PublicKey);
        await EnsureDevOwnerAsync(http.RequestServices);
        var owner = await users.FindByNameAsync(DevUserName);
        if (publicKey is null || owner is null)
        {
            return Results.BadRequest();
        }

        var device = new Device
        {
            Id = Guid.NewGuid(),
            UserId = owner.Id,
            Name = string.IsNullOrWhiteSpace(request.DeviceName) ? "Development" : request.DeviceName.Trim()[..Math.Min(100, request.DeviceName.Trim().Length)],
            PublicKey = publicKey,
            CreatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };
        db.Devices.Add(device);
        await db.SaveChangesAsync();
        return Results.Ok(new DevEnrollResponse(device.Id, DevUserName));
    }

    /// <summary>
    /// Puts a file, folder or link into a pretend container's or volume's files (E27), folders on
    /// the way made as needed, so the app's integration tests can set up what they browse.
    /// Loopback only, like enrolling.
    /// </summary>
    private static IResult SeedFile(DevFileSeedRequest request, HttpContext http, InMemoryDockerEngine engine)
    {
        if (http.Connection.RemoteIpAddress is not { } remote || !IPAddress.IsLoopback(remote))
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }

        var kind = request.Kind switch
        {
            "container" => FileTargetKind.Container,
            "volume" => FileTargetKind.Volume,
            _ => (FileTargetKind?)null,
        };
        var type = request.Type switch
        {
            "dir" => 'd',
            "file" => 'f',
            "link" => 'l',
            _ => '-',
        };
        if (kind is null || type == '-' || (type == 'l' && string.IsNullOrEmpty(request.LinkTarget)) || !FilePaths.TryNormalize(request.Path, out _))
        {
            return Results.BadRequest();
        }

        byte[]? content;
        try
        {
            content = request.ContentBase64 is { } encoded ? Convert.FromBase64String(encoded) : null;
        }
        catch (FormatException)
        {
            return Results.BadRequest();
        }

        try
        {
            engine.PlantEntry(kind.Value, request.Id, request.Path, type, request.Mode, content, request.MtimeUnixMs, request.LinkTarget);
        }
        catch (DockerNotFoundException)
        {
            return Results.NotFound();
        }
        catch (MemoryFsException)
        {
            return Results.Conflict();
        }

        return Results.NoContent();
    }

    /// <summary>
    /// One pretend container exits on its own and is started again (E30), so the app's e2e run can
    /// make a crash loop the core's container watcher sees. Loopback only, like enrolling.
    /// </summary>
    private static IResult Crash(DevCrashRequest request, HttpContext http, InMemoryDockerEngine engine)
    {
        if (http.Connection.RemoteIpAddress is not { } remote || !IPAddress.IsLoopback(remote))
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }

        try
        {
            engine.SimulateCrash(request.Container, request.ExitCode);
        }
        catch (DockerNotFoundException)
        {
            return Results.NotFound();
        }

        return Results.NoContent();
    }

    /// <summary>
    /// Appends synthetic visits (E109) to a pretend site's access log, then has the tailer read and
    /// write them at once, so the app's end-to-end tests see them in the report without waiting a
    /// minute. Statistics must be on (the lines come after the point they started from). Loopback only.
    /// </summary>
    private static async Task<IResult> SeedTrafficAsync(DevTrafficRequest request, HttpContext http, CoreDbContext db, SimulatedNginxMachine machine, TrafficTailer tailer)
    {
        if (http.Connection.RemoteIpAddress is not { } remote || !IPAddress.IsLoopback(remote))
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }

        if (request.Count is < 1 or > 200_000 || request.DaysBack is < 0 or > 400 || string.IsNullOrEmpty(request.SiteId))
        {
            return Results.BadRequest();
        }

        if (!await db.Sites.AnyAsync(s => s.Id == request.SiteId, http.RequestAborted))
        {
            return Results.NotFound();
        }

        var lines = Fakes.FakeTraffic.Visits(request.Count, request.DaysBack, request.Seed, DateTimeOffset.UtcNow);
        machine.AppendText(NginxLayout.Debian.AccessLog(request.SiteId), string.Concat(lines));
        await DrainAsync(tailer, lines.Sum(line => (long)line.Length), http.RequestAborted);
        return Results.Ok(new DevTrafficResponse(lines.Count));
    }

    /// <summary>
    /// Appends a burst from one address that trips one attack detector (E110), now, and has the tailer
    /// read it at once, so the alert opens straight away. Detection must be on. Loopback only.
    /// </summary>
    private static async Task<IResult> SeedAttackAsync(DevAttackRequest request, HttpContext http, CoreDbContext db, SimulatedNginxMachine machine, TrafficTailer tailer, TrafficManager manager)
    {
        if (http.Connection.RemoteIpAddress is not { } remote || !IPAddress.IsLoopback(remote))
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }

        var address = string.IsNullOrWhiteSpace(request.Address) ? DevAttackAddress : request.Address.Trim();
        if (!Enum.TryParse<AttackKind>(request.Kind, ignoreCase: true, out var kind) || !Enum.IsDefined(kind)
            || !IpKey.TryParse(address, out _) || string.IsNullOrEmpty(request.SiteId))
        {
            return Results.BadRequest();
        }

        if (!await db.Sites.AnyAsync(s => s.Id == request.SiteId, http.RequestAborted))
        {
            return Results.NotFound();
        }

        await manager.EnsureLoadedAsync(http.RequestAborted);
        var lines = Fakes.FakeTraffic.Attack(kind, address, manager.Current.Attacks.Thresholds, DateTimeOffset.UtcNow);
        machine.AppendText(NginxLayout.Debian.AccessLog(request.SiteId), string.Concat(lines));
        await DrainAsync(tailer, lines.Sum(line => (long)line.Length), http.RequestAborted);
        return Results.Ok(new DevTrafficResponse(lines.Count));
    }

    /// <summary>Enough ticks for the tailer to read what was just written under its budget, then a flush.</summary>
    private static async Task DrainAsync(TrafficTailer tailer, long bytes, CancellationToken cancellationToken)
    {
        for (var tick = 0; tick <= (bytes / TrafficOptions.DefaultTickBudget) + 1; tick++)
        {
            await tailer.TickAsync(cancellationToken);
        }

        await tailer.FlushAsync(cancellationToken);
    }

    /// <summary>The address attack bursts come from unless asked otherwise: a documentation address, not the app's own.</summary>
    public const string DevAttackAddress = "198.51.100.23";

    internal sealed record DevEnrollRequest(string PublicKey, string? DeviceName);

    /// <param name="DaysBack">Spread over this many days before now; 0 for the last hour.</param>
    /// <param name="Seed">The same seed gives the same lines.</param>
    internal sealed record DevTrafficRequest(string SiteId, int Count = 500, int DaysBack = 7, int Seed = 1);

    /// <param name="Kind">"scan", "bruteForce", "flood" or "injection".</param>
    /// <param name="Address">Where the burst comes from; 198.51.100.23 unless given.</param>
    internal sealed record DevAttackRequest(string SiteId, string Kind, string? Address = null);

    internal sealed record DevTrafficResponse(int Lines);

    internal sealed record DevCrashRequest(string Container, int ExitCode = 1);

    /// <param name="Kind">"container" or "volume".</param>
    /// <param name="Type">"dir", "file" or "link".</param>
    /// <param name="Mode">Permission bits (0644 is 420).</param>
    internal sealed record DevFileSeedRequest(
        string Kind,
        string Id,
        string Path,
        string Type,
        int? Mode = null,
        string? ContentBase64 = null,
        long? MtimeUnixMs = null,
        string? LinkTarget = null);

    internal sealed record DevEnrollResponse(Guid DeviceId, string UserName);
}
