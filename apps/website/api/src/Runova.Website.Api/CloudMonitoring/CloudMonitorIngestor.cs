using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.Options;
using Npgsql;
using NpgsqlTypes;
using Runova.Monitoring.Contracts;
using Runova.Monitoring.Contracts.Grpc;
using Runova.Monitoring.Core.Health;
using Runova.Website.Api.Monitoring;
using Runova.Website.Core.Monitoring;
using Runova.Website.Data;
using Runova.Website.Data.Monitoring;

namespace Runova.Website.Api.CloudMonitoring;

/// <summary>
/// Stores what the nodes found (E55). Each result is kept once (its UUIDv7 is the key), goes into
/// its hour, and moves the monitor through the two-sample rule. A problem the rule confirms is
/// checked once more from another node, in another region when there is one, before an incident
/// opens; with no other node, or no answer in <see cref="CloudMonitorRules.ConfirmTimeout"/>, the
/// first node's word stands. A result is taken only from the node the monitor is on, or for a
/// second opinion from the node that was asked, and only for the monitor's current definition.
/// </summary>
internal sealed class CloudMonitorIngestor(
    AppDbContext db,
    INodeBus bus,
    MonitorAssigner assigner,
    CloudMonitorNotifier notifier,
    IOptions<MonitoringOptions> options,
    TimeProvider time) : IResultIngestor
{
    public const int ProblemMax = 500;

    private const string Ok = "ok";
    private const string Problem = "problem";

    public async Task IngestAsync(CheckResultBatch batch, CancellationToken ct = default)
    {
        if (batch.Results.Count == 0)
        {
            return;
        }

        var ids = batch.Results.Select(r => r.MonitorId).Distinct().ToArray();
        var changes = new List<MonitorChange>();
        var confirms = new List<(long NodeId, Guid ConfirmId, CloudMonitor Monitor)>();
        IReadOnlyList<Data.Dependencies.UserNotification> created;
        List<long> touched;
        List<long> strays;
        long? assignmentVersion;

        await using (var transaction = await db.Database.BeginTransactionAsync(ct))
        {
            var statuses = await db.CloudMonitorStatuses
                .FromSql($"SELECT * FROM \"CloudMonitorStatuses\" WHERE \"MonitorId\" = ANY({ids}) ORDER BY \"MonitorId\" FOR UPDATE")
                .ToDictionaryAsync(s => s.MonitorId, ct);
            var monitors = await db.CloudMonitors.AsNoTracking().Where(m => ids.Contains(m.Id)).ToDictionaryAsync(m => m.Id, ct);
            var nodes = await db.MonitoringNodes.AsNoTracking()
                .Where(n => n.Status != NodeStatuses.Revoked && n.Status != NodeStatuses.Pending)
                .ToListAsync(ct);
            var region = nodes.ToDictionary(n => n.Id, n => n.Region);
            assignmentVersion = nodes.FirstOrDefault(n => n.Id == batch.NodeId)?.AssignmentVersion;
            // Monitors the node checks but should not (deleted, paused or moved while it was away).
            strays = [.. batch.Results
                .Where(r => string.IsNullOrEmpty(r.ConfirmId)
                    && (!monitors.TryGetValue(r.MonitorId, out var m) || m.Paused || statuses.GetValueOrDefault(r.MonitorId)?.NodeId != batch.NodeId))
                .Select(r => r.MonitorId).Distinct()];

            var accepted = batch.Results.Where(r => Accepts(r, batch.NodeId, monitors, statuses)).ToList();
            var stored = await InsertSamplesAsync(accepted, batch.NodeId, ct);
            var fresh = accepted.Where(r => stored.Contains(r.Id)).OrderBy(r => r.CheckedAt).ThenBy(r => r.Id).ToList();
            await AddToHoursAsync(fresh, ct);

            var now = time.GetUtcNow();
            var eligible = nodes.Select(n => CloudMonitorMapper.ToSlot(n, MonitorAssigner.Eligible(n, now - options.Value.OfflineAfter))).ToList();
            foreach (var result in fresh)
            {
                await ApplyAsync(result, batch.NodeId, monitors[result.MonitorId], statuses[result.MonitorId], region, eligible, now, changes, confirms, ct);
            }

            created = await notifier.AddAsync(changes, ct);
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            touched = [.. fresh.Select(r => r.MonitorId).Distinct()];
        }

        if (strays.Count > 0 && assignmentVersion is { } version)
        {
            var delta = new AssignmentDelta { AssignmentVersion = version };
            delta.Removed.AddRange(strays);
            await bus.SendAsync(batch.NodeId, new ServerMessage { Delta = delta }, ct);
        }

        foreach (var (nodeId, confirmId, monitor) in confirms)
        {
            await bus.SendAsync(nodeId, new ServerMessage
            {
                Confirm = new ConfirmCheck { ConfirmId = confirmId.ToString(), Monitor = assigner.Definition(monitor) },
            }, ct);
        }

        await notifier.PushAsync(created, touched, ct);
    }

    private static bool Accepts(
        CheckResultRecord result, long nodeId, Dictionary<long, CloudMonitor> monitors, Dictionary<long, CloudMonitorStatus> statuses)
    {
        if (!monitors.TryGetValue(result.MonitorId, out var monitor) || !statuses.TryGetValue(result.MonitorId, out var status)
            || monitor.Paused || result.MonitorVersion != monitor.DefinitionVersion || !HealthStates.TryParse(result.State, out _))
        {
            return false;
        }

        // A second opinion counts only from the node that was asked, for the question still open.
        return string.IsNullOrEmpty(result.ConfirmId)
            ? status.NodeId == nodeId
            : status.ConfirmNodeId == nodeId && Guid.TryParse(result.ConfirmId, out var asked) && asked == status.ConfirmId;
    }

    private async Task ApplyAsync(
        CheckResultRecord result,
        long nodeId,
        CloudMonitor monitor,
        CloudMonitorStatus status,
        Dictionary<long, string> region,
        IReadOnlyList<NodeSlot> eligible,
        DateTimeOffset now,
        List<MonitorChange> changes,
        List<(long NodeId, Guid ConfirmId, CloudMonitor Monitor)> confirms,
        CancellationToken ct)
    {
        // Accepts let only known states through.
        _ = HealthStates.TryParse(result.State, out var state);
        var isProblem = HealthStates.IsProblem(state);
        var problem = Clip(result.Problem);
        if (status.LastCheckedAt is null || result.CheckedAt >= status.LastCheckedAt)
        {
            status.State = result.State;
            status.LastCheckedAt = result.CheckedAt;
            status.LatencyMs = result.LatencyMs;
            status.HttpStatus = result.HttpStatus;
            status.Problem = problem;
            status.LastNodeId = nodeId;
            status.LastRegion = region.GetValueOrDefault(nodeId);
        }

        if (!string.IsNullOrEmpty(result.ConfirmId))
        {
            if (isProblem)
            {
                await OpenAsync(monitor, status, status.SuspectSince ?? result.CheckedAt, status.SuspectState ?? result.State, status.SuspectProblem ?? problem,
                    status.NodeId, nodeId, region, changes, ct);
            }
            else
            {
                // The other node found it fine: the first one's view was its own.
                status.Confirmed = Ok;
                status.Streak = 0;
                status.Pending = false;
            }

            ClearConfirm(status);
            return;
        }

        var step = HealthTransitions.Next(new HealthTrack(Verdict(status.Confirmed), status.Streak, status.Pending), state);
        status.Confirmed = step.Track.Confirmed switch
        {
            HealthVerdict.Ok => Ok,
            HealthVerdict.Problem => Problem,
            _ => null,
        };
        status.Streak = step.Track.Streak;
        status.Pending = step.Track.Pending;

        if (step.Opened)
        {
            if (status.OpenIncidentId is not null)
            {
                return;
            }

            if (MonitorDistribution.PickConfirmer(eligible, nodeId) is { } confirmer)
            {
                status.ConfirmId = Guid.CreateVersion7(now);
                status.ConfirmNodeId = confirmer;
                status.ConfirmRequestedAt = now;
                status.SuspectSince = result.CheckedAt;
                status.SuspectState = result.State;
                status.SuspectProblem = problem;
                confirms.Add((confirmer, status.ConfirmId.Value, monitor));
            }
            else
            {
                await OpenAsync(monitor, status, result.CheckedAt, result.State, problem, nodeId, null, region, changes, ct);
            }

            return;
        }

        if (status.ConfirmId is not null)
        {
            if (step.Resolved)
            {
                // It came back before anyone else looked: there is nothing to tell.
                ClearConfirm(status);
            }
            else if (isProblem && status.ConfirmRequestedAt is { } asked && now - asked > CloudMonitorRules.ConfirmTimeout)
            {
                await OpenAsync(monitor, status, status.SuspectSince ?? result.CheckedAt, status.SuspectState ?? result.State, status.SuspectProblem ?? problem,
                    nodeId, null, region, changes, ct);
                ClearConfirm(status);
            }

            return;
        }

        if (step.Resolved && status.OpenIncidentId is { } openId)
        {
            var incident = db.CloudMonitorIncidents.Local.FirstOrDefault(i => i.Id == openId)
                ?? await db.CloudMonitorIncidents.SingleAsync(i => i.Id == openId, ct);
            incident.ResolvedAt = result.CheckedAt;
            status.OpenIncidentId = null;
            changes.Add(new MonitorChange(monitor, incident, Down: false, region.GetValueOrDefault(nodeId), null));
        }
    }

    private async Task OpenAsync(
        CloudMonitor monitor,
        CloudMonitorStatus status,
        DateTimeOffset at,
        string state,
        string? problem,
        long? seenBy,
        long? confirmedBy,
        Dictionary<long, string> region,
        List<MonitorChange> changes,
        CancellationToken ct)
    {
        if (status.OpenIncidentId is not null)
        {
            return;
        }

        var incident = new CloudMonitorIncident
        {
            MonitorId = monitor.Id,
            OpenedAt = at,
            State = state,
            Problem = problem,
            NodeId = seenBy,
            ConfirmedByNodeId = confirmedBy,
        };
        db.CloudMonitorIncidents.Add(incident);
        // Saved at once (inside the batch's transaction) for its id, so a recovery later in the batch finds it.
        await db.SaveChangesAsync(ct);
        status.OpenIncidentId = incident.Id;
        changes.Add(new MonitorChange(
            monitor,
            incident,
            Down: true,
            seenBy is { } s ? region.GetValueOrDefault(s) : null,
            confirmedBy is { } c ? region.GetValueOrDefault(c) : null));
    }

    private static void ClearConfirm(CloudMonitorStatus status)
    {
        status.ConfirmId = null;
        status.ConfirmNodeId = null;
        status.ConfirmRequestedAt = null;
        status.SuspectSince = null;
        status.SuspectState = null;
        status.SuspectProblem = null;
    }

    private static HealthVerdict? Verdict(string? confirmed) => confirmed switch
    {
        Ok => HealthVerdict.Ok,
        Problem => HealthVerdict.Problem,
        _ => null,
    };

    private static string? Clip(string? text) =>
        string.IsNullOrWhiteSpace(text) ? null : text.Length <= ProblemMax ? text : text[..ProblemMax];

    /// <summary>Inserts the samples in one statement and returns the ids that were new.</summary>
    private async Task<HashSet<Guid>> InsertSamplesAsync(List<CheckResultRecord> results, long nodeId, CancellationToken ct)
    {
        if (results.Count == 0)
        {
            return [];
        }

        var connection = (NpgsqlConnection)db.Database.GetDbConnection();
        await using var command = connection.CreateCommand();
        command.Transaction = (NpgsqlTransaction?)db.Database.CurrentTransaction?.GetDbTransaction();
        command.CommandText = """
            INSERT INTO "CloudMonitorSamples" ("Id", "MonitorId", "CheckedAt", "State", "LatencyMs", "HttpStatus", "NodeId", "Problem", "Confirm")
            SELECT r.id, r.monitor, r.at, r.state, r.latency, r.http, @node, r.problem, r.confirm
            FROM unnest(@ids, @monitors, @at, @states, @latency, @http, @problems, @confirm)
                AS r(id, monitor, at, state, latency, http, problem, confirm)
            ON CONFLICT ("Id") DO NOTHING
            RETURNING "Id"
            """;
        command.Parameters.Add(new NpgsqlParameter("node", NpgsqlDbType.Bigint) { Value = nodeId });
        command.Parameters.Add(new NpgsqlParameter("ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = results.Select(r => r.Id).ToArray() });
        command.Parameters.Add(new NpgsqlParameter("monitors", NpgsqlDbType.Array | NpgsqlDbType.Bigint) { Value = results.Select(r => r.MonitorId).ToArray() });
        command.Parameters.Add(new NpgsqlParameter("at", NpgsqlDbType.Array | NpgsqlDbType.TimestampTz) { Value = results.Select(r => r.CheckedAt.UtcDateTime).ToArray() });
        command.Parameters.Add(new NpgsqlParameter("states", NpgsqlDbType.Array | NpgsqlDbType.Text) { Value = results.Select(r => r.State).ToArray() });
        command.Parameters.Add(new NpgsqlParameter("latency", NpgsqlDbType.Array | NpgsqlDbType.Integer) { Value = results.Select(r => r.LatencyMs).ToArray() });
        command.Parameters.Add(new NpgsqlParameter("http", NpgsqlDbType.Array | NpgsqlDbType.Integer) { Value = results.Select(r => r.HttpStatus).ToArray() });
        command.Parameters.Add(new NpgsqlParameter("problems", NpgsqlDbType.Array | NpgsqlDbType.Text) { Value = results.Select(r => Clip(r.Problem)).ToArray() });
        command.Parameters.Add(new NpgsqlParameter("confirm", NpgsqlDbType.Array | NpgsqlDbType.Boolean) { Value = results.Select(r => !string.IsNullOrEmpty(r.ConfirmId)).ToArray() });

        var stored = new HashSet<Guid>();
        await using var reader = await command.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            stored.Add(reader.GetGuid(0));
        }

        return stored;
    }

    /// <summary>Adds the new results to their hours; an hour that exists already grows.</summary>
    private async Task AddToHoursAsync(List<CheckResultRecord> results, CancellationToken ct)
    {
        foreach (var hour in results.GroupBy(r => (r.MonitorId, Hour: CloudMonitorRules.HourOf(r.CheckedAt))))
        {
            var checks = hour.Count();
            var failures = hour.Count(r => HealthStates.TryParse(r.State, out var s) && HealthStates.IsProblem(s));
            var warnings = hour.Count(r => r.State == "warn");
            var latencies = hour.Where(r => r.LatencyMs is >= 0).Select(r => r.LatencyMs!.Value).ToList();
            long sum = latencies.Sum(l => (long)l);
            var count = latencies.Count;
            var max = latencies.Count == 0 ? 0 : latencies.Max();
            await db.Database.ExecuteSqlAsync(
                $"""
                INSERT INTO "CloudMonitorHours" ("MonitorId", "Hour", "Checks", "Failures", "Warnings", "LatencySumMs", "LatencyCount", "LatencyMaxMs")
                VALUES ({hour.Key.MonitorId}, {hour.Key.Hour}, {checks}, {failures}, {warnings}, {sum}, {count}, {max})
                ON CONFLICT ("MonitorId", "Hour") DO UPDATE SET
                    "Checks" = "CloudMonitorHours"."Checks" + EXCLUDED."Checks",
                    "Failures" = "CloudMonitorHours"."Failures" + EXCLUDED."Failures",
                    "Warnings" = "CloudMonitorHours"."Warnings" + EXCLUDED."Warnings",
                    "LatencySumMs" = "CloudMonitorHours"."LatencySumMs" + EXCLUDED."LatencySumMs",
                    "LatencyCount" = "CloudMonitorHours"."LatencyCount" + EXCLUDED."LatencyCount",
                    "LatencyMaxMs" = GREATEST("CloudMonitorHours"."LatencyMaxMs", EXCLUDED."LatencyMaxMs")
                """,
                ct);
        }
    }
}
