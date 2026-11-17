using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Compatibility;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Releases;

/// <summary>A release request the core turns down, with the words to show.</summary>
internal sealed class ReleaseRefusedException(string message) : Exception(message);

/// <summary>
/// Read-only GitHub tokens stored on the server for one repository's releases each (E105), for
/// downloads nobody signs in for. The token is sealed with Data Protection before it reaches the
/// database and unsealed only while a release asset downloads; it is write-only through the API.
/// The hub audits saves and removals; this class only keeps them.
/// </summary>
internal sealed class ReleaseTokens(IDbContextFactory<CoreDbContext> contexts, IDataProtectionProvider protection, TimeProvider time)
{
    public const string Purpose = FrozenIdentifiers.ReleaseTokenPurpose;

    /// <summary>A handful per server is plenty; this keeps a script from filling the table.</summary>
    public const int MaxStored = 50;

    private readonly IDataProtector _protector = protection.CreateProtector(Purpose);

    private long Now => time.GetUtcNow().ToUnixTimeMilliseconds();

    public async Task<ReleaseTokenInfo[]> ListAsync(CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var rows = await db.ReleaseTokens.AsNoTracking().ToListAsync(cancellationToken);
        return [.. rows.OrderBy(r => r.Repository, StringComparer.Ordinal).Select(ReleaseTokenMapper.ToInfo)];
    }

    public async Task<ReleaseTokenInfo?> FindAsync(string repository, CancellationToken cancellationToken)
    {
        var key = ReleaseNames.Normalize(repository);
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var row = await db.ReleaseTokens.AsNoTracking().FirstOrDefaultAsync(r => r.Repository == key, cancellationToken);
        return row is null ? null : ReleaseTokenMapper.ToInfo(row);
    }

    /// <summary>Stores or replaces the token for a repository. The caller has checked both.</summary>
    public async Task<(ReleaseTokenInfo Info, bool Replaced)> SaveAsync(string repository, string token, string? createdBy, CancellationToken cancellationToken)
    {
        if (!ReleaseNames.IsRepository(repository) || !ReleaseNames.IsToken(token))
        {
            throw new ReleaseRefusedException("Give a repository as owner/name and a GitHub token on one line.");
        }

        var key = ReleaseNames.Normalize(repository);
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var row = await db.ReleaseTokens.FirstOrDefaultAsync(r => r.Repository == key, cancellationToken);
        var replaced = row is not null;
        if (row is null)
        {
            if (await db.ReleaseTokens.CountAsync(cancellationToken) >= MaxStored)
            {
                throw new ReleaseRefusedException($"This server already stores {MaxStored} release tokens. Remove one first.");
            }

            row = new ReleaseTokenRecord
            {
                Id = Guid.NewGuid(),
                Repository = key,
                SealedToken = Seal(token),
                CreatedAt = Now,
                UpdatedAt = Now,
                CreatedBy = createdBy,
            };
            db.ReleaseTokens.Add(row);
        }
        else
        {
            row.SealedToken = Seal(token);
            row.UpdatedAt = Now;
            row.LastUsedAt = null;
        }

        await db.SaveChangesAsync(cancellationToken);
        return (ReleaseTokenMapper.ToInfo(row), replaced);
    }

    /// <summary>Removes a stored token and answers which repository it was for.</summary>
    public async Task<string> DeleteAsync(Guid id, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var row = await db.ReleaseTokens.FirstOrDefaultAsync(r => r.Id == id, cancellationToken)
            ?? throw new ReleaseRefusedException("There is no such release token on this server.");
        db.ReleaseTokens.Remove(row);
        await db.SaveChangesAsync(cancellationToken);
        return row.Repository;
    }

    /// <summary>
    /// The token for a repository, unsealed for one download, or null when none is stored (or it
    /// was sealed under keys this core no longer has). Marks it used.
    /// </summary>
    public async Task<string?> UnsealAsync(string repository, CancellationToken cancellationToken)
    {
        var key = ReleaseNames.Normalize(repository);
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var row = await db.ReleaseTokens.AsNoTracking().FirstOrDefaultAsync(r => r.Repository == key, cancellationToken);
        if (row is null)
        {
            return null;
        }

        string token;
        try
        {
            token = Encoding.UTF8.GetString(_protector.Unprotect(Convert.FromBase64String(row.SealedToken)));
        }
        catch (CryptographicException)
        {
            return null;
        }

        await db.ReleaseTokens.Where(r => r.Id == row.Id).ExecuteUpdateAsync(u => u.SetProperty(r => r.LastUsedAt, Now), CancellationToken.None);
        return token;
    }

    private string Seal(string token) => Convert.ToBase64String(_protector.Protect(Encoding.UTF8.GetBytes(token)));
}
