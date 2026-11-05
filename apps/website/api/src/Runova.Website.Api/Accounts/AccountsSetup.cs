using Microsoft.EntityFrameworkCore;
using Runova.Website.Data;

namespace Runova.Website.Api.Accounts;

internal static class AccountsSetup
{
    public static IServiceCollection AddWebsiteAccounts(this IServiceCollection services)
    {
        services.AddGoogleSignIn();
        services.AddMemoryCache();
        services.AddHttpContextAccessor();
        services.AddScoped<AccountSessions>();
        services.AddScoped<ActivityLog>();
        services.AddScoped<AccountDeletion>();
        services.AddScoped<UnverifiedAccountsCleanupJob>();
        return services;
    }
}

/// <summary>
/// Deletes accounts whose email was never confirmed a week after they were made, so an address
/// someone else typed in does not stay taken. Staff are never touched (an invited Editor has no
/// confirmed email until they set a password, and keeps their row).
/// </summary>
internal sealed partial class UnverifiedAccountsCleanupJob(AppDbContext db, TimeProvider time, ILogger<UnverifiedAccountsCleanupJob> logger)
{
    public static readonly TimeSpan KeepFor = TimeSpan.FromDays(7);

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        var cutoff = time.GetUtcNow() - KeepFor;
        var deleted = await db.Users
            .Where(u => !u.EmailConfirmed && u.CreatedAt < cutoff)
            .Where(u => !db.UserRoles.Any(r => r.UserId == u.Id))
            .ExecuteDeleteAsync(cancellationToken);
        LogDeleted(logger, deleted);
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Deleted {Count} accounts that were never confirmed")]
    private static partial void LogDeleted(ILogger logger, int count);
}
