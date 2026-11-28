package com.runovahq.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.runovahq.app.design.BadgeTone
import com.runovahq.app.design.ButtonKind
import com.runovahq.app.design.ChipTone
import com.runovahq.app.design.RunovaBadge
import com.runovahq.app.design.RunovaButton
import com.runovahq.app.design.RunovaCard
import com.runovahq.app.design.RunovaChip
import com.runovahq.app.design.RunovaEmptyState
import com.runovahq.app.design.RunovaIcon
import com.runovahq.app.design.RunovaIcons
import com.runovahq.app.design.RunovaListRow
import com.runovahq.app.design.RunovaScreen
import com.runovahq.app.design.RunovaSectionTitle
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTextField
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaType
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.TaskDetailView
import uniffi.runova_ffi.TaskEditInput
import uniffi.runova_ffi.TaskRecordView
import uniffi.runova_ffi.TaskRowView
import uniffi.runova_ffi.TaskSectionView
import uniffi.runova_ffi.TaskSplitView
import uniffi.runova_ffi.TasksOverviewView

/** What the Tasks screens can ask the core to do (E124). */
data class TaskIntents(
    val open: (String) -> Unit = {},
    val close: () -> Unit = {},
    val setStatus: (String, String) -> Unit = { _, _ -> },
    val toggle: (String, UInt, Boolean) -> Unit = { _, _, _ -> },
    val create: (String, String?) -> Unit = { _, _ -> },
    val update: (String, TaskEditInput) -> Unit = { _, _ -> },
    val showRecords: (String?) -> Unit = {},
    val setRecordStatus: (String, String, String) -> Unit = { _, _, _ -> },
    val answer: (String, String) -> Unit = { _, _ -> },
    val addRecord: (String, String, String?) -> Unit = { _, _, _ -> },
    val redo: (String, String?, Boolean) -> Unit = { _, _, _ -> },
    val split: (String, Boolean) -> Unit = { _, _ -> },
    val cancelSplit: () -> Unit = {},
    val addSplit: () -> Unit = {},
    val discardSplit: () -> Unit = {},
    val start: () -> Unit = {},
    val pause: () -> Unit = {},
    val resume: () -> Unit = {},
)

private val VIEWS = listOf("Overview", "Tasks", "Records", "Split")
private val KINDS = listOf(
    "decision" to "Decisions",
    "workaround" to "Workarounds",
    "risk" to "Risks",
    "question" to "Questions",
    "milestone" to "Milestones",
)
private val PRIORITIES = listOf("p0", "p1", "p2", "p3")

private fun toneOf(status: String) = when (status) {
    "done" -> BadgeTone.Success
    "blocked" -> BadgeTone.Danger
    "testing" -> BadgeTone.Warning
    "in-progress" -> BadgeTone.Primary
    else -> BadgeTone.Neutral
}

/** A task open on its own screen, over the tabs. True when it drew something. */
@Composable
fun TasksOverlay(view: AppView, intents: TaskIntents): Boolean {
    val detail = view.tasks.detail ?: return false
    TaskDetailScreen(detail, view.busy, intents)
    return true
}

@Composable
fun TasksTab(view: AppView, intents: TaskIntents) {
    if (view.selectedProject == null) {
        RunovaEmptyState(RunovaIcons.Folder, "Choose a project", "Pick a project on the Projects tab to see its plan and tasks.")
        return
    }
    var tab by remember { mutableStateOf(VIEWS.first()) }
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            VIEWS.forEach { name ->
                RunovaChip(
                    name,
                    {
                        tab = name
                        if (name == "Records" && view.tasks.recordsKind == null) intents.showRecords("decision")
                    },
                    Modifier.semantics { selected = tab == name },
                    tone = if (tab == name) ChipTone.Primary else ChipTone.Soft,
                )
            }
        }
        Box(Modifier.weight(1f)) {
            when (tab) {
                "Tasks" -> TaskList(view.tasks.tasks, intents)
                "Records" -> Records(view.tasks.recordsKind, view.tasks.records, intents)
                "Split" -> Split(view.tasks.split, intents)
                else -> Overview(view.tasks.overview, view.tasks.loading, intents)
            }
        }
    }
}

@Composable
private fun ProgressLine(percent: UByte, label: String) {
    val colors = RunovaTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Box(
            Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)).background(colors.foreground.copy(alpha = 0.1f))
                .semantics { contentDescription = label },
        ) {
            Box(Modifier.fillMaxWidth(percent.toFloat() / 100f).fillMaxHeight().background(colors.primary))
        }
        RunovaText(label, style = RunovaType.small, color = colors.mutedForeground)
    }
}

@Composable
private fun Overview(overview: TasksOverviewView?, loading: Boolean, intents: TaskIntents) {
    val colors = RunovaTheme.colors
    if (overview == null) {
        if (loading) LoadingRows() else RunovaEmptyState(RunovaIcons.DoneAll, "No plan yet", "Split work into tasks from the Split tab.")
        return
    }
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item(key = "plan") {
            RunovaCard(Modifier.fillMaxWidth()) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    RunovaText(overview.title, style = RunovaType.heading)
                    RunovaText(overview.modeLabel, style = RunovaType.small, color = colors.mutedForeground)
                    overview.goal?.let { RunovaText(it, style = RunovaType.body) }
                    ProgressLine(overview.percent, overview.progressLabel)
                    RunovaText(overview.countsLabel, style = RunovaType.small, color = colors.mutedForeground)
                    overview.recordsLabel?.let { RunovaText(it, style = RunovaType.small, color = colors.mutedForeground) }
                }
            }
        }
        item(key = "run") {
            val run = overview.run
            RunovaCard(Modifier.fillMaxWidth()) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    RunovaText(run?.label ?: "Not running", Modifier.weight(1f), RunovaType.labelStrong)
                    when {
                        run?.canPause == true -> RunovaButton("Pause", intents.pause, kind = ButtonKind.Soft, icon = RunovaIcons.Stop)
                        run?.canResume == true -> RunovaButton("Go on", intents.resume, icon = RunovaIcons.Play)
                        overview.canStart -> RunovaButton("Run the tasks", intents.start, icon = RunovaIcons.Play)
                    }
                }
            }
        }
        if (overview.milestones.isNotEmpty()) {
            item(key = "milestones-title") { RunovaSectionTitle("Milestones") }
            items(overview.milestones, key = { "m-" + it.id }) { milestone ->
                RunovaCard(Modifier.fillMaxWidth()) {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        RunovaText("${milestone.id} ${milestone.title}", style = RunovaType.labelStrong)
                        milestone.target?.let { RunovaText("Target $it", style = RunovaType.small, color = colors.mutedForeground) }
                        ProgressLine(milestone.percent, milestone.label)
                    }
                }
            }
        }
        if (overview.needsYou.isNotEmpty() || overview.questions.isNotEmpty()) {
            item(key = "needs-title") { RunovaSectionTitle("Needs you") }
            items(overview.needsYou, key = { "n-" + it.id }) { task -> TaskRow(task, intents) }
            items(overview.questions, key = { "q-" + it.id }) { question ->
                RunovaListRow("${question.id} ${question.title}", icon = RunovaIcons.Info, iconTone = BadgeTone.Warning)
            }
        }
    }
}

@Composable
private fun TaskRow(task: TaskRowView, intents: TaskIntents) {
    RunovaListRow(
        "${task.id} ${task.title}",
        detail = task.meta.ifEmpty { null },
        onClick = { intents.open(task.id) },
        trailing = { RunovaBadge(task.statusLabel, toneOf(task.status)) },
    )
}

@Composable
private fun TaskList(tasks: List<TaskRowView>, intents: TaskIntents) {
    var title by remember { mutableStateOf("") }
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        item(key = "new") {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                RunovaTextField(title, { title = it }, "A new task", Modifier.weight(1f))
                RunovaButton(
                    "Add",
                    {
                        intents.create(title.trim(), null)
                        title = ""
                    },
                    enabled = title.isNotBlank(),
                    icon = RunovaIcons.Add,
                )
            }
        }
        if (tasks.isEmpty()) {
            item(key = "empty") { RunovaText("No tasks yet.", Modifier.padding(top = 12.dp), RunovaType.small, RunovaTheme.colors.mutedForeground) }
        }
        items(tasks, key = { it.id }) { task -> TaskRow(task, intents) }
    }
}

@Composable
private fun Sections(sections: List<TaskSectionView>) {
    sections.forEach { section ->
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            RunovaSectionTitle(section.heading)
            RunovaText(section.text, style = RunovaType.small)
        }
    }
}

@Composable
private fun Records(kind: String?, records: List<TaskRecordView>, intents: TaskIntents) {
    val colors = RunovaTheme.colors
    var title by remember { mutableStateOf("") }
    var text by remember { mutableStateOf("") }
    val answers = remember { mutableStateOf(mapOf<String, String>()) }
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item(key = "kinds") {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                KINDS.forEach { (id, label) ->
                    RunovaChip(
                        label,
                        { intents.showRecords(id) },
                        Modifier.semantics { selected = kind == id },
                        tone = if (kind == id) ChipTone.Primary else ChipTone.Soft,
                    )
                }
            }
        }
        if (kind != null) {
            item(key = "add") {
                RunovaCard(Modifier.fillMaxWidth()) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        RunovaTextField(title, { title = it }, "Title of a new one")
                        RunovaTextField(text, { text = it }, "What it says (optional)")
                        RunovaButton(
                            "Add",
                            {
                                intents.addRecord(kind, title.trim(), text.trim().ifEmpty { null })
                                title = ""
                                text = ""
                            },
                            enabled = title.isNotBlank(),
                            icon = RunovaIcons.Add,
                        )
                    }
                }
            }
        }
        if (records.isEmpty()) {
            item(key = "empty") { RunovaText("None yet. Sessions write them as they work.", style = RunovaType.small, color = colors.mutedForeground) }
        }
        items(records, key = { it.id }) { record ->
            RunovaCard(Modifier.fillMaxWidth()) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        RunovaText("${record.id} ${record.title}", Modifier.weight(1f), RunovaType.labelStrong)
                        RunovaBadge(record.status)
                    }
                    record.details.forEach { line ->
                        RunovaText("${line.heading}: ${line.text}", style = RunovaType.small, color = colors.mutedForeground)
                    }
                    Sections(record.sections)
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        record.statuses.filter { it != record.status }.forEach { status ->
                            RunovaChip(status, { intents.setRecordStatus(kind ?: return@RunovaChip, record.id, status) })
                        }
                    }
                    if (kind == "question" && record.status == "open") {
                        val answer = answers.value[record.id].orEmpty()
                        RunovaTextField(answer, { answers.value = answers.value + (record.id to it) }, "Your answer")
                        RunovaButton(
                            "Answer",
                            { intents.answer(record.id, answer.trim()) },
                            enabled = answer.isNotBlank(),
                            kind = ButtonKind.Soft,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun Split(split: TaskSplitView, intents: TaskIntents) {
    val colors = RunovaTheme.colors
    var request by remember { mutableStateOf("") }
    var planOnly by remember { mutableStateOf(false) }
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item(key = "form") {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                RunovaTextField(request, { request = it }, "What should the tasks deliver?")
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    RunovaChip("Fit the context budget", { planOnly = false }, Modifier.semantics { selected = !planOnly }, tone = if (!planOnly) ChipTone.Primary else ChipTone.Soft)
                    RunovaChip("Plan only", { planOnly = true }, Modifier.semantics { selected = planOnly }, tone = if (planOnly) ChipTone.Primary else ChipTone.Soft)
                }
                RunovaText(
                    if (planOnly) {
                        "Parts sized by what they deliver, each with a full spec, and no context budget."
                    } else {
                        "Tasks sized to the context one AI session holds."
                    },
                    style = RunovaType.small,
                    color = colors.mutedForeground,
                )
                if (split.running) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        RunovaText("Planning on your computer…", Modifier.weight(1f), RunovaType.small)
                        RunovaButton("Stop", intents.cancelSplit, kind = ButtonKind.Ghost)
                    }
                } else {
                    RunovaButton("Plan tasks", { intents.split(request.trim(), planOnly) }, enabled = request.isNotBlank(), icon = RunovaIcons.Sparkles)
                }
                split.error?.let { RunovaText(it, style = RunovaType.small, color = colors.destructive) }
            }
        }
        split.summary?.let { summary ->
            item(key = "result") {
                RunovaCard(Modifier.fillMaxWidth()) {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        RunovaText(summary, style = RunovaType.body)
                        split.entries.forEach { RunovaText(it, style = RunovaType.small) }
                        split.extras?.let { RunovaText(it, style = RunovaType.small, color = colors.mutedForeground) }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            RunovaButton("Add to the board", intents.addSplit, icon = RunovaIcons.Check)
                            RunovaButton("Discard", intents.discardSplit, kind = ButtonKind.Ghost)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun TaskDetailScreen(detail: TaskDetailView, busy: Boolean, intents: TaskIntents) {
    val colors = RunovaTheme.colors
    val task = detail.row
    var editing by remember(task.id) { mutableStateOf(false) }
    var title by remember(task.id) { mutableStateOf(task.title) }
    var priority by remember(task.id) { mutableStateOf(detail.priority) }
    var keep by remember(task.id) { mutableStateOf(true) }
    RunovaScreen(task.id, task.title, onBack = intents.close) {
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item(key = "status") {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        RunovaBadge(task.statusLabel, toneOf(task.status), dot = true)
                        detail.attemptLabel?.let { RunovaBadge(it) }
                    }
                    if (task.meta.isNotEmpty()) RunovaText(task.meta, style = RunovaType.small, color = colors.mutedForeground)
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        detail.moves.forEach { move -> RunovaChip(move.label, { intents.setStatus(task.id, move.status) }) }
                    }
                }
            }
            if (detail.acceptance.isNotEmpty()) {
                item(key = "criteria") {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        RunovaSectionTitle("Acceptance criteria")
                        detail.acceptance.forEach { check ->
                            Row(
                                Modifier.fillMaxWidth()
                                    .clickable(enabled = !busy) { intents.toggle(task.id, check.index, !check.checked) }
                                    .semantics {
                                        role = Role.Checkbox
                                        contentDescription = check.text
                                        selected = check.checked
                                    },
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                Box(
                                    Modifier.size(18.dp).clip(RoundedCornerShape(5.dp))
                                        .background(if (check.checked) colors.primary else colors.foreground.copy(alpha = 0.05f))
                                        .border(1.5.dp, if (check.checked) colors.primary else colors.foreground.copy(alpha = 0.3f), RoundedCornerShape(5.dp)),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    if (check.checked) RunovaIcon(RunovaIcons.Check, size = 11.dp, color = colors.primaryForeground)
                                }
                                RunovaText(check.text, Modifier.weight(1f), RunovaType.small)
                            }
                        }
                    }
                }
            }
            item(key = "sections") { Column(verticalArrangement = Arrangement.spacedBy(10.dp)) { Sections(detail.sections) } }
            detail.handoff?.let { handoff ->
                item(key = "handoff") {
                    RunovaCard(Modifier.fillMaxWidth()) {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            RunovaText("Handoff", style = RunovaType.labelStrong)
                            RunovaText(handoff.summary, style = RunovaType.small, color = colors.mutedForeground)
                            Sections(handoff.sections)
                        }
                    }
                }
            }
            if (detail.journal.isNotEmpty()) {
                item(key = "journal") {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        RunovaSectionTitle("Journal")
                        detail.journal.reversed().forEach { entry ->
                            RunovaText(entry.heading, style = RunovaType.labelStrong)
                            RunovaText(entry.lines.joinToString(" · "), style = RunovaType.small, color = colors.mutedForeground)
                        }
                    }
                }
            }
            item(key = "edit") {
                RunovaCard(Modifier.fillMaxWidth()) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (editing) {
                            RunovaTextField(title, { title = it }, "Title")
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                PRIORITIES.forEach { value ->
                                    RunovaChip(
                                        value.uppercase(),
                                        { priority = if (priority == value) null else value },
                                        Modifier.semantics { selected = priority == value },
                                        tone = if (priority == value) ChipTone.Primary else ChipTone.Soft,
                                    )
                                }
                            }
                            RunovaButton(
                                "Save",
                                {
                                    intents.update(task.id, TaskEditInput(title.trim(), priority, detail.size, detail.due))
                                    editing = false
                                },
                                enabled = title.isNotBlank(),
                            )
                        } else {
                            RunovaButton("Edit", { editing = true }, kind = ButtonKind.Soft, icon = RunovaIcons.Edit)
                        }
                    }
                }
            }
            item(key = "redo") {
                RunovaCard(Modifier.fillMaxWidth()) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        RunovaText("Redo with another agent", style = RunovaType.labelStrong)
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            RunovaChip("Learn from this attempt", { keep = true }, Modifier.semantics { selected = keep }, tone = if (keep) ChipTone.Primary else ChipTone.Soft)
                            RunovaChip("From the spec alone", { keep = false }, Modifier.semantics { selected = !keep }, tone = if (!keep) ChipTone.Primary else ChipTone.Soft)
                        }
                        RunovaButton(
                            "Redo",
                            { intents.redo(task.id, null, keep) },
                            enabled = task.status != "in-progress",
                            kind = ButtonKind.Soft,
                            icon = RunovaIcons.Undo,
                        )
                    }
                }
            }
        }
    }
}
