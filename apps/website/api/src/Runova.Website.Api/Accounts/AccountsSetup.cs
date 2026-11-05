using Microsoft.AspNetCore.Authentication;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Data;

namespace Runova.Website.Api.Accounts;

internal static class AccountsSetup
{
    public static IServiceCollection AddWebsiteAccounts(this IServiceCollection services)
    {
        services.AddSingleton<SignInSecrets>();
        services.AddSingleton<SignInSettingsStore>();
        services.AddHostedService(provider => provider.GetRequiredService<SignInSettingsStore>());
        services.AddOptions<CaptchaOptions>().BindConfiguration(CaptchaOptions.Section);
        services.AddHttpClient<TurnstileVerifier>(TurnstileVerifier.Configure);
        services.AddGoogleSignIn();
        services.AddWebsiteSync();
        services.AddScoped<SyncTombstonesPurgeJob>();
        services.AddSingleton<DeviceTokens>();
        services.AddAuthentication().AddScheme<AuthenticationSchemeOptions, DeviceTokenAuthenticationHandler>(DeviceTokenAuthenticationHandler.SchemeName, null);
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
/// Forgets deletes older than 90 days: by then every computer that was going to see one has. A
/// computer offline longer than that keeps an item another one deleted.
/// </summary>
internal sealed partial class SyncTombstonesPurgeJob(AppDbContext db, TimeProvider time, ILogger<SyncTombstonesPurgeJob> logger)
{
    public static readonly TimeSpan KeepFor = TimeSpan.FromDays(90);

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        var cutoff = time.GetUtcNow() - KeepFor;
        var purged = await db.SyncRecords.Where(r => r.Deleted && r.UpdatedAt < cutoff).ExecuteDeleteAsync(cancellationToken);
        LogPurged(logger, purged);
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Purged {Count} sync tombstones")]
    private static partial void LogPurged(ILogger logger, int count);
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
