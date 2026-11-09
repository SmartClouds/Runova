package com.runovahq.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
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
import com.runovahq.app.design.ChipTone
import com.runovahq.app.design.RunovaIconTile
import com.runovahq.app.design.RunovaSectionTitle
import com.runovahq.app.design.RunovaIcons
import com.runovahq.app.design.RunovaListRow
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTextField
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaToggle
import com.runovahq.app.design.RunovaTokens
import com.runovahq.app.design.RunovaScreen
import com.runovahq.app.design.RunovaTopBar
import com.runovahq.app.design.RunovaType
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.DispatchFormView
import uniffi.runova_ffi.JobLogView
import uniffi.runova_ffi.WorkflowInputKind
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
    val submitDispatch: (Map<String, String>) -> Unit = {},
    val closeDispatch: () -> Unit = {},
    val cancel: (Long) -> Unit = {},
)

private fun monitorBadge(state: MonitorState) = when (state) {
    MonitorState.UP -> "Up" to BadgeTone.Success
    MonitorState.DEGRADED -> "Degraded" to BadgeTone.Warning
    MonitorState.DOWN -> "Down" to BadgeTone.Danger
    MonitorState.PAUSED -> "Paused" to BadgeTone.Neutral
    MonitorState.UNKNOWN -> "Unknown" to BadgeTone.Neutral
}

private fun runTone(state: PipelineRunState) = when (state) {
    PipelineRunState.SUCCESS -> BadgeTone.Success
    PipelineRunState.FAILED -> BadgeTone.Danger
    PipelineRunState.RUNNING -> BadgeTone.Primary
    PipelineRunState.QUEUED, PipelineRunState.OTHER -> BadgeTone.Neutral
}

private fun LazyListScope.groupTitle(text: String) {
    item(key = "h/$text") {
        RunovaSectionTitle(text, Modifier.padding(top = 14.dp, bottom = 4.dp))
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
        icon = if (monitor.source == MonitorSource.CLOUD) RunovaIcons.Cloud else RunovaIcons.Monitoring,
        iconTone = tone,
        onClick = { intents.open(monitor.id) },
        trailing = { RunovaBadge(text, tone, dot = true) },
    )
}

@Composable
private fun MonitorScreen(monitor: MonitorView, intents: MonitoringIntents) {
    val colors = RunovaTheme.colors
    val (text, tone) = monitorBadge(monitor.state)
    RunovaScreen(monitor.name, onBack = intents.close) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            RunovaBadge(text, tone, dot = true)
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
                    RunovaButton("Check now", onClick = { intents.check(monitor.id) }, Modifier.weight(1f), icon = RunovaIcons.Refresh)
                }
                if (monitor.canPause) {
                    RunovaButton(
                        if (monitor.paused) "Resume" else "Pause",
                        onClick = { intents.setPaused(monitor.id, monitor.source, !monitor.paused) },
                        Modifier.weight(1f),
                        kind = ButtonKind.Soft,
                        icon = if (monitor.paused) RunovaIcons.Play else RunovaIcons.Stop,
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
    view.pipelines.dispatchForm?.let {
        DispatchForm(it, intents)
        return true
    }
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
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                RunovaIconTile(RunovaIcons.Pipelines, workflow.run?.let { runTone(it.state) } ?: BadgeTone.Neutral)
                RunovaText(workflow.name, Modifier.weight(1f), RunovaType.title)
                if (workflow.canDispatch) RunovaChip("Run", { intents.dispatch(workflow.id) }, icon = RunovaIcons.Play, tone = ChipTone.Primary)
            }
            val run = workflow.run
            if (run == null) {
                RunovaText("Never run", style = RunovaType.small, color = colors.mutedForeground)
            } else {
                RunovaListRow(
                    title = run.title,
                    detail = "#${run.number} on ${run.branch}",
                    onClick = { intents.openRun(run.id) },
                    flat = true,
                    trailing = {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                            RunovaBadge(run.stateLabel, runTone(run.state), dot = true)
                            if (run.canCancel) RunovaChip("Cancel", { intents.cancel(run.id) }, icon = RunovaIcons.Ban, tone = ChipTone.Danger)
                        }
                    },
                )
            }
        }
    }
}

@Composable
private fun DispatchForm(form: DispatchFormView, intents: PipelineIntents) {
    val colors = RunovaTheme.colors
    val values = remember(form.workflowId) {
        mutableStateMapOf<String, String>().apply {
            form.inputs.forEach { put(it.name, it.defaultValue) }
        }
    }
    RunovaScreen(form.name, onBack = intents.closeDispatch) {
        LazyColumn(
            Modifier.weight(1f),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            items(form.inputs, key = { it.name }) { input ->
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    RunovaText(if (input.required) "${input.name} (required)" else input.name, style = RunovaType.label)
                    if (input.description.isNotEmpty()) {
                        RunovaText(input.description, style = RunovaType.small, color = colors.mutedForeground)
                    }
                    val value = values[input.name].orEmpty()
                    when (input.kind) {
                        WorkflowInputKind.TEXT -> RunovaTextField(value, { values[input.name] = it }, input.name)
                        WorkflowInputKind.TOGGLE -> RunovaToggle(
                            value == "true",
                            { values[input.name] = it.toString() },
                            input.name,
                        )
                        WorkflowInputKind.CHOICE -> Row(
                            Modifier.horizontalScroll(rememberScrollState()),
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            input.options.forEach { option ->
                                if (option == value) {
                                    RunovaBadge(option, BadgeTone.Primary)
                                } else {
                                    RunovaChip(option, { values[input.name] = option })
                                }
                            }
                        }
                    }
                }
            }
        }
        form.error?.let { RunovaText(it, Modifier.padding(horizontal = 16.dp), RunovaType.small, colors.destructive) }
        RunovaButton(
            "Run workflow",
            onClick = { intents.submitDispatch(values.toMap()) },
            Modifier.fillMaxWidth().padding(16.dp),
            icon = RunovaIcons.Play,
        )
    }
}

@Composable
private fun RunScreen(run: PipelineRunDetailView, intents: PipelineIntents) {
    RunovaScreen("Run", onBack = intents.closeRun) {
        if (run.loading) {
            LoadingRows()
        } else {
            LazyColumn(contentPadding = PaddingValues(16.dp)) {
                items(run.jobs, key = { it.id }) { job ->
                    RunovaListRow(
                        title = job.name,
                        icon = RunovaIcons.Logs,
                        iconTone = runTone(job.state),
                        onClick = { intents.openJob(job.id) },
                        trailing = { RunovaBadge(job.stateLabel, runTone(job.state), dot = true) },
                    )
                }
            }
        }
    }
}

@Composable
private fun JobLogScreen(log: JobLogView, intents: PipelineIntents) {
    val theme = RunovaTokens.Terminal
    RunovaScreen(log.name, onBack = intents.closeJob) {
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
