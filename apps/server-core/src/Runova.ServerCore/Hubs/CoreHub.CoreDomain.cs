using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.CoreDomain;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Hubs;

/// <summary>
/// The core domain (E44). Every role reads how it stands. Owners turn it on, with a step-up since
/// it puts the core on a public domain, and off. Its certificate goes through the usual
/// certificate calls for the reserved site, so issuing and renewing work as for any site.
/// </summary>
internal sealed partial class CoreHub
{
    [Authorize(Policy = CorePolicies.Viewer)]
    public Task<CoreDomainStatus> GetCoreDomain() => coreDomain.StatusAsync(Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Owner)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<CoreDomainStatus> EnableCoreDomain(CoreDomainRequest request)
    {
        var parameters = new Dictionary<string, string?>
        {
            ["domain"] = request?.Domain is { } domain ? domain[..Math.Min(domain.Length, 253)] : null,
            ["sources"] = request?.Sources is { Length: > 0 } sources ? string.Join(' ', sources.Take(DirectTls.DirectTlsSettings.MaxSources)) : "any",
        };
        try
        {
            var status = await coreDomain.EnableAsync(request ?? new CoreDomainRequest(string.Empty), Caller, Context.ConnectionAborted);
            parameters["listening"] = status.Listening ? "true" : "false";
            parameters["applied"] = status.SiteApplied ? "true" : "false";
            await AuditAsync("coreDomain.enable", AuditResult.Success, null, parameters);
            return status;
        }
        catch (CoreDomainRefusedException refused)
        {
            parameters["reason"] = refused.Message;
            await AuditAsync("coreDomain.enable", AuditResult.Denied, null, parameters);
            throw new HubException(refused.Message);
        }
    }

    [Authorize(Policy = CorePolicies.Owner)]
    public async Task<CoreDomainStatus> DisableCoreDomain()
    {
        var status = await coreDomain.DisableAsync(Caller, Context.ConnectionAborted);
        await AuditAsync("coreDomain.disable", AuditResult.Success, null, new() { ["domain"] = status.Domain });
        return status;
    }
}
