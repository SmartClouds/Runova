using Tapper;

namespace Runova.ServerCore.Contracts;

// GitHub Release images (E105). A CD pipeline attaches a `docker save` archive to a release; the
// core downloads it straight from GitHub, checks it against what GitHub reports and loads it. The
// app passes a signed link GitHub made for its own sign-in (it lasts minutes and is used once),
// or the core uses a read-only token stored for the repository. Stored tokens are write-only:
// nothing the core sends back carries one.

/// <summary>
/// The body of POST /api/v1/stacks/{id}/revisions/{n}/release-image: the asset as GitHub's API
/// described it to the app, and the signed link to download it, when the app has one. Without a
/// link the core asks GitHub itself, with the token stored for the repository or none for a public
/// one, and checks GitHub's description against this one before downloading.
/// </summary>
/// <param name="Repository">owner/name on github.com.</param>
/// <param name="Sha256">The asset's digest as GitHub reports it, in hex, without the sha256: prefix.</param>
[TranspilationSource]
public sealed record StackReleaseImageRequest(
    string Repository,
    string Tag,
    long AssetId,
    string AssetName,
    long Size,
    string Sha256,
    string? DownloadUrl = null)
{
    /// <summary>Never the link: it signs a download, and SignalR and exception messages print arguments.</summary>
    public override string ToString() =>
        $"StackReleaseImageRequest {{ Repository = {Repository}, Tag = {Tag}, AssetId = {AssetId}, AssetName = {AssetName}, Size = {Size}, Sha256 = {Sha256}, DownloadUrl = {(DownloadUrl is null ? "none" : "[redacted]")} }}";
}

/// <summary>A token stored on the server for one repository's releases. The token never comes back.</summary>
[TranspilationSource]
public sealed record ReleaseTokenInfo(
    Guid Id,
    string Repository,
    long CreatedAtUnixMs,
    long UpdatedAtUnixMs,
    string? CreatedBy = null,
    long? LastUsedAtUnixMs = null);

/// <summary>Stores (or replaces) the token for a repository's releases. Admin, with a recent step-up.</summary>
[TranspilationSource]
public sealed record SaveReleaseTokenRequest(string Repository, string Token)
{
    public override string ToString() => $"SaveReleaseTokenRequest {{ Repository = {Repository}, Token = [redacted] }}";
}

/// <summary>How the server reads a repository's releases on its own.</summary>
[TranspilationSource]
public enum ReleaseAccess
{
    /// <summary>The repository is public: no token needed.</summary>
    Public,

    /// <summary>The token stored for it reads its releases.</summary>
    StoredToken,

    /// <summary>The server cannot read them without a signed link from the app.</summary>
    None,
}

/// <summary>The answer of CheckReleaseAccess, with the words to show.</summary>
[TranspilationSource]
public sealed record ReleaseAccessCheck(string Repository, ReleaseAccess Access, string Message, ReleaseTokenInfo? Token = null);
