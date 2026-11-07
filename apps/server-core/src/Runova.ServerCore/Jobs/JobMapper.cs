using Riok.Mapperly.Abstractions;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Jobs;

[Mapper]
internal static partial class JobMapper
{
    /// <summary>
    /// A job as the app sees it. A running job's log count comes from its live log, not the row,
    /// and only a running job can still be cancelled.
    /// </summary>
    [MapperIgnoreSource(nameof(Job.LogLines))]
    [MapPropertyFromSource(nameof(JobInfo.Cancellable), Use = nameof(IsCancellable))]
    [MapProperty(nameof(Job.CreatedAt), nameof(JobInfo.CreatedAtUnixMs))]
    [MapProperty(nameof(Job.RequestedByName), nameof(JobInfo.RequestedBy))]
    [MapProperty(nameof(Job.FinishedAt), nameof(JobInfo.FinishedAtUnixMs))]
    public static partial JobInfo ToInfo(Job row, long logLines);

    /// <summary>A job that has just started: running, with nothing logged and no outcome yet.</summary>
    [MapValue(nameof(Job.State), JobState.Running)]
    [MapperIgnoreTarget(nameof(Job.FinishedAt))]
    [MapperIgnoreTarget(nameof(Job.ExitCode))]
    [MapperIgnoreTarget(nameof(Job.Error))]
    [MapperIgnoreTarget(nameof(Job.LogLines))]
    public static partial Job ToRow(JobRequest request, Guid id, long createdAt);

    private static bool IsCancellable(Job row) => row.Cancellable && row.State == JobState.Running;
}
