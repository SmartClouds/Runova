using System.Diagnostics;
using System.Globalization;
using Hangfire;
using Hangfire.States;
using Hangfire.Storage;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Api.Jobs;
using Runova.Website.Api.Media;
using Runova.Website.Api.Releases;
using Runova.Website.Data;
using static Runova.Website.Api.Health.HealthStatuses;

namespace Runova.Website.Api.Health;

/// <summary>
/// What the website depends on: PostgreSQL and its migrations, the Hangfire job server and its
/// recurring jobs, the stored desktop release, the media folder and its disk, GitHub's API, and
/// the site container when <c>Website:InternalSiteUrl</c> names it. Every check only reads.
/// </summary>
internal static class RunovaHealthChecks
{
    /// <summary>The HTTP client of the site check. It never follows a redirect.</summary>
    public const string SiteClient = "runova-health-site";

    public const string SiteUrlSetting = "Website:InternalSiteUrl";

    private const double SlowMilliseconds = 1000;
    private const double DiskWarnPercent = 10;
    private const double DiskFailPercent = 2;
    private static readonly TimeSpan _heartbeatWindow = TimeSpan.FromMinutes(2);

    public static IReadOnlyList<HealthCheckDefinition> For(IConfiguration configuration)
    {
        var checks = new List<HealthCheckDefinition>
        {
            new("postgres:connection", "datastore", "Ran SELECT 1 on PostgreSQL", Fail,
                "Check that the db container is running and that ConnectionStrings__Default names its host, database and user.",
                PostgresAsync)
            {
                OutputWhenFailing = "PostgreSQL does not answer, so the API can not serve the site's content or take any write.",
            },
            new("migrations:pending", "datastore", "Compared the migrations in this build with the ones applied to the database", Fail,
                "Database__MigrateOnStart=true applies them when the API starts. Otherwise run: dotnet Runova.Website.Api.dll admin migrate",
                MigrationsAsync),
            new("hangfire:servers", "component", "Read the Hangfire job servers and their heartbeats from PostgreSQL", Fail,
                "The job server runs inside the API process. Check the api container's logs for Hangfire errors and restart it.",
                JobServersAsync),
            new("hangfire:recurring", "component", "Read the recurring jobs from Hangfire's storage", Fail,
                "Open /hangfire as an Admin to see each job's last run and its error.",
                RecurringJobsAsync),
            new("releases:latest", "component", "Read the latest stored desktop release", Warn,
                "The releases-sync job stores the latest release from GitHub every 15 minutes. See github:api and hangfire:recurring.",
                LatestReleaseAsync),
            new("media:storage", "system", "Looked for the media folder", Fail,
                "Mount the media volume at Website__MediaPath. The image sets it to /var/lib/runova/media.",
                MediaFolderAsync),
            new("disk:free", "system", "Read the free space of the disk that holds the media folder", Fail,
                "Free some space on the server (docker image prune removes old images) or grow the disk.",
                DiskAsync),
            // GitHub only feeds the releases sync, and the site keeps the stored release while it is away.
            new("github:api", "http", "Asked api.github.com for the rate limit the releases sync runs under", Warn,
                "The releases sync reads the latest release from api.github.com. The download page keeps the stored release until GitHub answers again.",
                GitHubAsync),
        };

        if (configuration[SiteUrlSetting] is { Length: > 0 } siteUrl)
        {
            checks.Add(new("site:http", "http", $"Sent GET {siteUrl} to the site container", Fail,
                $"Check that the web container is running and that {SiteUrlSetting.Replace(":", "__", StringComparison.Ordinal)} points at it.",
                (services, cancel) => SiteAsync(services, siteUrl, cancel)));
        }

        return checks;
    }

    private static async Task<IReadOnlyList<HealthCheckEntry>> PostgresAsync(IServiceProvider services, CancellationToken cancel)
    {
        var db = services.GetRequiredService<AppDbContext>();
        var watch = Stopwatch.StartNew();
        await db.Database.ExecuteSqlRawAsync("SELECT 1", cancel);
        var ms = Milliseconds(watch);
        return [ms > SlowMilliseconds
            ? new HealthCheckEntry
            {
                Status = Warn,
                ObservedValue = ms,
                ObservedUnit = "ms",
                Output = $"PostgreSQL took {Number(ms)} ms to answer SELECT 1",
                Runova = new HealthCheckDetails { Hint = "Look for long-running queries or a busy server: SELECT * FROM pg_stat_activity" },
            }
            : new HealthCheckEntry { Status = Pass, ObservedValue = ms, ObservedUnit = "ms" }];
    }

    private static async Task<IReadOnlyList<HealthCheckEntry>> MigrationsAsync(IServiceProvider services, CancellationToken cancel)
    {
        var db = services.GetRequiredService<AppDbContext>();
        var known = db.Database.GetMigrations().ToList();
        var applied = (await db.Database.GetAppliedMigrationsAsync(cancel)).ToList();
        var pending = known.Except(applied).ToList();
        var unknown = applied.Except(known).ToList();
        if (pending.Count > 0)
        {
            return [new HealthCheckEntry
            {
                Status = Fail,
                ObservedValue = pending.Count,
                ObservedUnit = "migrations",
                Output = $"{Count(pending.Count, "migration")} not applied: {string.Join(", ", pending)}",
            }];
        }

        if (unknown.Count > 0)
        {
            return [new HealthCheckEntry
            {
                Status = Warn,
                ObservedValue = 0,
                ObservedUnit = "migrations",
                Output = $"The database has {Count(unknown.Count, "migration")} this build does not know: {string.Join(", ", unknown)}",
                Runova = new HealthCheckDetails
                {
                    Detail = "A newer release migrated the database, and this older one runs against it.",
                    Hint = "Deploy the release that matches the database.",
                },
            }];
        }

        return [new HealthCheckEntry { Status = Pass, ObservedValue = 0, ObservedUnit = "migrations" }];
    }

    private static async Task<IReadOnlyList<HealthCheckEntry>> JobServersAsync(IServiceProvider services, CancellationToken cancel)
    {
        var storage = services.GetRequiredService<JobStorage>();
        var now = services.GetRequiredService<TimeProvider>().GetUtcNow().UtcDateTime;
        var servers = await Task.Run(() => storage.GetMonitoringApi().Servers(), cancel);
        var alive = servers.Count(s => s.Heartbeat is { } beat && now - beat <= _heartbeatWindow);
        if (alive > 0)
        {
            return [new HealthCheckEntry { Status = Pass, ObservedValue = alive, ObservedUnit = "servers" }];
        }

        return [new HealthCheckEntry
        {
            Status = Fail,
            ObservedValue = 0,
            ObservedUnit = "servers",
            Output = servers.Count == 0
                ? "No Hangfire job server is running"
                : $"No Hangfire job server sent a heartbeat in the last {_heartbeatWindow.TotalMinutes.ToString(CultureInfo.InvariantCulture)} minutes ({servers.Count.ToString(CultureInfo.InvariantCulture)} registered)",
            Runova = new HealthCheckDetails
            {
                Detail = "Without a job server scheduled news is not published, the releases sync stops and the purge jobs do not run. The site keeps serving what is stored.",
            },
        }];
    }

    private static async Task<IReadOnlyList<HealthCheckEntry>> RecurringJobsAsync(IServiceProvider services, CancellationToken cancel)
    {
        var storage = services.GetRequiredService<JobStorage>();
        return await Task.Run(() =>
        {
            List<RecurringJobDto> jobs;
            using (var connection = storage.GetConnection())
            {
                jobs = connection.GetRecurringJobs();
            }

            return (IReadOnlyList<HealthCheckEntry>)[.. RecurringJobRegistry.Schedules.Keys.Select(id => RecurringJob(storage, id, jobs.Find(j => j.Id == id)))];
        }, cancel);
    }

    private static HealthCheckEntry RecurringJob(JobStorage storage, string id, RecurringJobDto? job)
    {
        if (job is null)
        {
            return new HealthCheckEntry
            {
                ComponentId = id,
                Status = Warn,
                Output = $"The recurring job {id} is not registered",
                Runova = new HealthCheckDetails { Hint = "The API registers its recurring jobs when it starts. Restart the api container once PostgreSQL answers." },
            };
        }

        if (job.Error is { Length: > 0 } error)
        {
            return new HealthCheckEntry
            {
                ComponentId = id,
                Status = Fail,
                Output = $"Hangfire can not schedule {id}: {error.Split('\n', 2)[0].Trim()}",
                Runova = new HealthCheckDetails
                {
                    Detail = $"Hangfire stores an error for the recurring job {id}, so it does not run until that is fixed.",
                    Stack = error,
                    Hint = "This is usually a job class or method that was renamed. RecurringJobRegistry rewrites every job when the API starts.",
                },
            };
        }

        if (job.LastJobState == FailedState.StateName)
        {
            var failure = job.LastJobId is { } lastJobId
                ? storage.GetMonitoringApi().JobDetails(lastJobId)?.History.FirstOrDefault(h => h.StateName == FailedState.StateName)
                : null;
            var message = failure?.Data.TryGetValue("ExceptionMessage", out var text) == true ? text : failure?.Reason;
            return new HealthCheckEntry
            {
                ComponentId = id,
                Status = Warn,
                Output = $"The last run of {id} (job {job.LastJobId}) failed" + (message is { Length: > 0 } ? $": {message}" : ""),
                Runova = new HealthCheckDetails
                {
                    ErrorCode = failure?.Data.TryGetValue("ExceptionType", out var type) == true ? type : null,
                    Detail = $"Hangfire retried job {job.LastJobId} of {id} and gave up. The job runs again on its schedule ({job.Cron}).",
                    Stack = failure?.Data.TryGetValue("ExceptionDetails", out var details) == true ? details : null,
                },
            };
        }

        return new HealthCheckEntry { ComponentId = id, Status = Pass };
    }

    private static async Task<IReadOnlyList<HealthCheckEntry>> LatestReleaseAsync(IServiceProvider services, CancellationToken cancel)
    {
        var db = services.GetRequiredService<AppDbContext>();
        var stored = await db.Releases.AsNoTracking().AnyAsync(cancel);
        return [stored
            ? new HealthCheckEntry { Status = Pass }
            : new HealthCheckEntry { Status = Warn, Output = "No desktop release is stored yet, so the download page has nothing to offer" }];
    }

    private static Task<IReadOnlyList<HealthCheckEntry>> MediaFolderAsync(IServiceProvider services, CancellationToken cancel)
    {
        var folder = services.GetRequiredService<MediaStorage>().Folder;
        IReadOnlyList<HealthCheckEntry> entries = [Directory.Exists(folder)
            ? new HealthCheckEntry { Status = Pass }
            : new HealthCheckEntry
            {
                Status = Fail,
                Output = $"The media folder {folder} does not exist",
                Runova = new HealthCheckDetails { Detail = "Uploaded images are stored there and served from it at /media/. Uploads fail and every image is missing until it is back." },
            }];
        return Task.FromResult(entries);
    }

    private static Task<IReadOnlyList<HealthCheckEntry>> DiskAsync(IServiceProvider services, CancellationToken cancel)
    {
        var folder = services.GetRequiredService<MediaStorage>().Folder;
        var drive = new DriveInfo(Directory.Exists(folder) ? folder : Path.GetPathRoot(folder) ?? folder);
        var percent = drive.TotalSize > 0 ? Math.Round(100.0 * drive.AvailableFreeSpace / drive.TotalSize, 1) : 0;
        var status = percent < DiskFailPercent ? Fail : percent < DiskWarnPercent ? Warn : Pass;
        var gigabytes = Math.Round(drive.AvailableFreeSpace / (1024.0 * 1024 * 1024), 1);
        IReadOnlyList<HealthCheckEntry> entries = [new HealthCheckEntry
        {
            ComponentId = "media",
            Status = status,
            ObservedValue = percent,
            ObservedUnit = "percent",
            Output = status == Pass ? null : $"Only {Number(percent)}% disk space left ({Number(gigabytes)} GB)",
        }];
        return Task.FromResult(entries);
    }

    private static async Task<IReadOnlyList<HealthCheckEntry>> GitHubAsync(IServiceProvider services, CancellationToken cancel)
    {
        var github = services.GetRequiredService<GitHubReleasesClient>();
        var watch = Stopwatch.StartNew();
        var limit = await github.GetRateLimitAsync(cancel);
        var ms = Milliseconds(watch);
        if (limit.Remaining > 0)
        {
            return [new HealthCheckEntry { Status = Pass, ObservedValue = ms, ObservedUnit = "ms" }];
        }

        var token = services.GetRequiredService<IConfiguration>()["GitHub:Token"] is { Length: > 0 };
        return [new HealthCheckEntry
        {
            Status = Warn,
            ObservedValue = ms,
            ObservedUnit = "ms",
            Output = $"GitHub's rate limit of {limit.Limit} calls an hour is used up until {RunovaHealthReporter.Format(limit.ResetsAt)}",
            Runova = new HealthCheckDetails
            {
                ErrorCode = "RateLimited",
                Hint = token
                    ? "Something else uses the same GitHub token. Give the website a token of its own (GITHUB_TOKEN)."
                    : "Set GITHUB_TOKEN to a GitHub token with read access to public repositories. Anonymous calls get 60 an hour.",
            },
        }];
    }

    private static async Task<IReadOnlyList<HealthCheckEntry>> SiteAsync(IServiceProvider services, string siteUrl, CancellationToken cancel)
    {
        var client = services.GetRequiredService<IHttpClientFactory>().CreateClient(SiteClient);
        var watch = Stopwatch.StartNew();
        using var response = await client.GetAsync(new Uri(siteUrl), HttpCompletionOption.ResponseHeadersRead, cancel);
        var ms = Milliseconds(watch);
        var code = (int)response.StatusCode;
        var status = code >= 500 ? Fail : code >= 400 || ms > SlowMilliseconds ? Warn : Pass;
        return [new HealthCheckEntry
        {
            Status = status,
            ObservedValue = ms,
            ObservedUnit = "ms",
            Output = status == Pass ? null
                : code >= 400 ? $"The site answered {code.ToString(CultureInfo.InvariantCulture)} {response.ReasonPhrase}"
                : $"The site took {Number(ms)} ms to answer",
            Runova = status == Pass ? null : new HealthCheckDetails { ErrorCode = code >= 400 ? "HTTP " + code.ToString(CultureInfo.InvariantCulture) : null },
        }];
    }

    private static double Milliseconds(Stopwatch watch) => Math.Round(watch.Elapsed.TotalMilliseconds);

    private static string Number(double value) => value.ToString(CultureInfo.InvariantCulture);

    private static string Count(int count, string noun) =>
        count.ToString(CultureInfo.InvariantCulture) + " " + noun + (count == 1 ? "" : "s");
}
