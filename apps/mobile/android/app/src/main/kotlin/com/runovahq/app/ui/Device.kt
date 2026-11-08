package com.runovahq.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.runovahq.app.design.BadgeTone
import com.runovahq.app.design.MonoFamily
import com.runovahq.app.design.RunovaBadge
import com.runovahq.app.design.RunovaBottomBar
import com.runovahq.app.design.RunovaButton
import com.runovahq.app.design.RunovaChip
import com.runovahq.app.design.RunovaEmptyState
import com.runovahq.app.design.RunovaIcons
import com.runovahq.app.design.RunovaListRow
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTextField
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaTokens
import com.runovahq.app.design.RunovaTopBar
import com.runovahq.app.design.RunovaType
import com.runovahq.app.design.TabItem
import uniffi.runova_ffi.AgentState
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.ConnectionView
import uniffi.runova_ffi.FrameView
import uniffi.runova_ffi.LineView
import uniffi.runova_ffi.ProjectView
import uniffi.runova_ffi.RunView
import uniffi.runova_ffi.Section
import uniffi.runova_ffi.TerminalItem
import uniffi.runova_ffi.TerminalProcessView
import uniffi.runova_ffi.TerminalView

val DeviceTabs = listOf(
    TabItem("projects", "Projects", RunovaIcons.Folder),
    TabItem("clis", "CLIs", RunovaIcons.Terminal),
    TabItem("git", "Git", RunovaIcons.Git),
    TabItem("status", "Status", RunovaIcons.Monitoring),
    TabItem("more", "More", RunovaIcons.More),
)

/** Reached from More, so the bar stays at five. */
private val MoreSections = listOf(
    TabItem("vault", "Vault", RunovaIcons.Vault),
    TabItem("deploy", "Deploy", RunovaIcons.Deploy),
    TabItem("monitoring", "Monitoring", RunovaIcons.Monitoring),
    TabItem("pipelines", "Pipelines", RunovaIcons.Pipelines),
    TabItem("notifications", "Notifications", RunovaIcons.Notifications),
)

/** The width of a JetBrains Mono cell, in ems. */
private const val CELL_WIDTH_EM = 0.6f
private const val LINE_HEIGHT_EM = 1.25f
private const val SMALLEST_CELL_DP = 7f
private const val LARGEST_CELL_DP = 13f

/** Far enough to reach the live screen from anywhere in the history. */
private const val BACK_TO_LIVE = -1_000_000

private data class TerminalKey(val label: String, val data: String)

private val TerminalKeys = listOf(
    TerminalKey("Esc", "\u001b"),
    TerminalKey("Tab", "\t"),
    TerminalKey("Ctrl C", "\u0003"),
    TerminalKey("Ctrl D", "\u0004"),
    TerminalKey("Up", "\u001b[A"),
    TerminalKey("Down", "\u001b[B"),
    TerminalKey("Left", "\u001b[D"),
    TerminalKey("Right", "\u001b[C"),
    TerminalKey("Enter", "\r"),
)

@Composable
fun DeviceShell(
    view: AppView,
    connection: ConnectionView,
    tab: String,
    onTab: (String) -> Unit,
    intents: AppIntents,
) {
    val section = (DeviceTabs + MoreSections).firstOrNull { it.id == tab }?.id ?: "projects"
    val terminal = view.terminal
    val onShow = when {
        terminal != null -> null
        section == "clis" -> Section.CLIS
        section == "git" -> Section.GIT
        section == "status" -> Section.STATUS
        section == "vault" -> Section.VAULT
        section == "deploy" -> Section.DEPLOY
        section == "monitoring" -> Section.MONITORING
        section == "pipelines" -> Section.PIPELINES
        section == "notifications" -> Section.NOTIFICATIONS
        else -> null
    }
    DisposableEffect(onShow) {
        intents.openSection(onShow)
        onDispose { if (onShow != null) intents.openSection(null) }
    }
    if (terminal != null) {
        TerminalScreen(terminal, view.terminalProcesses, view.error, intents)
        return
    }
    if (
        GitOverlay(view, intents) ||
        StatusOverlay(view, intents.status) ||
        VaultOverlay(view, intents.vault) ||
        DeployOverlay(view, intents.deploy) ||
        (section == "monitoring" && MonitorOverlay(view, intents.monitoring)) ||
        PipelineOverlay(view, intents.pipelines)
    ) {
        return
    }
    Column(Modifier.fillMaxSize()) {
        DeviceTopBar(connection, intents)
        Box(Modifier.weight(1f)) {
            when (section) {
                "clis" -> ClisScreen(view, intents)
                "git" -> Column(Modifier.fillMaxSize()) {
                    Box(Modifier.weight(1f)) { GitChangesScreen(view, intents.git) }
                    view.error?.let { ErrorLine(it) }
                }
                "status" -> StatusTab(view, intents.status)
                "vault" -> Column(Modifier.fillMaxSize()) {
                    Box(Modifier.weight(1f)) { VaultTab(view, intents.vault) }
                    view.error?.let { ErrorLine(it) }
                }
                "deploy" -> DeployTab(view, intents.deploy)
                "monitoring" -> MonitoringTab(view, intents.monitoring)
                "pipelines" -> Column(Modifier.fillMaxSize()) {
                    Box(Modifier.weight(1f)) { PipelinesTab(view, intents.pipelines) }
                    view.error?.let { ErrorLine(it) }
                }
                "notifications" -> InboxTab(view, intents.notifications, onTab, showTitle = false)
                "more" -> MoreScreen(onTab, intents.forgetThisPhone)
                else -> ProjectsScreen(view, intents, onTab)
            }
        }
        view.notice?.let { NoticeBar(it, intents.dismissNotice) }
        RunovaBottomBar(DeviceTabs, if (MoreSections.any { it.id == section }) "more" else section, onTab)
    }
}

@Composable
private fun MoreScreen(onTab: (String) -> Unit, onForget: () -> Unit) {
    LazyColumn(contentPadding = PaddingValues(16.dp)) {
        items(MoreSections, key = { it.id }) { item ->
            RunovaListRow(title = item.title, icon = item.icon, onClick = { onTab(item.id) })
        }
        item(key = "forget") {
            RunovaListRow(title = "Forget this phone", icon = RunovaIcons.Shield, onClick = onForget)
        }
    }
}

@Composable
private fun NoticeBar(message: String, onDismiss: () -> Unit) {
    val colors = RunovaTheme.colors
    RunovaText(
        message,
        Modifier
            .fillMaxWidth()
            .background(colors.secondary)
            .clickable(role = Role.Button, onClick = onDismiss)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        style = RunovaType.small,
        color = colors.foreground,
    )
}

@Composable
private fun DeviceTopBar(connection: ConnectionView, intents: AppIntents) {
    val colors = RunovaTheme.colors
    RunovaTopBar(
        connection.systemName,
        onBack = intents.disconnect,
        trailing = {
            RunovaBadge(
                if (connection.direct == true) "Direct" else "Relay",
                if (connection.direct == true) BadgeTone.Primary else BadgeTone.Warning,
                Modifier.padding(end = 8.dp),
            )
        },
    )
    connection.safetyCode?.let {
        RunovaText(
            "Safety code $it",
            Modifier.padding(horizontal = 16.dp),
            style = RunovaType.small,
            color = colors.mutedForeground,
        )
    }
}

@Composable
private fun ProjectsScreen(view: AppView, intents: AppIntents, onTab: (String) -> Unit) {
    when {
        view.projects.isEmpty() && view.projectsLoading -> LoadingRows()
        view.projects.isEmpty() -> RunovaEmptyState(
            RunovaIcons.Folder,
            "No projects yet",
            "Add one in Runova on this computer.",
        )
        else -> LazyColumn(contentPadding = PaddingValues(16.dp)) {
            items(view.projects, key = { it.id }) { project ->
                ProjectRow(project) {
                    intents.selectProject(project.id)
                    onTab("clis")
                }
            }
        }
    }
}

@Composable
private fun ProjectRow(project: ProjectView, onClick: () -> Unit) {
    RunovaListRow(
        title = project.name,
        detail = project.tags.joinToString(", ").ifEmpty { null },
        icon = RunovaIcons.Folder,
        onClick = onClick,
    )
}

private fun statusBadge(status: AgentState) = when (status) {
    AgentState.NEEDS_INPUT -> "Needs input" to BadgeTone.Warning
    AgentState.WORKING -> "Working" to BadgeTone.Primary
    AgentState.DONE -> "Done" to BadgeTone.Success
    AgentState.IDLE -> "Idle" to BadgeTone.Neutral
    AgentState.EXITED -> "Exited" to BadgeTone.Neutral
}

@Composable
private fun ClisScreen(view: AppView, intents: AppIntents) {
    val selected = view.selectedProject
    val project = view.projects.firstOrNull { it.id == selected }
    val shown = if (selected == null) view.terminals else view.terminals.filter { it.projectId == selected }
    Column(Modifier.fillMaxSize()) {
        if (project != null) {
            RunovaChip(project.name, { intents.selectProject(null) }, Modifier.padding(start = 16.dp, top = 8.dp))
        }
        when {
            shown.isEmpty() && view.terminalsLoading -> LoadingRows()
            shown.isEmpty() -> RunovaEmptyState(
                RunovaIcons.Terminal,
                "No CLIs running",
                "Start one in Runova on this computer and it shows up here.",
            )
            else -> LazyColumn(contentPadding = PaddingValues(16.dp)) {
                items(shown, key = { it.sessionId }) {
                    // The chip above already names the project.
                    TerminalRow(it, if (project == null) view.projects else emptyList(), intents)
                }
            }
        }
        view.error?.let { ErrorLine(it) }
    }
}

@Composable
private fun ErrorLine(message: String) {
    RunovaText(
        message,
        Modifier.padding(16.dp),
        style = RunovaType.small,
        color = RunovaTheme.colors.destructive,
    )
}

@Composable
private fun TerminalRow(item: TerminalItem, projects: List<ProjectView>, intents: AppIntents) {
    RunovaListRow(
        title = item.title,
        detail = projects.firstOrNull { it.id == item.projectId }?.name ?: item.cliId,
        icon = RunovaIcons.Terminal,
        onClick = { intents.openTerminal(item.sessionId) },
        trailing = {
            item.status?.let {
                val (text, tone) = statusBadge(it)
                RunovaBadge(text, tone)
            }
        },
    )
}

@Composable
fun TerminalScreen(
    terminal: TerminalView,
    processes: List<TerminalProcessView>,
    error: String?,
    intents: AppIntents,
) {
    var showProcesses by remember(terminal.sessionId) { mutableStateOf(false) }
    Column(Modifier.fillMaxSize()) {
        RunovaTopBar(
            terminal.title,
            onBack = intents.closeTerminal,
            trailing = {
                RunovaChip(
                    if (showProcesses) "Screen" else "Processes",
                    {
                        if (!showProcesses) intents.loadProcesses(terminal.sessionId)
                        showProcesses = !showProcesses
                    },
                    Modifier.padding(end = 8.dp),
                )
            },
        )
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (showProcesses) {
                ProcessList(processes)
            } else {
                TerminalBody(terminal.frame, intents.terminalScroll)
                if (terminal.scrolled) {
                    RunovaChip(
                        "Back to live",
                        { intents.terminalScroll(BACK_TO_LIVE) },
                        Modifier.align(Alignment.BottomEnd).padding(12.dp),
                    )
                }
            }
        }
        error?.let { ErrorLine(it) }
        if (terminal.ended) {
            RunovaText(
                terminal.endReason ?: "This terminal has ended.",
                Modifier.padding(16.dp),
                color = RunovaTheme.colors.mutedForeground,
            )
        } else {
            TerminalInput(intents.terminalInput)
        }
    }
}

@Composable
private fun ProcessList(processes: List<TerminalProcessView>) {
    if (processes.isEmpty()) {
        RunovaEmptyState(RunovaIcons.Server, "No processes", "Nothing is running in this terminal right now.")
        return
    }
    LazyColumn(contentPadding = PaddingValues(16.dp)) {
        items(processes) {
            RunovaListRow(title = it.name, detail = "${it.cpuLabel} CPU, ${it.memoryLabel}", icon = RunovaIcons.Server)
        }
    }
}

@Composable
private fun TerminalInput(onInput: (String) -> Unit) {
    var text by remember { mutableStateOf("") }
    Column(Modifier.fillMaxWidth().padding(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(
            Modifier.horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            TerminalKeys.forEach { key -> RunovaChip(key.label, { onInput(key.data) }) }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            RunovaTextField(text, { text = it }, "Type a command", Modifier.weight(1f))
            RunovaButton("Send", onClick = {
                onInput(text + "\r")
                text = ""
            }, icon = RunovaIcons.Send)
        }
    }
}

private fun paint(color: UInt?, fallback: Color) =
    color?.let { Color(0xFF000000L or it.toLong()) } ?: fallback

private fun annotated(line: LineView, foreground: Color, background: Color, cursor: Color): AnnotatedString =
    buildAnnotatedString {
        line.runs.forEach { run -> withStyle(styleOf(run, foreground, background, cursor)) { append(run.text) } }
    }

private fun styleOf(run: RunView, foreground: Color, background: Color, cursor: Color): SpanStyle {
    var ink = paint(run.fg, foreground)
    var fill = run.bg?.let { paint(it, background) }
    if (run.inverse) {
        val swapped = fill ?: background
        fill = ink
        ink = swapped
    }
    if (run.cursor) {
        fill = cursor
        ink = background
    }
    return SpanStyle(
        color = ink,
        background = fill ?: Color.Unspecified,
        fontWeight = if (run.bold) FontWeight.Bold else null,
        fontStyle = if (run.italic) FontStyle.Italic else null,
        textDecoration = if (run.underline) TextDecoration.Underline else null,
    )
}

/** Fits the computer's screen to the phone. The computer's own size is never changed. */
@Composable
private fun TerminalBody(frame: FrameView, onScroll: (Int) -> Unit) {
    val theme = RunovaTokens.Terminal
    BoxWithConstraints(Modifier.fillMaxSize().background(theme.background).clipToBounds().padding(6.dp)) {
        if (frame.rows.toInt() == 0) return@BoxWithConstraints
        val cell = (maxWidth.value / (frame.cols.toInt() * CELL_WIDTH_EM)).coerceIn(SMALLEST_CELL_DP, LARGEST_CELL_DP)
        val density = LocalDensity.current
        val style = with(density) {
            TextStyle(
                fontFamily = MonoFamily,
                fontSize = cell.dp.toSp(),
                lineHeight = (cell * LINE_HEIGHT_EM).dp.toSp(),
            )
        }
        val linePx = with(density) { (cell * LINE_HEIGHT_EM).dp.toPx() }
        var dragged by remember { mutableFloatStateOf(0f) }
        Column(
            Modifier
                .fillMaxSize()
                .horizontalScroll(rememberScrollState())
                .pointerInput(linePx) {
                    detectVerticalDragGestures { _, amount ->
                        dragged += amount
                        val lines = (dragged / linePx).toInt()
                        if (lines != 0) {
                            dragged -= lines * linePx
                            onScroll(lines)
                        }
                    }
                },
        ) {
            frame.lines.forEach { line ->
                BasicText(
                    annotated(line, theme.foreground, theme.background, theme.cursor),
                    style = style,
                    maxLines = 1,
                    softWrap = false,
                )
            }
        }
    }
}
