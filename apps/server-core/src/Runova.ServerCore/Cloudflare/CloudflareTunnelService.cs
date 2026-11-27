using System.Net;
using System.Net.Sockets;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Alerts;
using Runova.ServerCore.Compatibility;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.DirectTls;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Firewall;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Nginx;
using Runova.ServerCore.Updates;
using Runova.ServerCore.Web;

namespace Runova.ServerCore.Cloudflare;

/// <param name="PollInterval">How often the core asks cloudflared how it is and settles confirmed changes.</param>
/// <param name="DownAlertAfter">How long the tunnel may be down before an alert goes out.</param>
/// <param name="HealthyBeforeClose">How long the tunnel must be back before break-glass closes SSH again.</param>
/// <param name="ReadyWait">How long the setup job waits for cloudflared's first connection.</param>
internal sealed record CloudflareTunnelOptions(
    TimeSpan PollInterval,
    TimeSpan DownAlertAfter,
    TimeSpan HealthyBeforeClose,
    TimeSpan ReadyWait,
    bool RunInBackground = true)
{
    public static CloudflareTunnelOptions Default { get; } =
        new(TimeSpan.FromSeconds(30), TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(3));
}

/// <summary>
/// The Cloudflare Tunnel (E95). The app makes the tunnel at Cloudflare with its account token and
/// hands the core only the tunnel's own token, which the core seals and writes for cloudflared
/// alone. Turning it on takes three steps, each one the person sees: a job installs cloudflared,
/// starts the tunnel and waits for its first connection (nothing in the firewall changes yet, so a
/// failure costs nothing); then a firewall change set closes the web ports, confirmed like any
/// other; then, if the person wants, a second one limits SSH, applied over the way in that will
/// remain so the lockout guard checks exactly that. Turning it off is a change set that opens
/// what the tunnel closed; cloudflared stops only once that is confirmed. The tunnel and the
/// origin lock are never on together. In the background the core watches cloudflared, raises an
/// alert when the tunnel is down, and (only when a person turned it on) opens SSH by itself after
/// the delay they chose.
/// </summary>
internal sealed partial class CloudflareTunnelService(
    IDbContextFactory<CoreDbContext> contexts,
    ICloudflared cloudflared,
    ICloudflaredHealth health,
    ICloudflareMesh mesh,
    FirewallManager firewall,
    IFirewallBackendSource backends,
    ISshdSettings sshd,
    DirectTlsManager directTls,
    WebSites sites,
    CoreDomain.CoreDomainStore coreDomain,
    JobEngine jobs,
    IDataProtectionProvider protection,
    AlertCenter alerts,
    CloudflareTunnelOptions options,
    TimeProvider time,
    ILogger<CloudflareTunnelService> logger) : BackgroundService
{
    public const string AlertResource = "cloudflare-tunnel";

    public const string WatchdogRequester = "the Cloudflare Tunnel's break-glass";

    private const string TunnelLock = "cloudflare-tunnel";

    private const string KindWeb = "web";

    private const string KindSsh = "ssh";

    private const string KindOff = "off";

    private static readonly int[] _webPorts = [80, 443];

    private readonly SemaphoreSlim _gate = new(1, 1);

    private readonly IDataProtector _protector = protection.CreateProtector(FrozenIdentifiers.CloudflareTunnelTokenPurpose);

    private long? _healthySince;

    private long Now => time.GetUtcNow().ToUnixTimeMilliseconds();

    public override void Dispose()
    {
        _gate.Dispose();
        base.Dispose();
    }

    public async Task<CloudflareTunnelStatus> StatusAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await SettleLockedAsync(cancellationToken);
            return await DescribeAsync(cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Saves the tunnel's token and starts the job that installs cloudflared and connects it.</summary>
    public async Task<JobInfo> StartAsync(CloudflareTunnelSetup? request, Requester who, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (!Guid.TryParse(request.TunnelId, out var tunnelId))
        {
            throw new CloudflareTunnelException("The tunnel id is not one Cloudflare gives out. Set the tunnel up again from the app.");
        }

        var token = TunnelToken.Parse(request.Token, tunnelId);
        var name = (request.TunnelName ?? string.Empty).Trim();
        if (name.Length is 0 or > 200 || name.Any(char.IsControl))
        {
            throw new CloudflareTunnelException("The tunnel needs a name of up to 200 characters.");
        }

        var sshHostname = string.IsNullOrWhiteSpace(request.SshHostname) ? null : request.SshHostname.Trim().ToLowerInvariant();
        if (sshHostname is not null && (NginxNames.DomainProblem(sshHostname) is not null || sshHostname.StartsWith("*.", StringComparison.Ordinal)))
        {
            throw new CloudflareTunnelException($"{sshHostname} is not a host name SSH can be routed to.");
        }

        await _gate.WaitAsync(cancellationToken);
        try
        {
            var (inspection, _) = await sites.InspectAsync(cancellationToken);
            if (!inspection.Installed || !inspection.Running)
            {
                throw new CloudflareTunnelException("The tunnel hands every request to nginx, and nginx is not running here. Install or start it under Websites first.");
            }

            if (!inspection.Managed)
            {
                throw new CloudflareTunnelException("The tunnel hands every request to nginx, and nginx is not set up for Runova on this server yet. Set it up under Websites first.");
            }

            RefuseDirectCoreDomain();
            await SettleLockedAsync(cancellationToken);
            if (await OriginLockedAsync(cancellationToken))
            {
                // The lock's rules go with the web ports' when they close; until then both may stand.
                LogLockStillOn(logger);
            }

            var row = await LoadAsync(cancellationToken);
            if (row?.ChangeKind is not null)
            {
                throw new CloudflareTunnelException("A firewall change of the tunnel's waits for its confirmation. Keep or revert it first.");
            }

            var sealedToken = _protector.Protect(request.Token);
            await SaveAsync(
                saved =>
                {
                    saved.Enabled = true;
                    saved.TunnelId = tunnelId;
                    saved.TunnelName = name;
                    saved.AccountTag = token.AccountTag;
                    saved.SshHostname = sshHostname;
                    saved.ProtectedToken = sealedToken;
                    saved.TunnelPort = saved.TunnelPort > 0 ? saved.TunnelPort : FreeLoopbackPort();
                    saved.MetricsPort = saved.MetricsPort > 0 ? saved.MetricsPort : FreeLoopbackPort();
                    saved.LastError = null;
                },
                cancellationToken);
        }
        finally
        {
            _gate.Release();
        }

        var job = await jobs.StartAsync(
            new JobRequest(JobKind.CloudflareTunnelSetup, "Set up the Cloudflare Tunnel", [SystemJobs.PackagesLock, TunnelLock], name, who.UserId, who.UserName),
            (context, token) => SetupAsync(context, who, token),
            cancellationToken);
        await SaveAsync(saved => saved.SetupJobId = job.Id, CancellationToken.None);
        return job;
    }

    /// <summary>Makes the server a Cloudflare Mesh node, so SSH can be limited to Mesh; the tunnel has to be on.</summary>
    public async Task<JobInfo> JoinMeshAsync(CloudflareMeshJoin? request, Requester who, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (!Guid.TryParse(request.NodeId, out var nodeId))
        {
            throw new CloudflareTunnelException("The Mesh node id is not one Cloudflare gives out. Add the server to Mesh again from the app.");
        }

        TunnelToken.Parse(request.Token, nodeId);
        if ((await LoadAsync(cancellationToken)) is not { Enabled: true })
        {
            throw new CloudflareTunnelException("Set the tunnel up first; Mesh only limits SSH while the tunnel is on.");
        }

        var token = request.Token;
        return await jobs.StartAsync(
            new JobRequest(JobKind.CloudflareMeshSetup, "Add this server to Cloudflare Mesh", [SystemJobs.PackagesLock, TunnelLock], "mesh", who.UserId, who.UserName),
            async (job, cancel) =>
            {
                var address = await mesh.JoinAsync(token, job, cancel);
                await SaveAsync(saved => saved.MeshAddress = address, CancellationToken.None);
            },
            cancellationToken);
    }

    public Task<CloudflareTunnelPreview> PreviewWebAsync(CloudflareTunnelFirewallRequest? request, FirewallCaller caller, CancellationToken cancellationToken) =>
        PreviewAsync(request?.SshConnection, caller, async state => TunnelFirewallPlanner.PlanWeb(state, await WebPortsAsync(cancellationToken)), cancellationToken);

    /// <summary>Closes the web ports to everyone; refused until the tunnel is connected, or the sites would go dark.</summary>
    public async Task<CloudflareTunnelResult> CloseWebAsync(CloudflareTunnelFirewallRequest? request, FirewallCaller caller, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await RequireConnectedAsync(cancellationToken);
            var plan = TunnelFirewallPlanner.PlanWeb(await ReadFirewallAsync(cancellationToken), await WebPortsAsync(cancellationToken));
            if (plan.Changes.Count == 0)
            {
                await SaveAsync(saved => saved.WebClosed = true, CancellationToken.None);
                await DisableOriginLockAsync(CancellationToken.None);
                return new CloudflareTunnelResult(await DescribeAsync(CancellationToken.None), null, await sites.ApplyAsync(null, CancellationToken.None));
            }

            var change = await firewall.ApplyAsync(new FirewallChangeRequest([.. plan.Changes], request.SshConnection, request.OverrideConfirmation), caller, cancellationToken);
            await SaveAsync(saved => (saved.ChangeSetId, saved.ChangeKind) = (change.Id, KindWeb), CancellationToken.None);
            return new CloudflareTunnelResult(await DescribeAsync(CancellationToken.None), change);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<CloudflareTunnelPreview> PreviewSshAsync(TunnelSshRequest? request, FirewallCaller caller, bool overCoreDomain, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var row = await LoadAsync(cancellationToken);
        CheckSshMode(row, request.Mode, overCoreDomain);
        return await PreviewAsync(request.SshConnection, caller, async state => TunnelFirewallPlanner.PlanSsh(state, request.Mode, await SshPortsAsync(cancellationToken)), cancellationToken);
    }

    /// <summary>
    /// Who may open SSH while the tunnel is on. The change goes through the lockout guard like any
    /// other, so it has to come over the way in that remains: SSH through the tunnel for
    /// Cloudflare, SSH over Cloudflare Mesh for Mesh, the core domain for Closed (where no SSH
    /// remains, so the guard asks for its phrase and a step-up).
    /// </summary>
    public async Task<CloudflareTunnelResult> ApplySshAsync(TunnelSshRequest? request, FirewallCaller caller, bool overCoreDomain, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var row = await RequireConnectedAsync(cancellationToken);
            if (!row.WebClosed)
            {
                throw new CloudflareTunnelException("Close the web ports first; SSH comes after that.");
            }

            CheckSshMode(row, request.Mode, overCoreDomain);
            var plan = TunnelFirewallPlanner.PlanSsh(await ReadFirewallAsync(cancellationToken), request.Mode, await SshPortsAsync(cancellationToken));
            if (plan.Changes.Count == 0)
            {
                await SaveAsync(saved => saved.SshMode = request.Mode, CancellationToken.None);
                return new CloudflareTunnelResult(await DescribeAsync(CancellationToken.None));
            }

            var change = await firewall.ApplyAsync(new FirewallChangeRequest([.. plan.Changes], request.SshConnection, request.OverrideConfirmation), caller, cancellationToken);
            await SaveAsync(saved => (saved.ChangeSetId, saved.ChangeKind, saved.PendingSshMode) = (change.Id, KindSsh, request.Mode), CancellationToken.None);
            return new CloudflareTunnelResult(await DescribeAsync(CancellationToken.None), change);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<CloudflareTunnelPreview> PreviewOffAsync(CloudflareTunnelOffRequest? request, FirewallCaller caller, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var row = await LoadAsync(cancellationToken);
        return await PreviewAsync(request.SshConnection, caller, async state => await OffPlanAsync(state, row, request.ReopenWeb, cancellationToken), cancellationToken);
    }

    /// <summary>Opens what the tunnel closed; cloudflared stops once that is confirmed (at once when nothing needs opening).</summary>
    public async Task<CloudflareTunnelResult> TurnOffAsync(CloudflareTunnelOffRequest? request, FirewallCaller caller, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await SettleLockedAsync(cancellationToken);
            var row = await LoadAsync(cancellationToken);
            if (row is not { Enabled: true })
            {
                throw new CloudflareTunnelException("The tunnel is already off.");
            }

            if (row.ChangeKind is not null)
            {
                throw new CloudflareTunnelException("A firewall change of the tunnel's waits for its confirmation. Keep or revert it first.");
            }

            var plan = await OffPlanAsync(await ReadFirewallAsync(cancellationToken), row, request.ReopenWeb, cancellationToken);
            if (plan.Changes.Count == 0)
            {
                var nginx = await StopLockedAsync(CancellationToken.None);
                return new CloudflareTunnelResult(await DescribeAsync(CancellationToken.None), null, nginx);
            }

            var change = await firewall.ApplyAsync(new FirewallChangeRequest([.. plan.Changes], request.SshConnection, request.OverrideConfirmation), caller, cancellationToken);
            await SaveAsync(
                saved => (saved.ChangeSetId, saved.ChangeKind, saved.OffForOriginLock) = (change.Id, KindOff, !request.ReopenWeb),
                CancellationToken.None);
            return new CloudflareTunnelResult(await DescribeAsync(CancellationToken.None), change);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<CloudflareTunnelStatus> SetBreakGlassAsync(TunnelBreakGlassRequest? request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.DelayMinutes is < 5 or > 1440)
        {
            throw new CloudflareTunnelException("Choose a delay from 5 minutes to 24 hours.");
        }

        await _gate.WaitAsync(cancellationToken);
        try
        {
            await SaveAsync(saved => (saved.BreakGlassEnabled, saved.BreakGlassDelayMinutes) = (request.Enabled, request.DelayMinutes), cancellationToken);
            return await DescribeAsync(cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>One look: settles confirmed or rolled-back changes, then watches the tunnel's health.</summary>
    public async Task TickAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await SettleLockedAsync(cancellationToken);
            await WatchLockedAsync(cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.RunInBackground)
        {
            return;
        }

        using var ticks = new PeriodicTimer(options.PollInterval, time);
        while (await ticks.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                await TickAsync(stoppingToken);
            }
            catch (Exception failure) when (failure is not OperationCanceledException and not OutOfMemoryException)
            {
                LogTickFailed(logger, failure);
            }
        }
    }

    private async Task SetupAsync(JobContext job, Requester who, CancellationToken cancellationToken)
    {
        try
        {
            await cloudflared.InstallAsync(job, cancellationToken);
            var row = await LoadAsync(cancellationToken) ?? throw new JobFailedException("The tunnel's settings are gone. Set it up again from the app.");
            job.Log("Writing the tunnel's token for cloudflared (root only) and starting the tunnel.");
            await cloudflared.StartAsync(_protector.Unprotect(row.ProtectedToken!), row.MetricsPort, cancellationToken);
            job.Log("Adding the tunnel's listener to nginx.");
            var nginx = await sites.ApplyAsync(who, cancellationToken);
            if (!nginx.Applied)
            {
                throw new JobFailedException($"nginx did not take the tunnel's listener: {nginx.Error ?? string.Join(" ", nginx.Problems.Select(problem => problem.Message))}");
            }

            job.Log("Waiting for the tunnel's first connection to Cloudflare.");
            var deadline = time.GetUtcNow() + options.ReadyWait;
            TunnelHealth state;
            while (!(state = await health.ReadAsync(row.MetricsPort, cancellationToken)).Ready)
            {
                if (time.GetUtcNow() >= deadline)
                {
                    throw new JobFailedException(
                        $"cloudflared started, but it did not connect to Cloudflare within {options.ReadyWait.TotalSeconds:0} seconds. The server may not reach Cloudflare on port 7844, or the tunnel was deleted. Nothing in the firewall changed.");
                }

                await Task.Delay(TimeSpan.FromSeconds(2), time, cancellationToken);
            }

            await SaveAsync(saved => (saved.LastConnectedAt, saved.DownSince, saved.LastError) = (Now, null, null), CancellationToken.None);
            job.Log($"The tunnel is connected ({state.Connections} connections to Cloudflare). Next, close the web ports from the app.");
            job.ExitCode = 0;
        }
        catch (Exception failure) when (failure is JobFailedException or CloudflareTunnelException or ProcessStartException or IOException or System.Security.Cryptography.CryptographicException)
        {
            var message = failure.Message.Length > 1000 ? failure.Message[..999] + "…" : failure.Message;
            await SaveAsync(saved => saved.LastError = message, CancellationToken.None);
            throw failure as JobFailedException ?? new JobFailedException(message);
        }
    }

    /// <summary>What a confirmed or rolled-back change of the tunnel's means for its settings.</summary>
    private async Task SettleLockedAsync(CancellationToken cancellationToken)
    {
        var row = await LoadAsync(cancellationToken);
        if (row is not { ChangeSetId: { } changeSetId, ChangeKind: { } kind })
        {
            return;
        }

        var state = await ChangeStateAsync(changeSetId, cancellationToken);
        if (state is FirewallChangeState.Applying or FirewallChangeState.AwaitingConfirmation)
        {
            return;
        }

        if (state != FirewallChangeState.Confirmed)
        {
            await SaveAsync(saved => (saved.ChangeKind, saved.PendingSshMode, saved.OffForOriginLock) = (null, null, false), CancellationToken.None);
            return;
        }

        switch (kind)
        {
            case KindWeb:
                await SaveAsync(saved => (saved.WebClosed, saved.ChangeKind) = (true, null), CancellationToken.None);
                await DisableOriginLockAsync(CancellationToken.None);
                await sites.ApplyAsync(null, CancellationToken.None);
                break;
            case KindSsh:
                await SaveAsync(saved => (saved.SshMode, saved.PendingSshMode, saved.ChangeKind) = (saved.PendingSshMode ?? saved.SshMode, null, null), CancellationToken.None);
                break;
            default:
                await StopLockedAsync(CancellationToken.None);
                break;
        }
    }

    /// <summary>Health, the down alert and break-glass; only for a tunnel that was connected once.</summary>
    private async Task WatchLockedAsync(CancellationToken cancellationToken)
    {
        var row = await LoadAsync(cancellationToken);
        if (row is not { Enabled: true, LastConnectedAt: not null } || row.MetricsPort == 0)
        {
            _healthySince = null;
            return;
        }

        var now = Now;
        var state = await health.ReadAsync(row.MetricsPort, cancellationToken);
        if (state.Ready)
        {
            _healthySince ??= now;
            await SaveAsync(saved => (saved.LastConnectedAt, saved.DownSince) = (now, null), cancellationToken);
            await alerts.ResolveAsync(AlertKind.CloudflareTunnelDown, AlertResource, cancellationToken);
            if (row.BreakGlassOpen && now - _healthySince.Value >= (long)options.HealthyBeforeClose.TotalMilliseconds)
            {
                await BreakGlassAsync(open: false, cancellationToken);
            }

            return;
        }

        _healthySince = null;
        var downSince = row.DownSince ?? now;
        if (row.DownSince is null)
        {
            await SaveAsync(saved => saved.DownSince = now, cancellationToken);
        }

        var down = TimeSpan.FromMilliseconds(now - downSince);
        if (down >= options.DownAlertAfter)
        {
            await alerts.RaiseAsync(
                AlertKind.CloudflareTunnelDown,
                AlertResource,
                AlertSeverity.Critical,
                $"The Cloudflare Tunnel has been down for {Minutes(down)}: the sites and the core domain do not answer. cloudflared restarts by itself; check that the server reaches Cloudflare on port 7844.",
                cancellationToken);
        }

        if (row is { BreakGlassEnabled: true, BreakGlassOpen: false } && row.SshMode != TunnelSshMode.Open
            && down >= TimeSpan.FromMinutes(row.BreakGlassDelayMinutes))
        {
            await BreakGlassAsync(open: true, cancellationToken);
        }
    }

    private async Task BreakGlassAsync(bool open, CancellationToken cancellationToken)
    {
        try
        {
            await firewall.ApplyBreakGlassAsync(open, WatchdogRequester, cancellationToken);
            await SaveAsync(saved => saved.BreakGlassOpen = open, CancellationToken.None);
            if (open)
            {
                LogBreakGlassOpened(logger);
                await alerts.RaiseAsync(
                    AlertKind.TunnelBreakGlassOpened,
                    AlertResource,
                    AlertSeverity.Critical,
                    "The Cloudflare Tunnel stayed down, so the core opened SSH to everyone as you asked. It closes SSH again once the tunnel has been back for a few minutes.",
                    CancellationToken.None);
            }
            else
            {
                await alerts.ResolveAsync(AlertKind.TunnelBreakGlassOpened, AlertResource, CancellationToken.None);
            }
        }
        catch (FirewallRefusedException refused)
        {
            LogBreakGlassRefused(logger, refused.Message);
        }
    }

    /// <summary>Stops cloudflared, forgets the token and takes the listener out of nginx.</summary>
    private async Task<NginxApplyResult> StopLockedAsync(CancellationToken cancellationToken)
    {
        try
        {
            await cloudflared.StopAsync(cancellationToken);
        }
        catch (Exception failure) when (failure is ProcessStartException or IOException or UnauthorizedAccessException)
        {
            LogStopFailed(logger, failure);
        }

        await SaveAsync(
            saved =>
            {
                saved.Enabled = false;
                saved.ProtectedToken = null;
                saved.WebClosed = false;
                saved.SshMode = TunnelSshMode.Open;
                saved.ChangeKind = null;
                saved.PendingSshMode = null;
                saved.OffForOriginLock = false;
                saved.BreakGlassOpen = false;
                saved.DownSince = null;
                saved.LastConnectedAt = null;
            },
            cancellationToken);
        await alerts.ResolveAsync(AlertKind.CloudflareTunnelDown, AlertResource, cancellationToken);
        return await sites.ApplyAsync(null, cancellationToken);
    }

    private async Task<CloudflareTunnelStatus> DescribeAsync(CancellationToken cancellationToken)
    {
        var row = await LoadAsync(cancellationToken) ?? new CloudflareTunnelSetting();
        var installed = await cloudflared.InspectAsync(cancellationToken);
        var webPorts = await WebPortsAsync(cancellationToken);
        var sshPorts = await SshPortsAsync(cancellationToken);
        var warnings = new List<string>();
        var open = new List<string>();
        if (row.Enabled && row.WebClosed)
        {
            try
            {
                var firewallState = await backends.Current().ReadAsync(cancellationToken);
                open.AddRange(TunnelFirewallPlanner.CompareWeb(firewallState, webPorts).Open);
                open.AddRange(TunnelFirewallPlanner.CompareSsh(firewallState, row.SshMode, sshPorts).Open.Except(open, StringComparer.Ordinal));
            }
            catch (Exception failure) when (IsMachineFailure(failure))
            {
                warnings.Add($"The core could not read the firewall: {failure.Message}");
            }
        }

        var job = row.SetupJobId is { } jobId ? await jobs.GetAsync(jobId, cancellationToken) : null;
        var changeState = row.ChangeSetId is { } changeSetId ? await ChangeStateAsync(changeSetId, cancellationToken) : null;
        var tunnel = row.Enabled && row.MetricsPort > 0 ? await health.ReadAsync(row.MetricsPort, cancellationToken) : new TunnelHealth(false, 0);
        if (row.Enabled && coreDomain.Read() is { Enabled: true, ThroughCloudflare: false } direct)
        {
            warnings.Add($"The core domain {direct.Domain} points straight at the server, so it does not answer through the tunnel. Switch it to Through Cloudflare under Security, Connection.");
        }

        if (row.BreakGlassOpen)
        {
            warnings.Add("Break-glass opened SSH to everyone while the tunnel was down. It closes again once the tunnel has been back for a few minutes.");
        }

        var state = !row.Enabled ? (job?.State == JobState.Running ? CloudflareTunnelState.Installing : CloudflareTunnelState.Off)
            : job?.State == JobState.Running ? CloudflareTunnelState.Installing
            : row.ChangeKind is not null && changeState is FirewallChangeState.Applying or FirewallChangeState.AwaitingConfirmation ? CloudflareTunnelState.Pending
            : row.LastConnectedAt is null && job?.State is JobState.Failed or JobState.Cancelled or JobState.Interrupted ? CloudflareTunnelState.Failed
            : !tunnel.Ready ? (row.LastConnectedAt is null ? CloudflareTunnelState.Connecting : CloudflareTunnelState.Down)
            : !row.WebClosed ? CloudflareTunnelState.PortsOpen
            : open.Count > 0 ? CloudflareTunnelState.Drifted
            : CloudflareTunnelState.Connected;
        if (state == CloudflareTunnelState.Failed && row.LastError is null && job?.Error is { } jobError)
        {
            row.LastError = jobError;
        }

        return CloudflareTunnelMapper.ToStatus(
            row, state, [.. webPorts], [.. sshPorts], [.. open], [.. warnings], tunnel.Connections, installed.Installed, installed.Version, changeState);
    }

    private async Task<CloudflareTunnelPreview> PreviewAsync(
        string? sshConnection,
        FirewallCaller caller,
        Func<FirewallState, Task<TunnelFirewallPlan>> plan,
        CancellationToken cancellationToken)
    {
        var planned = await plan(await ReadFirewallAsync(cancellationToken));
        var preview = planned.Changes.Count == 0
            ? null
            : await firewall.PreviewAsync(new FirewallChangeRequest([.. planned.Changes], sshConnection), caller, cancellationToken);
        return new CloudflareTunnelPreview([.. planned.Changes], [.. planned.Notes], preview);
    }

    private async Task<TunnelFirewallPlan> OffPlanAsync(FirewallState state, CloudflareTunnelSetting? row, bool reopenWeb, CancellationToken cancellationToken)
    {
        // A firewall that is off or lets everything in has nothing closed to open again.
        if (!state.Active || state.DefaultIncoming == FirewallPolicy.Allow)
        {
            return new TunnelFirewallPlan([], []);
        }

        return TunnelFirewallPlanner.PlanOff(state, _webPorts, await SshPortsAsync(cancellationToken), reopenWeb && row?.WebClosed == true);
    }

    private void CheckSshMode(CloudflareTunnelSetting? row, TunnelSshMode mode, bool overCoreDomain)
    {
        if (!Enum.IsDefined(mode))
        {
            throw new CloudflareTunnelException("Choose who may open SSH: everyone, no one, Cloudflare only or Cloudflare Mesh.");
        }

        switch (mode)
        {
            case TunnelSshMode.Cloudflare when row?.SshHostname is null:
                throw new CloudflareTunnelException("SSH has no name on the tunnel yet. Set the tunnel up again from the app with Cloudflare only SSH.");
            case TunnelSshMode.Mesh when row?.MeshAddress is null:
                throw new CloudflareTunnelException("This server is not a Cloudflare Mesh node yet. Add it to Mesh from the app first.");
            case TunnelSshMode.Closed when !overCoreDomain || coreDomain.Read() is not { Enabled: true, ThroughCloudflare: true }:
                throw new CloudflareTunnelException(
                    "With SSH closed, the core domain through the tunnel is the only way in, so this change has to come over it. Connect through the core domain (Security, Connection) and try again.");
        }
    }

    private async Task<CloudflareTunnelSetting> RequireConnectedAsync(CancellationToken cancellationToken)
    {
        await SettleLockedAsync(cancellationToken);
        var row = await LoadAsync(cancellationToken);
        if (row is not { Enabled: true })
        {
            throw new CloudflareTunnelException("The tunnel is off. Set it up first.");
        }

        if (row.ChangeKind is not null)
        {
            throw new CloudflareTunnelException("A firewall change of the tunnel's waits for its confirmation. Keep or revert it first.");
        }

        if (!(await health.ReadAsync(row.MetricsPort, cancellationToken)).Ready)
        {
            throw new CloudflareTunnelException("The tunnel is not connected to Cloudflare, so closing ports now would take the sites and the core domain offline. Wait for it to connect.");
        }

        RefuseDirectCoreDomain();
        return row;
    }

    private void RefuseDirectCoreDomain()
    {
        if (coreDomain.Read() is { Enabled: true, ThroughCloudflare: false } direct)
        {
            throw new CloudflareTunnelException(
                $"The core domain {direct.Domain} points straight at the server, and the tunnel closes the ports it needs. Under Security, Connection, switch it to Through Cloudflare or turn it off first.");
        }
    }

    private async Task<FirewallState> ReadFirewallAsync(CancellationToken cancellationToken)
    {
        try
        {
            return await backends.Current().ReadAsync(cancellationToken);
        }
        catch (Exception failure) when (IsMachineFailure(failure))
        {
            throw new FirewallRefusedException($"The core could not read the firewall, so it changes nothing: {failure.Message}");
        }
    }

    /// <summary>80 and 443, and Direct TLS's port while that is on: the tunnel leaves none of them open.</summary>
    private async Task<IReadOnlyList<int>> WebPortsAsync(CancellationToken cancellationToken)
    {
        var direct = await directTls.StatusAsync(cancellationToken);
        return direct.Enabled && !_webPorts.Contains(direct.Port) ? [.. _webPorts, direct.Port] : _webPorts;
    }

    private async Task<IReadOnlyList<int>> SshPortsAsync(CancellationToken cancellationToken)
    {
        var ports = (await sshd.ReadAsync(cancellationToken)).Ports;
        return ports.Length > 0 ? ports : [22];
    }

    private async Task<FirewallChangeState?> ChangeStateAsync(Guid changeSetId, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        return await db.FirewallChangeSets.AsNoTracking()
            .Where(change => change.Id == changeSetId)
            .Select(change => (FirewallChangeState?)change.State)
            .FirstOrDefaultAsync(cancellationToken);
    }

    private async Task<bool> OriginLockedAsync(CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        return await db.OriginLock.AsNoTracking().AnyAsync(setting => setting.Id == OriginLockSetting.SingletonId && setting.Enabled, cancellationToken);
    }

    /// <summary>The web ports are closed now, the lock's rules with them: the lock is off.</summary>
    private async Task DisableOriginLockAsync(CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var row = await db.OriginLock.FirstOrDefaultAsync(setting => setting.Id == OriginLockSetting.SingletonId, cancellationToken);
        if (row is { Enabled: true })
        {
            row.Enabled = false;
            row.AuthenticatedOriginPulls = false;
            row.UpdatedAt = Now;
            await db.SaveChangesAsync(cancellationToken);
        }
    }

    private async Task<CloudflareTunnelSetting?> LoadAsync(CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        return await db.CloudflareTunnel.AsNoTracking().FirstOrDefaultAsync(setting => setting.Id == CloudflareTunnelSetting.SingletonId, cancellationToken);
    }

    private async Task SaveAsync(Action<CloudflareTunnelSetting> change, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var row = await db.CloudflareTunnel.FirstOrDefaultAsync(setting => setting.Id == CloudflareTunnelSetting.SingletonId, cancellationToken);
        if (row is null)
        {
            row = new CloudflareTunnelSetting();
            db.CloudflareTunnel.Add(row);
        }

        change(row);
        row.UpdatedAt = Now;
        await db.SaveChangesAsync(cancellationToken);
    }

    /// <summary>A port nothing on loopback uses now; the OS picks it, so it never clashes with a service.</summary>
    private static int FreeLoopbackPort()
    {
        using var probe = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
        probe.Bind(new IPEndPoint(IPAddress.Loopback, 0));
        return ((IPEndPoint)probe.LocalEndPoint!).Port;
    }

    private static string Minutes(TimeSpan span) =>
        span.TotalMinutes < 2 ? $"{(int)span.TotalSeconds} seconds" : $"{(int)span.TotalMinutes} minutes";

    private static bool IsMachineFailure(Exception failure) =>
        failure is FirewallRefusedException or FirewallStepFailedException or ProcessStartException or ProcessFailedException
            or IOException or UnauthorizedAccessException;

    [LoggerMessage(Level = LogLevel.Warning, Message = "Checking the Cloudflare Tunnel failed.")]
    private static partial void LogTickFailed(ILogger logger, Exception error);

    [LoggerMessage(Level = LogLevel.Information, Message = "The origin lock is on; its rules go once the tunnel closes the web ports.")]
    private static partial void LogLockStillOn(ILogger logger);

    [LoggerMessage(Level = LogLevel.Warning, Message = "The Cloudflare Tunnel stayed down; break-glass opened SSH to everyone.")]
    private static partial void LogBreakGlassOpened(ILogger logger);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Break-glass could not change the firewall: {Reason}")]
    private static partial void LogBreakGlassRefused(ILogger logger, string reason);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Stopping cloudflared failed.")]
    private static partial void LogStopFailed(ILogger logger, Exception error);
}
