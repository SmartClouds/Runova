using System.Collections.Concurrent;
using System.Globalization;
using System.Net.Sockets;
using System.Reflection;
using Npgsql;

namespace Runova.Website.Api.Health;

/// <summary>Runs one check against the services of a scope of its own.</summary>
internal delegate Task<IReadOnlyList<HealthCheckEntry>> HealthCheckRun(IServiceProvider services, CancellationToken cancellationToken);

/// <summary>
/// One key of the report, such as <c>postgres:connection</c>. <paramref name="Attempt"/> says what
/// the check does, for the detail of a failure. An exception or a timeout makes the check
/// <paramref name="FailStatus"/>, which is <c>warn</c> for a dependency the site can do without.
/// </summary>
internal sealed record HealthCheckDefinition(
    string Key,
    string ComponentType,
    string Attempt,
    string FailStatus,
    string? Hint,
    HealthCheckRun Run)
{
    /// <summary>The report's top-level <c>output</c> while this check fails: the whole service is down.</summary>
    public string? OutputWhenFailing { get; init; }
}

/// <summary>
/// Builds the runova-health/1 report. Every check runs at once, each with its own
/// <see cref="CheckTimeout"/>, and the report is kept for <see cref="CacheFor"/> so a burst of
/// requests runs the checks once. Error text goes through <see cref="HealthRedaction"/>.
/// </summary>
internal sealed partial class RunovaHealthReporter(
    IServiceScopeFactory scopes,
    IConfiguration configuration,
    IHostEnvironment environment,
    TimeProvider time,
    HealthRedaction redaction,
    ILogger<RunovaHealthReporter> logger)
{
    public const string ServiceId = "runova-website";
    public const string Description = "Runova website (runovahq.com)";
    public const int StackLimit = 8 * 1024;

    public static readonly TimeSpan CheckTimeout = TimeSpan.FromSeconds(2);
    public static readonly TimeSpan CacheFor = TimeSpan.FromSeconds(5);

    /// <summary>
    /// The assembly's informational version: the <c>Version</c> MSBuild property (the Dockerfile
    /// passes the release's), then <c>+</c> and the commit when the build knew it.
    /// </summary>
    private static readonly string? _informationalVersion =
        typeof(RunovaHealthReporter).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;

    public static string? Version { get; } = _informationalVersion?.Split('+')[0] is { Length: > 0 } version ? version : null;

    public static string? ReleaseId { get; } = _informationalVersion?.Split('+') is [_, { Length: > 0 } revision, ..] ? revision : null;

    private readonly IReadOnlyList<HealthCheckDefinition> _checks = RunovaHealthChecks.For(configuration);
    private readonly ConcurrentDictionary<string, DateTimeOffset> _failingSince = new();
    private readonly Lock _gate = new();
    private Task<RunovaHealthReport>? _current;
    private DateTimeOffset _currentStarted;

    /// <summary>The report of the last <see cref="CacheFor"/>, or a new one. Never throws.</summary>
    public Task<RunovaHealthReport> GetAsync()
    {
        lock (_gate)
        {
            var now = time.GetUtcNow();
            if (_current is null || (_current.IsCompleted && now - _currentStarted >= CacheFor))
            {
                _currentStarted = now;
                _current = BuildAsync();
            }

            return _current;
        }
    }

    /// <summary>The report for when building one failed: no checks, only what went wrong.</summary>
    public RunovaHealthReport Broken(Exception exception) =>
        Report(HealthStatuses.Fail, $"The healthcheck could not build its report: {exception.GetType().Name}", new Dictionary<string, IReadOnlyList<HealthCheckEntry>>());

    private async Task<RunovaHealthReport> BuildAsync()
    {
        try
        {
            var results = await Task.WhenAll(_checks.Select(RunAsync));
            var checks = new Dictionary<string, IReadOnlyList<HealthCheckEntry>>();
            string? output = null;
            for (var i = 0; i < _checks.Count; i++)
            {
                checks[_checks[i].Key] = results[i];
                if (_checks[i].OutputWhenFailing is { } whole && results[i].Any(e => e.Status == HealthStatuses.Fail))
                {
                    output ??= whole;
                }
            }

            var status = HealthStatuses.Worst(results.SelectMany(entries => entries).Select(e => e.Status));
            return Report(status, output, checks);
        }
        catch (Exception e)
        {
            LogReportFailed(logger, e);
            return Broken(e);
        }
    }

    private RunovaHealthReport Report(string status, string? output, IReadOnlyDictionary<string, IReadOnlyList<HealthCheckEntry>> checks) =>
        new(
            status,
            Version,
            ReleaseId,
            ServiceId,
            Description,
            Format(time.GetUtcNow()),
            output,
            checks,
            new RunovaHealthReport.Target(RunovaHealthReport.Protocol, environment.EnvironmentName.ToLowerInvariant(), Environment.MachineName));

    private async Task<IReadOnlyList<HealthCheckEntry>> RunAsync(HealthCheckDefinition check)
    {
        var ran = time.GetUtcNow();
        using var timeout = new CancellationTokenSource(CheckTimeout, time);
        IReadOnlyList<HealthCheckEntry> entries;
        var scope = scopes.CreateAsyncScope();
        // On its own thread, so a check that blocks can not hold up the others or the timeout.
        var run = Task.Run(() => check.Run(scope.ServiceProvider, timeout.Token), CancellationToken.None);
        _ = DisposeWhenDoneAsync(run, scope);
        try
        {
            entries = await run.WaitAsync(timeout.Token);
        }
        catch (Exception) when (timeout.IsCancellationRequested)
        {
            entries = [TimedOut(check)];
        }
        catch (Exception e)
        {
            entries = [Failed(check, e)];
        }

        return [.. entries.Select(entry => Complete(check, entry, ran))];
    }

    // A check that timed out may still be using its scope, so the scope lives until the check ends.
    private static async Task DisposeWhenDoneAsync(Task run, AsyncServiceScope scope)
    {
        try
        {
            await run;
        }
        catch (Exception)
        {
            // Reported by RunAsync, or ended after its timeout, when nobody is waiting for it.
        }
        finally
        {
            await scope.DisposeAsync();
        }
    }

    /// <summary>Fills in the type and time, and for a check that does not pass, its details and since when.</summary>
    private HealthCheckEntry Complete(HealthCheckDefinition check, HealthCheckEntry entry, DateTimeOffset ran)
    {
        entry = entry with { ComponentType = entry.ComponentType ?? check.ComponentType, Time = Format(ran) };
        var key = check.Key + "|" + entry.ComponentId;
        if (entry.Status == HealthStatuses.Pass)
        {
            _failingSince.TryRemove(key, out _);
            return entry;
        }

        var output = redaction.Redact(entry.Output ?? $"{check.Key} is {entry.Status}");
        var since = _failingSince.GetOrAdd(key, ran);
        if (since == ran)
        {
            LogNotPassing(logger, check.Key, entry.ComponentId, entry.Status, output);
        }

        var details = entry.Runova ?? new HealthCheckDetails();
        return entry with
        {
            Output = output,
            Runova = details with
            {
                Detail = redaction.Redact(details.Detail ?? $"{check.Attempt}. {output}"),
                Stack = details.Stack is { } stack ? Truncate(redaction.Redact(stack), StackLimit) : null,
                Hint = details.Hint ?? check.Hint,
                Since = Format(since),
            },
        };
    }

    private static HealthCheckEntry TimedOut(HealthCheckDefinition check)
    {
        var seconds = CheckTimeout.TotalSeconds.ToString(CultureInfo.InvariantCulture);
        return new HealthCheckEntry
        {
            Status = HealthStatuses.Fail,
            Output = $"Timed out after {seconds} s",
            Runova = new HealthCheckDetails
            {
                ErrorCode = "Timeout",
                Detail = $"{check.Attempt}. It did not finish within {seconds} seconds, so the healthcheck stopped waiting for it.",
            },
        };
    }

    private static HealthCheckEntry Failed(HealthCheckDefinition check, Exception exception)
    {
        var messages = string.Join(" ", Chain(exception).Select(e => e.Message).Distinct());
        return new HealthCheckEntry
        {
            Status = check.FailStatus,
            Output = FirstLine(exception.Message),
            Runova = new HealthCheckDetails
            {
                ErrorCode = ErrorCode(exception),
                Detail = $"{check.Attempt}. It failed with {exception.GetType().Name}: {messages}",
                Stack = exception.ToString(),
            },
        };
    }

    /// <summary>The most telling code in the chain: a socket error, a PostgreSQL SQLSTATE, an HTTP status, or the type.</summary>
    private static string ErrorCode(Exception exception)
    {
        foreach (var e in Chain(exception))
        {
            switch (e)
            {
                case SocketException socket:
                    return socket.SocketErrorCode.ToString();
                case PostgresException postgres:
                    return postgres.SqlState;
                case HttpRequestException { StatusCode: { } status }:
                    return "HTTP " + ((int)status).ToString(CultureInfo.InvariantCulture);
            }
        }

        return exception.GetType().Name;
    }

    private static IEnumerable<Exception> Chain(Exception exception)
    {
        for (Exception? e = exception; e is not null; e = e.InnerException)
        {
            yield return e;
        }
    }

    private static string FirstLine(string text) => text.Split('\n', 2)[0].Trim();

    private static string Truncate(string text, int limit) => text.Length <= limit ? text : text[..limit];

    public static string Format(DateTimeOffset value) =>
        value.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Health check {Check} {ComponentId} is {Status}: {Output}")]
    private static partial void LogNotPassing(ILogger logger, string check, string? componentId, string status, string output);

    [LoggerMessage(Level = LogLevel.Error, Message = "The Runova healthcheck could not build its report")]
    private static partial void LogReportFailed(ILogger logger, Exception exception);
}
