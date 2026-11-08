using System.Linq.Expressions;
using Hangfire;
using Runova.Website.Api.Accounts;
using Runova.Website.Api.ApiClients;
using Runova.Website.Api.Billing;
using Runova.Website.Api.CloudMonitoring;
using Runova.Website.Api.Dependencies;
using Runova.Website.Api.Email;
using Runova.Website.Api.Monitoring;
using Runova.Website.Api.News;
using Runova.Website.Api.Releases;
using Runova.Website.Api.Remote;
using Runova.Website.Api.Telegram;
using Runova.Website.Api.Users;

namespace Runova.Website.Api.Jobs;

/// <summary>
/// Every recurring job, by a fixed id, with its schedule. Schedules are cron expressions in UTC.
/// </summary>
internal static class RecurringJobRegistry
{
    public const string InvitationsCleanup = "invitations-cleanup";
    public const string NewsPublish = "news-publish";
    public const string SignatureNoncesPurge = "signature-nonces-purge";
    public const string IdempotencyPurge = "idempotency-purge";
    public const string ReleasesSync = "releases-sync";
    public const string EmailOutbox = "email-outbox";
    public const string UnverifiedAccountsCleanup = "unverified-accounts-cleanup";
    public const string SyncTombstonesPurge = "sync-tombstones-purge";
    public const string DependencyChecks = "dependency-checks";
    public const string TelegramOutbox = "telegram-outbox";
    public const string SubscriptionExpiry = "subscription-expiry";
    public const string RenewalReminders = "renewal-reminders";
    public const string NodeLiveness = "node-liveness";
    public const string SampleRetention = "monitor-sample-retention";
    public const string RemoteSessionRetention = "remote-session-retention";

    public static readonly IReadOnlyDictionary<string, string> Schedules = new Dictionary<string, string>
    {
        [InvitationsCleanup] = Cron.Hourly(),
        [NewsPublish] = Cron.Minutely(),
        [SignatureNoncesPurge] = Cron.MinuteInterval(10),
        [IdempotencyPurge] = Cron.Hourly(),
        [ReleasesSync] = Cron.MinuteInterval(15),
        [EmailOutbox] = Cron.Minutely(),
        [UnverifiedAccountsCleanup] = Cron.Daily(),
        [SyncTombstonesPurge] = Cron.Daily(3),
        [DependencyChecks] = Cron.MinuteInterval(15),
        [TelegramOutbox] = Cron.Minutely(),
        [SubscriptionExpiry] = Cron.Hourly(),
        [RenewalReminders] = Cron.Daily(9),
        [NodeLiveness] = Cron.Minutely(),
        [SampleRetention] = Cron.Daily(4),
        [RemoteSessionRetention] = Cron.Daily(5),
    };

    /// <summary>Adds each job, or updates it when its schedule or method changed.</summary>
    public static void Register(IRecurringJobManager jobs)
    {
        Add<InvitationsCleanupJob>(jobs, InvitationsCleanup, job => job.RunAsync(CancellationToken.None));
        Add<NewsPublishJob>(jobs, NewsPublish, job => job.RunAsync(CancellationToken.None));
        Add<SignatureNoncesPurgeJob>(jobs, SignatureNoncesPurge, job => job.RunAsync(CancellationToken.None));
        Add<IdempotencyPurgeJob>(jobs, IdempotencyPurge, job => job.RunAsync(CancellationToken.None));
        Add<ReleasesSyncJob>(jobs, ReleasesSync, job => job.RunAsync(CancellationToken.None));
        Add<EmailOutboxJob>(jobs, EmailOutbox, job => job.RunAsync(CancellationToken.None));
        Add<UnverifiedAccountsCleanupJob>(jobs, UnverifiedAccountsCleanup, job => job.RunAsync(CancellationToken.None));
        Add<SyncTombstonesPurgeJob>(jobs, SyncTombstonesPurge, job => job.RunAsync(CancellationToken.None));
        Add<DependencyCheckJob>(jobs, DependencyChecks, job => job.RunAsync(CancellationToken.None));
        Add<TelegramOutboxJob>(jobs, TelegramOutbox, job => job.RunAsync(CancellationToken.None));
        Add<SubscriptionExpiryJob>(jobs, SubscriptionExpiry, job => job.RunAsync(CancellationToken.None));
        Add<RenewalReminderJob>(jobs, RenewalReminders, job => job.RunAsync(CancellationToken.None));
        Add<NodeLivenessJob>(jobs, NodeLiveness, job => job.RunAsync(CancellationToken.None));
        Add<SampleRetentionJob>(jobs, SampleRetention, job => job.RunAsync(CancellationToken.None));
        Add<RemoteSessionRetentionJob>(jobs, RemoteSessionRetention, job => job.RunAsync(CancellationToken.None));
    }

    // Hangfire passes its own shutdown token in place of CancellationToken.None.
    private static void Add<TJob>(IRecurringJobManager jobs, string id, Expression<Func<TJob, Task>> run) =>
        jobs.AddOrUpdate(id, run, Schedules[id], new RecurringJobOptions { TimeZone = TimeZoneInfo.Utc });
}
