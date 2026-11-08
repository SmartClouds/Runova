package com.runovahq.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.runovahq.app.design.BadgeTone
import com.runovahq.app.design.ButtonKind
import com.runovahq.app.design.RunovaBadge
import com.runovahq.app.design.RunovaButton
import com.runovahq.app.design.RunovaCard
import com.runovahq.app.design.RunovaChip
import com.runovahq.app.design.RunovaEmptyState
import com.runovahq.app.design.RunovaIcons
import com.runovahq.app.design.RunovaListRow
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaTokens
import com.runovahq.app.design.RunovaTopBar
import com.runovahq.app.design.RunovaType
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.JobLogView
import uniffi.runova_ffi.MonitorSource
import uniffi.runova_ffi.MonitorState
import uniffi.runova_ffi.MonitorView
import uniffi.runova_ffi.PipelineRunDetailView
import uniffi.runova_ffi.PipelineRunState
import uniffi.runova_ffi.PipelinesStatusView
import uniffi.runova_ffi.WorkflowView

data class MonitoringIntents(
    val open: (String) -> Unit = {},
    val close: () -> Unit = {},
    val check: (String) -> Unit = {},
    val setPaused: (String, MonitorSource, Boolean) -> Unit = { _, _, _ -> },
)

data class PipelineIntents(
    val openRun: (Long) -> Unit = {},
    val closeRun: () -> Unit = {},
    val openJob: (Long) -> Unit = {},
    val closeJob: () -> Unit = {},
    val dispatch: (Long) -> Unit = {},
    val cancel: (Long) -> Unit = {},
)

private fun monitorBadge(state: MonitorState) = when (state) {
    MonitorState.UP -> "Up" to BadgeTone.Success
    MonitorState.DEGRADED -> "Degraded" to BadgeTone.Warning
    MonitorState.DOWN -> "Down" to BadgeTone.Warning
    MonitorState.PAUSED -> "Paused" to BadgeTone.Neutral
    MonitorState.UNKNOWN -> "Unknown" to BadgeTone.Neutral
}

private fun runTone(state: PipelineRunState) = when (state) {
    PipelineRunState.SUCCESS -> BadgeTone.Success
    PipelineRunState.FAILED -> BadgeTone.Warning
    PipelineRunState.RUNNING -> BadgeTone.Primary
    PipelineRunState.QUEUED, PipelineRunState.OTHER -> BadgeTone.Neutral
}

private fun LazyListScope.groupTitle(text: String) {
    item(key = "h/$text") {
        RunovaText(
            text,
            Modifier.padding(top = 12.dp, bottom = 4.dp),
            RunovaType.caption,
            RunovaTheme.colors.mutedForeground,
        )
    }
}

/** The open monitor takes over the screen. */
@Composable
fun MonitorOverlay(view: AppView, intents: MonitoringIntents): Boolean {
    val all = view.monitoring.local + view.monitoring.cloud
    val monitor = all.firstOrNull { it.id == view.monitoring.open } ?: return false
    MonitorScreen(monitor, intents)
    return true
}

@Composable
fun MonitoringTab(view: AppView, intents: MonitoringIntents) {
    val screen = view.monitoring
    if (screen.local.isEmpty() && screen.cloud.isEmpty() && screen.loading) {
        LoadingRows()
        return
    }
    LazyColumn(contentPadding = PaddingValues(16.dp)) {
        groupTitle("On this computer")
        screen.localNote?.let { note ->
            item(key = "note") {
                RunovaText(note, style = RunovaType.small, color = RunovaTheme.colors.mutedForeground)
            }
        }
        items(screen.local, key = { "l/${it.id}" }) { MonitorRow(it, intents) }
        groupTitle("Runova Cloud")
        items(screen.cloud, key = { "c/${it.id}" }) { MonitorRow(it, intents) }
    }
}

@Composable
private fun MonitorRow(monitor: MonitorView, intents: MonitoringIntents) {
    val (text, tone) = monitorBadge(monitor.state)
    RunovaListRow(
        title = monitor.name,
        detail = monitor.detail ?: monitor.latencyLabel,
        icon = RunovaIcons.Monitoring,
        onClick = { intents.open(monitor.id) },
        trailing = { RunovaBadge(text, tone) },
    )
}

@Composable
private fun MonitorScreen(monitor: MonitorView, intents: MonitoringIntents) {
    val colors = RunovaTheme.colors
    val (text, tone) = monitorBadge(monitor.state)
    Column(Modifier.fillMaxSize()) {
        RunovaTopBar(monitor.name, onBack = intents.close)
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            RunovaBadge(text, tone)
            monitor.detail?.let { RunovaText(it, color = colors.mutedForeground) }
            RunovaCard(Modifier.fillMaxWidth()) {
                Row {
                    Stat("Latency", monitor.latencyLabel, Modifier.weight(1f))
                    Stat("Uptime, 24 hours", monitor.uptimeLabel, Modifier.weight(1f))
                }
            }
            if (monitor.samples.isNotEmpty()) LatencyBars(monitor.samples)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (monitor.canCheck) {
                    RunovaButton("Check now", onClick = { intents.check(monitor.id) }, Modifier.weight(1f))
                }
                if (monitor.canPause) {
                    RunovaButton(
                        if (monitor.paused) "Resume" else "Pause",
                        onClick = { intents.setPaused(monitor.id, monitor.source, !monitor.paused) },
                        Modifier.weight(1f),
                        kind = ButtonKind.Soft,
                    )
                }
            }
        }
    }
}

@Composable
private fun Stat(label: String, value: String?, modifier: Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        RunovaText(label, style = RunovaType.caption, color = RunovaTheme.colors.mutedForeground)
        RunovaText(value ?: "None", style = RunovaType.title)
    }
}

@Composable
private fun LatencyBars(samples: List<Double>) {
    val colors = RunovaTheme.colors
    val highest = samples.maxOrNull()?.takeIf { it > 0 } ?: 1.0
    Row(
        Modifier.fillMaxWidth().height(80.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        samples.forEach { value ->
            Box(Modifier.weight(1f).fillMaxHeight(), contentAlignment = Alignment.BottomCenter) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .fillMaxHeight((value / highest).toFloat().coerceIn(0.02f, 1f))
                        .clip(RoundedCornerShape(2.dp))
                        .background(colors.primary),
                )
            }
        }
    }
}

/** A run or its log takes over the screen. */
@Composable
fun PipelineOverlay(view: AppView, intents: PipelineIntents): Boolean {
    val log = view.pipelines.log
    if (log != null) {
        JobLogScreen(log, intents)
        return true
    }
    val run = view.pipelines.run ?: return false
    RunScreen(run, intents)
    return true
}

@Composable
fun PipelinesTab(view: AppView, intents: PipelineIntents) {
    val status = view.pipelines.status
    when {
        view.selectedProject == null -> RunovaEmptyState(
            RunovaIcons.Pipelines,
            "Choose a project",
            "Pick one in Projects to see its pipelines.",
        )
        status == null -> LoadingRows()
        status.problem != null -> RunovaEmptyState(RunovaIcons.Warning, status.problem!!, "")
        status.workflows.isEmpty() -> RunovaEmptyState(
            RunovaIcons.Pipelines,
            "No workflows",
            "This repository has no GitHub Actions workflows.",
        )
        else -> WorkflowList(status, intents)
    }
}

@Composable
private fun WorkflowList(status: PipelinesStatusView, intents: PipelineIntents) {
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        items(status.workflows, key = { it.id }) { WorkflowCard(it, intents) }
    }
}

@Composable
private fun WorkflowCard(workflow: WorkflowView, intents: PipelineIntents) {
    val colors = RunovaTheme.colors
    RunovaCard(Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                RunovaText(workflow.name, Modifier.weight(1f), RunovaType.title)
                if (workflow.canDispatch) RunovaChip("Run", { intents.dispatch(workflow.id) })
            }
            val run = workflow.run
            if (run == null) {
                RunovaText("Never run", style = RunovaType.small, color = colors.mutedForeground)
            } else {
                RunovaListRow(
                    title = run.title,
                    detail = "#${run.number} on ${run.branch}",
                    icon = RunovaIcons.Git,
                    onClick = { intents.openRun(run.id) },
                    trailing = {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                            RunovaBadge(run.stateLabel, runTone(run.state))
                            if (run.canCancel) RunovaChip("Cancel", { intents.cancel(run.id) })
                        }
                    },
                )
            }
        }
    }
}

@Composable
private fun RunScreen(run: PipelineRunDetailView, intents: PipelineIntents) {
    Column(Modifier.fillMaxSize()) {
        RunovaTopBar("Run", onBack = intents.closeRun)
        if (run.loading) {
            LoadingRows()
        } else {
            LazyColumn(contentPadding = PaddingValues(16.dp)) {
                items(run.jobs, key = { it.id }) { job ->
                    RunovaListRow(
                        title = job.name,
                        icon = RunovaIcons.Pipelines,
                        onClick = { intents.openJob(job.id) },
                        trailing = { RunovaBadge(job.stateLabel, runTone(job.state)) },
                    )
                }
            }
        }
    }
}

@Composable
private fun JobLogScreen(log: JobLogView, intents: PipelineIntents) {
    val theme = RunovaTokens.Terminal
    Column(Modifier.fillMaxSize()) {
        RunovaTopBar(log.name, onBack = intents.closeJob)
        if (log.truncated) {
            RunovaText(
                "Only the end of this log is shown.",
                Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                RunovaType.small,
                RunovaTheme.colors.mutedForeground,
            )
        }
        if (log.loading) {
            LoadingRows()
        } else {
            LazyColumn(Modifier.fillMaxSize().background(theme.background), contentPadding = PaddingValues(10.dp)) {
                items(log.lines) { line ->
                    BasicText(
                        line.text,
                        style = RunovaType.mono.copy(color = if (line.error) theme.red else theme.foreground),
                    )
                }
            }
        }
    }
}
