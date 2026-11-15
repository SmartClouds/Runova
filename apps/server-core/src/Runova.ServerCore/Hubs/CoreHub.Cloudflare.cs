using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Cloudflare;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Firewall;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Hubs;

/// <summary>
/// Cloudflare on the server (E14). Every role reads the origin lock and which zones have a DNS
/// token; Admins change the lock (a firewall change set, so the lockout guard and the confirm
/// window apply as for any other), handle Origin CA certificates and send or remove DNS tokens.
/// The audit trail gets every change without request bodies: no token or certificate lands there.
/// </summary>
internal sealed partial class CoreHub
{
    [Authorize(Policy = CorePolicies.Viewer)]
    public Task<OriginLockStatus> GetOriginLock() => cloudflare.OriginLock.StatusAsync(Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<OriginLockPreview> PreviewOriginLock(OriginLockRequest request)
    {
        try
        {
            return await cloudflare.OriginLock.PreviewAsync(request, await FirewallCallerAsync(), Context.ConnectionAborted);
        }
        catch (Exception error) when (error is FirewallRefusedException or ArgumentException)
        {
            throw new HubException(error.Message);
        }
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<OriginLockResult> ApplyOriginLock(OriginLockRequest request)
    {
        var caller = await FirewallCallerAsync();
        var parameters = new Dictionary<string, string?>
        {
            ["enabled"] = request?.Enabled == true ? "true" : "false",
            ["authenticatedOriginPulls"] = request?.AuthenticatedOriginPulls == true ? "true" : "false",
        };
        try
        {
            var result = await cloudflare.OriginLock.ApplyAsync(request, caller, Caller, Context.ConnectionAborted);
            await AuditAsync("cloudflare.origin-lock", AuditResult.Success, result.ChangeSet?.Id.ToString("D"), FirewallParameters(caller, parameters));
            return result;
        }
        catch (Exception error) when (error is FirewallRefusedException or ArgumentException)
        {
            parameters["reason"] = error.Message;
            await AuditAsync(
                "cloudflare.origin-lock",
                error is FirewallRefusedException { Verdict: not null } or FirewallRefusedException { NeedsStepUp: true } ? AuditResult.Denied : AuditResult.Failed,
                null,
                FirewallParameters(caller, parameters));
            throw new HubException(error.Message);
        }
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<OriginLockStatus> RefreshCloudflareRanges()
    {
        var status = await cloudflare.OriginLock.RefreshAsync(Context.ConnectionAborted);
        await AuditAsync("cloudflare.refresh-ranges", status.LastRefreshError is null ? AuditResult.Success : AuditResult.Failed, status.ChangeSetId?.ToString("D"));
        return status;
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<OriginCertificateRequestInfo> CreateOriginCertificateRequest(string siteId)
    {
        try
        {
            var request = await cloudflare.OriginCertificates.CreateRequestAsync(siteId, Context.ConnectionAborted);
            await AuditAsync("certificate.origin-request", AuditResult.Success, Target(siteId));
            return request;
        }
        catch (ArgumentException error)
        {
            await AuditAsync("certificate.origin-request", AuditResult.Failed, Target(siteId));
            throw new HubException(error.Message);
        }
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<CertificateUploadResult> InstallOriginCertificate(OriginCertificateInstall request)
    {
        try
        {
            var result = await cloudflare.OriginCertificates.InstallAsync(request, Caller, Context.ConnectionAborted);
            await AuditSaveAsync("certificate.origin-install", request?.SiteId, result.Problems.Length);
            return result;
        }
        catch (ArgumentException error)
        {
            await AuditAsync("certificate.origin-install", AuditResult.Failed, Target(request?.SiteId));
            throw new HubException(error.Message);
        }
    }

    [Authorize(Policy = CorePolicies.Viewer)]
    public Task<CloudflareTunnelStatus> GetCloudflareTunnel() => cloudflare.Tunnel.StatusAsync(Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<JobInfo> StartCloudflareTunnel(CloudflareTunnelSetup request)
    {
        // The token never reaches the audit trail: only which tunnel, by Cloudflare's id.
        var parameters = new Dictionary<string, string?> { ["sshHostname"] = request?.SshHostname };
        try
        {
            var job = await cloudflare.Tunnel.StartAsync(request, Caller, Context.ConnectionAborted);
            await AuditAsync("cloudflare.tunnel.start", AuditResult.Success, request!.TunnelId, parameters);
            return job;
        }
        catch (Exception error) when (error is CloudflareTunnelException or JobConflictException or ArgumentException)
        {
            parameters["reason"] = error.Message;
            await AuditAsync("cloudflare.tunnel.start", AuditResult.Failed, null, parameters);
            throw new HubException(error.Message);
        }
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public Task<CloudflareTunnelPreview> PreviewCloudflareTunnelPorts(CloudflareTunnelFirewallRequest request) =>
        TunnelCallAsync(caller => cloudflare.Tunnel.PreviewWebAsync(request, caller, Context.ConnectionAborted));

    [Authorize(Policy = CorePolicies.Admin)]
    public Task<CloudflareTunnelResult> CloseCloudflareTunnelPorts(CloudflareTunnelFirewallRequest request) =>
        TunnelChangeAsync("cloudflare.tunnel.close-ports", [], caller => cloudflare.Tunnel.CloseWebAsync(request, caller, Context.ConnectionAborted));

    [Authorize(Policy = CorePolicies.Admin)]
    public Task<CloudflareTunnelPreview> PreviewTunnelSsh(TunnelSshRequest request) =>
        TunnelCallAsync(caller => cloudflare.Tunnel.PreviewSshAsync(request, caller, OverCoreDomain, Context.ConnectionAborted));

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<CloudflareTunnelResult> ApplyTunnelSsh(TunnelSshRequest request)
    {
        var parameters = new Dictionary<string, string?> { ["mode"] = request?.Mode.ToString() };
        if (request?.Mode == TunnelSshMode.Closed && !User.IsInRole(CoreRoles.Owner))
        {
            await AuditAsync("cloudflare.tunnel.ssh", AuditResult.Denied, null, parameters);
            throw new HubException("Only an Owner can close SSH to everyone.");
        }

        return await TunnelChangeAsync("cloudflare.tunnel.ssh", parameters, caller => cloudflare.Tunnel.ApplySshAsync(request, caller, OverCoreDomain, Context.ConnectionAborted));
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public Task<CloudflareTunnelPreview> PreviewCloudflareTunnelOff(CloudflareTunnelOffRequest request) =>
        TunnelCallAsync(caller => cloudflare.Tunnel.PreviewOffAsync(request, caller, Context.ConnectionAborted));

    [Authorize(Policy = CorePolicies.Admin)]
    public Task<CloudflareTunnelResult> TurnOffCloudflareTunnel(CloudflareTunnelOffRequest request) =>
        TunnelChangeAsync(
            "cloudflare.tunnel.off",
            new() { ["reopenWeb"] = request?.ReopenWeb == false ? "false" : "true" },
            caller => cloudflare.Tunnel.TurnOffAsync(request, caller, Context.ConnectionAborted));

    [Authorize(Policy = CorePolicies.Owner)]
    public async Task<CloudflareTunnelStatus> SetTunnelBreakGlass(TunnelBreakGlassRequest request)
    {
        var parameters = new Dictionary<string, string?>
        {
            ["enabled"] = request?.Enabled == true ? "true" : "false",
            ["delayMinutes"] = request?.DelayMinutes.ToString(System.Globalization.CultureInfo.InvariantCulture),
        };
        try
        {
            var status = await cloudflare.Tunnel.SetBreakGlassAsync(request, Context.ConnectionAborted);
            await AuditAsync("cloudflare.tunnel.break-glass", AuditResult.Success, null, parameters);
            return status;
        }
        catch (Exception error) when (error is CloudflareTunnelException or ArgumentException)
        {
            await AuditAsync("cloudflare.tunnel.break-glass", AuditResult.Failed, null, parameters);
            throw new HubException(error.Message);
        }
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<JobInfo> JoinCloudflareMesh(CloudflareMeshJoin request)
    {
        try
        {
            var job = await cloudflare.Tunnel.JoinMeshAsync(request, Caller, Context.ConnectionAborted);
            await AuditAsync("cloudflare.mesh.join", AuditResult.Success, request!.NodeId);
            return job;
        }
        catch (Exception error) when (error is CloudflareTunnelException or JobConflictException or ArgumentException)
        {
            await AuditAsync("cloudflare.mesh.join", AuditResult.Failed, null, new Dictionary<string, string?> { ["reason"] = error.Message });
            throw new HubException(error.Message);
        }
    }

    /// <summary>Whether this call came through the core domain (from nginx), the way in that remains with SSH closed.</summary>
    private bool OverCoreDomain => CoreDomain.CoreDomainEndpoint.IsProxied(Context.GetHttpContext());

    private async Task<T> TunnelCallAsync<T>(Func<FirewallCaller, Task<T>> work)
    {
        try
        {
            return await work(await FirewallCallerAsync());
        }
        catch (Exception error) when (error is CloudflareTunnelException or FirewallRefusedException or ArgumentException)
        {
            throw new HubException(error.Message);
        }
    }

    private async Task<CloudflareTunnelResult> TunnelChangeAsync(string action, Dictionary<string, string?> parameters, Func<FirewallCaller, Task<CloudflareTunnelResult>> work)
    {
        var caller = await FirewallCallerAsync();
        try
        {
            var result = await work(caller);
            await AuditAsync(action, AuditResult.Success, result.ChangeSet?.Id.ToString("D"), FirewallParameters(caller, parameters));
            return result;
        }
        catch (Exception error) when (error is CloudflareTunnelException or FirewallRefusedException or ArgumentException)
        {
            parameters["reason"] = error.Message;
            await AuditAsync(
                action,
                error is FirewallRefusedException { Verdict: not null } or FirewallRefusedException { NeedsStepUp: true } ? AuditResult.Denied : AuditResult.Failed,
                null,
                FirewallParameters(caller, parameters));
            throw new HubException(error.Message);
        }
    }

    [Authorize(Policy = CorePolicies.Viewer)]
    public Task<DnsCredentialInfo[]> ListDnsCredentials() => cloudflare.DnsCredentials.ListAsync(Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<DnsCredentialSaveResult> SaveDnsCredential(DnsCredentialRequest request)
    {
        var result = await cloudflare.DnsCredentials.SaveAsync(request, Caller, Context.ConnectionAborted);
        await AuditAsync(
            "cloudflare.dns-token.save",
            result.Problems.Length == 0 ? AuditResult.Success : AuditResult.Failed,
            result.Credential?.Zone);
        return result;
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task RemoveDnsCredential(string zone)
    {
        var removed = await cloudflare.DnsCredentials.RemoveAsync(zone, Context.ConnectionAborted);
        await AuditAsync("cloudflare.dns-token.remove", removed ? AuditResult.Success : AuditResult.Failed, removed ? zone.Trim().ToLowerInvariant() : null);
        if (!removed)
        {
            throw new HubException("This server has no DNS token for that zone.");
        }
    }
}
