using System.Globalization;
using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Runova.Website.Core.Dependencies;
using Runova.Website.Data;
using Runova.Website.Data.Dependencies;

namespace Runova.Website.Api.Dependencies;

/// <summary>The signed-in account's id, for the account routes.</summary>
internal static class CurrentAccount
{
    public static long Id(HttpContext http) =>
        long.Parse(http.User.FindFirstValue(ClaimTypes.NameIdentifier)!, CultureInfo.InvariantCulture);
}

/// <summary>
/// An account's dependency alert settings. The row is made with the defaults the first time it is
/// read, so it always has a version to send as an ETag.
/// </summary>
internal sealed class AlertSettingsStore(AppDbContext db)
{
    public async Task<DependencyAlertSettings> GetAsync(long userId)
    {
        if (await db.DependencyAlertSettings.SingleOrDefaultAsync(s => s.UserId == userId) is { } existing)
        {
            return existing;
        }

        var settings = new DependencyAlertSettings { UserId = userId };
        db.DependencyAlertSettings.Add(settings);
        try
        {
            await db.SaveChangesAsync();
            return settings;
        }
        catch (DbUpdateException e) when (e.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            // Two first reads at once: the other one made it.
            db.Entry(settings).State = EntityState.Detached;
            return await db.DependencyAlertSettings.SingleAsync(s => s.UserId == userId);
        }
    }

    /// <summary>Whether the account has alerts on, without making a row.</summary>
    public async Task<bool> IsEnabledAsync(long userId) =>
        await db.DependencyAlertSettings.Where(s => s.UserId == userId).Select(s => (bool?)s.Enabled).SingleOrDefaultAsync() ?? true;

    public static AlertPreferences ToPreferences(DependencyAlertSettings? settings) =>
        settings is null
            ? AlertPreferences.Defaults
            : DependencyMapper.ToPreferences(settings);
}

/// <summary>When an inventory is checked. Tests replace <see cref="Next"/> to pin the times down.</summary>
internal class CheckSchedule(TimeProvider time)
{
    /// <summary>A new or changed inventory is first checked within this long.</summary>
    public static readonly TimeSpan FirstWithin = TimeSpan.FromHours(1);

    public static readonly TimeSpan Day = TimeSpan.FromHours(24);

    /// <summary>How far the next check may move from a day later, either way.</summary>
    public static readonly TimeSpan Drift = TimeSpan.FromHours(3);

    /// <summary>A number from 0 up to 1.</summary>
    protected virtual double Next() => Random.Shared.NextDouble();

    public DateTimeOffset First() => time.GetUtcNow() + (FirstWithin * Next());

    /// <summary>A day from now, give or take up to <see cref="Drift"/>, so the time moves from day to day.</summary>
    public DateTimeOffset AfterCheck() => time.GetUtcNow() + Day + (Drift * ((2 * Next()) - 1));
}
