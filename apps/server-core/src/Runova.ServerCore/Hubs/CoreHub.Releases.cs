using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Releases;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Hubs;

/// <summary>
/// GitHub Release images (E105). Operators see which repositories have a stored token and ask how
/// the server reads a repository's releases on its own; storing or removing a token is for Admins
/// with a recent step-up, since a stored token lets anyone who can deploy download with it. A
/// token is stored only once GitHub confirms it reads the releases. Nothing here returns a token.
/// </summary>
internal sealed partial class CoreHub
{
    [Authorize(Policy = CorePolicies.Operator)]
    public Task<ReleaseTokenInfo[]> ListReleaseTokens() =>
        releaseTokens.ListAsync(Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Admin)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<ReleaseTokenInfo> SaveReleaseToken(SaveReleaseTokenRequest request)
    {
        var repository = request?.Repository;
        async Task<HubException> RefuseAsync(string reason)
        {
            await ReleaseAuditAsync("release.token-save", AuditResult.Denied, repository is { Length: <= 200 } ? repository.ToLowerInvariant() : null, new() { ["reason"] = reason });
            return new HubException(reason);
        }

        if (!ReleaseNames.IsRepository(repository))
        {
            throw await RefuseAsync("Name the repository as owner/name, such as acme/shop.");
        }

        if (!ReleaseNames.IsToken(request!.Token))
        {
            throw await RefuseAsync("Paste the token on one line, as GitHub shows it.");
        }

        ReleaseAccess access;
        try
        {
            access = await releaseDownloads.AccessAsync(repository!, request.Token, Context.ConnectionAborted);
        }
        catch (ReleaseRefusedException refused)
        {
            throw await RefuseAsync(refused.Message);
        }

        if (access != ReleaseAccess.StoredToken)
        {
            throw await RefuseAsync(
                $"GitHub did not let this token read the releases of {repository}. A fine-grained token needs the repository selected and Contents: Read-only; nothing else.");
        }

        try
        {
            var (info, replaced) = await releaseTokens.SaveAsync(repository!, request.Token, StackCaller.UserName, Context.ConnectionAborted);
            await ReleaseAuditAsync("release.token-save", AuditResult.Success, info.Repository, new() { ["replaced"] = replaced ? "true" : "false" });
            return info;
        }
        catch (ReleaseRefusedException refused)
        {
            throw await RefuseAsync(refused.Message);
        }
    }

    [Authorize(Policy = CorePolicies.Admin)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task DeleteReleaseToken(Guid tokenId)
    {
        string repository;
        try
        {
            repository = await releaseTokens.DeleteAsync(tokenId, Context.ConnectionAborted);
        }
        catch (ReleaseRefusedException refused)
        {
            throw new HubException(refused.Message);
        }

        await ReleaseAuditAsync("release.token-delete", AuditResult.Success, repository, null);
    }

    [Authorize(Policy = CorePolicies.Operator)]
    public async Task<ReleaseAccessCheck> CheckReleaseAccess(string repository)
    {
        if (!ReleaseNames.IsRepository(repository))
        {
            throw new HubException("Name the repository as owner/name, such as acme/shop.");
        }

        try
        {
            var stored = await releaseTokens.FindAsync(repository, Context.ConnectionAborted);
            if (stored is not null)
            {
                var token = await releaseTokens.UnsealAsync(repository, Context.ConnectionAborted);
                var access = await releaseDownloads.AccessAsync(repository, token, Context.ConnectionAborted);
                return access == ReleaseAccess.StoredToken
                    ? new ReleaseAccessCheck(repository, ReleaseAccess.StoredToken, $"The server reads the releases of {repository} with the token stored for it.", stored)
                    : new ReleaseAccessCheck(repository, ReleaseAccess.None, $"The token stored for {repository} no longer reads its releases. Store a new read-only token.", stored);
            }

            return await releaseDownloads.AccessAsync(repository, null, Context.ConnectionAborted) == ReleaseAccess.Public
                ? new ReleaseAccessCheck(repository, ReleaseAccess.Public, $"{repository} is public, so the server downloads its releases without a token.")
                : new ReleaseAccessCheck(
                    repository,
                    ReleaseAccess.None,
                    $"The server cannot read the releases of {repository} on its own. Deploys from this computer still work through your GitHub sign-in; for deploys without it, store a read-only token.");
        }
        catch (ReleaseRefusedException refused)
        {
            throw new HubException(refused.Message);
        }
    }

    private Task<AuditEvent> ReleaseAuditAsync(string action, string result, string? target, Dictionary<string, string?>? parameters) =>
        audit.AppendAsync(new AuditEntry(action, result, StackCaller.UserId, StackCaller.DeviceId, StackCaller.PeerUid, target, parameters), Context.ConnectionAborted);
}
