using Microsoft.EntityFrameworkCore;
using Runova.Website.Data;

namespace Runova.Website.Api.Notifications;

/// <summary>Which categories an account has turned off. No row means on, so only choices are stored.</summary>
internal sealed class NotificationPreferenceStore(AppDbContext db)
{
    /// <summary>The categories each of these accounts turned off, only for those with any.</summary>
    public async Task<IReadOnlyDictionary<long, HashSet<string>>> OffAsync(IReadOnlyCollection<long> userIds, CancellationToken cancellationToken = default)
    {
        var rows = await db.NotificationPreferences.AsNoTracking()
            .Where(p => userIds.Contains(p.UserId) && !p.Enabled)
            .Select(p => new { p.UserId, p.Category })
            .ToListAsync(cancellationToken);
        return rows.GroupBy(r => r.UserId).ToDictionary(g => g.Key, g => g.Select(r => r.Category).ToHashSet(StringComparer.Ordinal));
    }

    /// <summary>The categories this account turned off.</summary>
    public async Task<HashSet<string>> OffForAsync(long userId, CancellationToken cancellationToken = default) =>
        (await OffAsync([userId], cancellationToken)).GetValueOrDefault(userId) ?? new HashSet<string>(StringComparer.Ordinal);

    /// <summary>Saves one choice; two taps racing each other end with the last one.</summary>
    public Task SetAsync(long userId, string category, bool enabled, CancellationToken cancellationToken = default) =>
        db.Database.ExecuteSqlInterpolatedAsync(
            $"""
            INSERT INTO "NotificationPreferences" ("UserId", "Category", "Enabled") VALUES ({userId}, {category}, {enabled})
            ON CONFLICT ("UserId", "Category") DO UPDATE SET "Enabled" = {enabled}
            """,
            cancellationToken);
}
