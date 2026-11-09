package com.runovahq.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.runovahq.app.design.BadgeTone
import com.runovahq.app.design.RunovaBadge
import com.runovahq.app.design.RunovaCard
import com.runovahq.app.design.RunovaChip
import com.runovahq.app.design.RunovaEmptyState
import com.runovahq.app.design.ChipTone
import com.runovahq.app.design.RunovaSectionTitle
import com.runovahq.app.design.RunovaIcons
import com.runovahq.app.design.RunovaListRow
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaTokens
import com.runovahq.app.design.RunovaScreen
import com.runovahq.app.design.RunovaTopBar
import com.runovahq.app.design.RunovaType
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.ContainerLogsView
import uniffi.runova_ffi.ContainerView
import uniffi.runova_ffi.DeployServerView
import uniffi.runova_ffi.ProblemSeverity
import uniffi.runova_ffi.ProblemView
import uniffi.runova_ffi.ServerDetailView
import uniffi.runova_ffi.StackView

data class DeployIntents(
    val openServer: (String) -> Unit = {},
    val closeServer: () -> Unit = {},
    val openLogs: (String) -> Unit = {},
    val closeLogs: () -> Unit = {},
    val containerAction: (String, String) -> Unit = { _, _ -> },
    val stackAction: (String, String) -> Unit = { _, _ -> },
    val redeploy: (String) -> Unit = {},
)

/** A server or its logs take over the whole device screen. */
@Composable
fun DeployOverlay(view: AppView, intents: DeployIntents): Boolean {
    val logs = view.deploy.logs
    if (logs != null) {
        LogsScreen(logs, intents)
        return true
    }
    val server = view.deploy.server ?: return false
    ServerScreen(server, view.error, intents)
    return true
}

@Composable
fun DeployTab(view: AppView, intents: DeployIntents) {
    when {
        view.deploy.servers.isEmpty() && view.deploy.loading -> LoadingRows()
        view.deploy.servers.isEmpty() -> RunovaEmptyState(
            RunovaIcons.Deploy,
            "No servers yet",
            "Add one in Deploy on this computer.",
        )
        else -> LazyColumn(contentPadding = PaddingValues(16.dp)) {
            items(view.deploy.servers, key = { it.id }) { ServerRow(it, intents) }
        }
    }
}

@Composable
private fun ServerRow(server: DeployServerView, intents: DeployIntents) {
    RunovaListRow(
        title = server.name,
        detail = server.problem ?: server.host,
        icon = RunovaIcons.Server,
        iconTone = if (server.online) BadgeTone.Primary else BadgeTone.Warning,
        onClick = { intents.openServer(server.id) },
        trailing = {
            RunovaBadge(server.stateLabel, if (server.online) BadgeTone.Success else BadgeTone.Warning, dot = true)
        },
    )
}

private fun LazyListScope.heading(text: String) {
    item(key = "h/$text") {
        RunovaSectionTitle(text, Modifier.padding(top = 14.dp, bottom = 4.dp))
    }
}

@Composable
private fun ServerScreen(server: ServerDetailView, error: String?, intents: DeployIntents) {
    RunovaScreen(server.name, onBack = intents.closeServer) {
        when {
            server.loading -> LoadingRows()
            server.unreachable != null -> RunovaEmptyState(RunovaIcons.Warning, server.unreachable!!, "")
            else -> LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(16.dp)) {
                if (server.problems.isNotEmpty()) {
                    heading("Problems")
                    items(server.problems, key = { "p/${it.id}" }) { ProblemRow(it) }
                }
                heading("Containers")
                items(server.containers, key = { "c/${it.id}" }) { ContainerRow(it, intents) }
                heading("Apps")
                items(server.stacks, key = { "s/${it.id}" }) { StackRow(it, intents) }
                server.backup?.let { backup ->
                    heading("Backups")
                    item(key = "backup") {
                        RunovaCard(Modifier.fillMaxWidth()) {
                            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                RunovaText(backup.label, style = RunovaType.label)
                                if (backup.detail.isNotEmpty()) {
                                    RunovaText(
                                        backup.detail,
                                        style = RunovaType.small,
                                        color = if (backup.failed) RunovaTheme.colors.destructive else RunovaTheme.colors.mutedForeground,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
        error?.let {
            RunovaText(it, Modifier.padding(16.dp), RunovaType.small, RunovaTheme.colors.destructive)
        }
    }
}

@Composable
private fun ProblemRow(problem: ProblemView) {
    RunovaListRow(
        title = problem.title,
        detail = problem.detail,
        icon = RunovaIcons.Warning,
        iconTone = if (problem.severity == ProblemSeverity.CRITICAL) BadgeTone.Danger else BadgeTone.Warning,
        trailing = {
            if (problem.severity == ProblemSeverity.CRITICAL) {
                RunovaBadge("Critical", BadgeTone.Danger, dot = true)
            } else {
                RunovaBadge("Warning")
            }
        },
    )
}

@Composable
private fun ActionChip(label: String, name: String, onClick: () -> Unit) {
    val icon = when (label) {
        "Restart" -> RunovaIcons.Refresh
        "Stop" -> RunovaIcons.Stop
        else -> RunovaIcons.Play
    }
    RunovaChip(
        label,
        onClick,
        Modifier.semantics { contentDescription = "$label $name" },
        icon = icon,
        tone = if (label == "Stop") ChipTone.Danger else ChipTone.Soft,
    )
}

@Composable
private fun ContainerRow(container: ContainerView, intents: DeployIntents) {
    RunovaListRow(
        title = container.name,
        detail = container.status,
        icon = RunovaIcons.Deploy,
        iconTone = when {
            container.healthy == false -> BadgeTone.Danger
            container.running -> BadgeTone.Success
            else -> BadgeTone.Neutral
        },
        onClick = { intents.openLogs(container.id) },
        trailing = {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                if (container.running) {
                    ActionChip("Restart", container.name) { intents.containerAction(container.id, "restart") }
                    ActionChip("Stop", container.name) { intents.containerAction(container.id, "stop") }
                } else {
                    ActionChip("Start", container.name) { intents.containerAction(container.id, "start") }
                }
            }
        },
    )
}

@Composable
private fun StackRow(stack: StackView, intents: DeployIntents) {
    RunovaListRow(
        title = stack.name,
        detail = stack.detail,
        icon = RunovaIcons.Deploy,
        trailing = {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (stack.canRedeploy) RunovaChip("Redeploy", { intents.redeploy(stack.id) }, icon = RunovaIcons.Bolt, tone = ChipTone.Primary)
                ActionChip("Restart", stack.name) { intents.stackAction(stack.id, "restart") }
            }
        },
    )
}

@Composable
private fun LogsScreen(logs: ContainerLogsView, intents: DeployIntents) {
    val theme = RunovaTokens.Terminal
    RunovaScreen(logs.name, onBack = intents.closeLogs) {
        if (logs.loading) {
            LoadingRows()
        } else {
            LazyColumn(Modifier.fillMaxSize().background(theme.background), contentPadding = PaddingValues(10.dp)) {
                items(logs.lines) { line ->
                    BasicText(
                        line.text,
                        style = RunovaType.mono.copy(color = if (line.error) theme.red else theme.foreground),
                    )
                }
            }
        }
    }
}
