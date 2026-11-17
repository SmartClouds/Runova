using Microsoft.EntityFrameworkCore;

namespace Runova.ServerCore.Data;

// GitHub Release images (E105): tokens stored on the server for downloads nobody signs in for.

/// <summary>
/// A read-only GitHub token for one repository's releases. The token is sealed with Data
/// Protection under its own purpose (ReleaseTokens.Purpose) and only unsealed while a release
/// asset downloads; no API returns it. The repository is owner/name in lowercase, one row each.
/// </summary>
internal sealed class ReleaseTokenRecord
{
    public Guid Id { get; set; }

    public required string Repository { get; set; }

    /// <summary>Base64 of the Data Protection payload.</summary>
    public required string SealedToken { get; set; }

    public long CreatedAt { get; set; }

    public long UpdatedAt { get; set; }

    public string? CreatedBy { get; set; }

    public long? LastUsedAt { get; set; }
}

internal static class ReleaseModel
{
    public static void Configure(ModelBuilder builder)
    {
        builder.Entity<ReleaseTokenRecord>(token =>
        {
            token.HasKey(t => t.Id);
            token.Property(t => t.Repository).HasMaxLength(200);
            token.HasIndex(t => t.Repository).IsUnique();
            token.Property(t => t.CreatedBy).HasMaxLength(256);
        });
    }
}
