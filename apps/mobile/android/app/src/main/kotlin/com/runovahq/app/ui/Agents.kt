package com.runovahq.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import com.runovahq.app.design.BadgeTone
import com.runovahq.app.design.ButtonKind
import com.runovahq.app.design.ChipTone
import com.runovahq.app.design.RunovaBadge
import com.runovahq.app.design.RunovaButton
import com.runovahq.app.design.RunovaChip
import com.runovahq.app.design.RunovaIcon
import com.runovahq.app.design.RunovaIconTile
import com.runovahq.app.design.RunovaIcons
import com.runovahq.app.design.RunovaListRow
import com.runovahq.app.design.RunovaSectionTitle
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTextArea
import com.runovahq.app.design.RunovaTextField
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaType
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.AutoFixSessionView
import uniffi.runova_ffi.AutoFixTone
import uniffi.runova_ffi.PipelineRunState
import uniffi.runova_ffi.PromptOptionsView
import uniffi.runova_ffi.PromptScheduleInput
import uniffi.runova_ffi.PromptTargetView
import uniffi.runova_ffi.PromptsScreen
import uniffi.runova_ffi.WorkflowView

data class PromptIntents(
    val generate: (String, String, String) -> Unit = { _, _, _ -> },
    val cancel: () -> Unit = {},
    val taken: () -> Unit = {},
    val send: (String, String?, String?, String?) -> Unit = { _, _, _, _ -> },
    val loadLibrary: (String?) -> Unit = {},
    val saveTemplate: (String, String, String, String) -> Unit = { _, _, _, _ -> },
    val deleteTemplate: (String) -> Unit = {},
    val schedule: (PromptScheduleInput) -> Unit = {},
    val cancelScheduled: (String) -> Unit = {},
)

/** Which sheet a workflow's chips have opened. */
data class FixSheet(val workflowId: Long, val auto: Boolean)

private fun toneOf(tone: AutoFixTone) = when (tone) {
    AutoFixTone.WORKING -> BadgeTone.Primary
    AutoFixTone.ATTENTION -> BadgeTone.Warning
    AutoFixTone.DONE -> BadgeTone.Success
    AutoFixTone.FAILED -> BadgeTone.Danger
    AutoFixTone.STOPPED -> BadgeTone.Neutral
}

private const val DEFAULT_CHOICE = "Default"

/** Under a workflow: what can be done about its run, or how the fix in progress is going. */
@Composable
fun WorkflowFixes(
    workflow: WorkflowView,
    sessions: List<AutoFixSessionView>,
    intents: PipelineIntents,
    onSheet: (FixSheet) -> Unit,
) {
    val session = sessions.firstOrNull { it.workflowId == workflow.id }
    val run = workflow.run
    when {
        session != null -> AutoFixPanel(session, intents)
        run != null && run.state in listOf(PipelineRunState.RUNNING, PipelineRunState.QUEUED, PipelineRunState.FAILED) ->
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (run.state == PipelineRunState.FAILED) {
                    RunovaChip("Fix with AI", { onSheet(FixSheet(workflow.id, false)) }, icon = RunovaIcons.Sparkles, tone = ChipTone.Primary)
                }
                RunovaChip("Auto-fix", { onSheet(FixSheet(workflow.id, true)) }, icon = RunovaIcons.Wand)
            }
    }
}

/** Says what is about to happen on the computer, and takes the choice of agent. */
@Composable
fun FixAgentSheet(
    sheet: FixSheet,
    branch: String?,
    options: PromptOptionsView?,
    intents: PipelineIntents,
    onClose: () -> Unit,
) {
    val colors = RunovaTheme.colors
    val shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)
    var cli by remember { mutableStateOf<String?>(null) }
    var model by remember { mutableStateOf<String?>(null) }
    var effort by remember { mutableStateOf<String?>(null) }
    val target = options?.targets?.firstOrNull { it.name == cli }
    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.6f))
            .clickable(interactionSource = null, indication = null, onClick = onClose),
        contentAlignment = Alignment.BottomCenter,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .clip(shape)
                .background(colors.popover)
                .border(1.dp, colors.foreground.copy(alpha = 0.1f), shape)
                .clickable(interactionSource = null, indication = null) {}
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                RunovaIconTile(if (sheet.auto) RunovaIcons.Wand else RunovaIcons.Sparkles, size = 38.dp)
                RunovaText(if (sheet.auto) "Turn on auto-fix?" else "Fix this run with AI?", Modifier.weight(1f), RunovaType.heading)
            }
            RunovaText(
                if (sheet.auto) {
                    "If this run fails, an agent on this computer fixes it, then commits and pushes to ${branch ?: "this branch"}. It tries up to the limit in your Settings."
                } else {
                    "An agent starts on this computer with the failure in hand. You can follow it here and answer it. Nothing is pushed unless you ask it to."
                },
                style = RunovaType.small,
                color = colors.mutedForeground,
            )
            if (options != null) {
                RunovaSectionTitle("Agent", Modifier.padding(top = 4.dp))
                ChipRow(listOf(DEFAULT_CHOICE) + options.targets.map { it.name }, cli ?: DEFAULT_CHOICE) {
                    cli = it.takeUnless { name -> name == DEFAULT_CHOICE }
                    model = null
                    effort = null
                }
                AgentModelRows(target, model, effort, { model = it }, { effort = it })
            }
            RunovaButton(
                if (sheet.auto) "Turn on auto-fix" else "Start the agent",
                onClick = {
                    if (sheet.auto) {
                        intents.autoFixStart(sheet.workflowId, target?.id, model, effort)
                    } else {
                        intents.fixWithAi(sheet.workflowId, target?.id, model, effort)
                    }
                    onClose()
                },
                Modifier.fillMaxWidth().padding(top = 4.dp),
                icon = if (sheet.auto) RunovaIcons.Wand else RunovaIcons.Sparkles,
            )
        }
    }
}

@Composable
private fun AgentModelRows(
    target: PromptTargetView?,
    model: String?,
    effort: String?,
    onModel: (String?) -> Unit,
    onEffort: (String?) -> Unit,
) {
    val models = target?.models.orEmpty()
    if (models.isEmpty()) return
    RunovaSectionTitle("Model", Modifier.padding(top = 4.dp))
    ChipRow(listOf(DEFAULT_CHOICE) + models.map { it.label }, models.firstOrNull { it.value == model }?.label ?: DEFAULT_CHOICE) { label ->
        onModel(models.firstOrNull { it.label == label }?.value)
        onEffort(null)
    }
    val efforts = models.firstOrNull { it.value == model }?.efforts.orEmpty()
    if (efforts.isNotEmpty()) {
        RunovaSectionTitle("Effort", Modifier.padding(top = 4.dp))
        ChipRow(listOf(DEFAULT_CHOICE) + efforts, effort ?: DEFAULT_CHOICE) { picked ->
            onEffort(picked.takeUnless { it == DEFAULT_CHOICE })
        }
    }
}

@Composable
private fun AutoFixPanel(session: AutoFixSessionView, intents: PipelineIntents) {
    val colors = RunovaTheme.colors
    val tone = toneOf(session.tone)
    val shape = RoundedCornerShape(14.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(colors.foreground.copy(alpha = 0.04f))
            .border(1.dp, colors.foreground.copy(alpha = 0.08f), shape)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            RunovaIcon(RunovaIcons.Wand, size = 13.dp, color = colors.primary)
            RunovaText("Auto-fix", Modifier.weight(1f), RunovaType.labelStrong)
            RunovaBadge(session.phaseLabel, tone, dot = true)
        }
        session.message?.let { RunovaText(it, style = RunovaType.small, color = colors.mutedForeground) }
        if (session.timeline.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                session.timeline.forEachIndexed { index, line ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Box(
                            Modifier
                                .size(6.dp)
                                .clip(CircleShape)
                                .background(if (index == session.timeline.lastIndex) colors.primary else colors.foreground.copy(alpha = 0.25f)),
                        )
                        RunovaText(line, style = RunovaType.small, color = colors.mutedForeground)
                    }
                }
            }
        }
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            session.agentSession?.let {
                RunovaChip("Watch the agent", { intents.watchAgent(it) }, icon = RunovaIcons.Terminal, tone = ChipTone.Primary)
            }
            if (session.canStop) RunovaChip("Stop", { intents.autoFixStop(session.id) }, icon = RunovaIcons.Stop, tone = ChipTone.Danger)
            if (session.canRetry) RunovaChip("Try again", { intents.autoFixRetry(session.id) }, icon = RunovaIcons.Refresh)
            if (session.canCommit) RunovaChip("Commit now", { intents.autoFixCommit(session.id) }, icon = RunovaIcons.Commit)
            if (session.canDismiss) RunovaChip("Clear", { intents.autoFixDismiss(session.id) }, icon = RunovaIcons.Close)
        }
    }
}

private val DELAYS = listOf(
    "In 30 min" to 30 * 60_000L,
    "In 1 hour" to 3_600_000L,
    "In 3 hours" to 3 * 3_600_000L,
    "In 8 hours" to 8 * 3_600_000L,
    "Tomorrow" to 24 * 3_600_000L,
)

/** Describe the job, let the computer write the prompt, then send it to an agent. */
@Composable
fun PromptsTab(view: AppView, intents: PromptIntents) {
    val colors = RunovaTheme.colors
    val screen = view.prompts
    val options = screen.options
    if (options == null) {
        LoadingRows()
        return
    }
    val clipboard = LocalClipboardManager.current
    var library by remember { mutableStateOf<String?>(null) }
    var request by remember { mutableStateOf("") }
    var type by remember { mutableStateOf(options.types.firstOrNull { it == "Bug Fix" } ?: options.types.first()) }
    var target by remember { mutableStateOf(options.defaultTarget ?: options.targets.firstOrNull()?.name.orEmpty()) }
    var model by remember { mutableStateOf<String?>(null) }
    var effort by remember { mutableStateOf<String?>(null) }
    var prompt by remember { mutableStateOf("") }
    var naming by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var scheduling by remember { mutableStateOf(false) }
    val chosen = options.targets.firstOrNull { it.name == target }
    LaunchedEffect(screen.result) {
        screen.result?.let {
            prompt = it
            intents.taken()
        }
    }
    library?.let { section ->
        PromptLibrary(
            section,
            screen,
            { library = it },
            intents,
            onUse = { useType, useTarget, content, raw ->
                type = useType
                target = useTarget
                prompt = content
                if (raw != null) request = raw
                library = null
            },
        )
        return
    }
    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            RunovaChip("Templates", { library = "Templates" }, icon = RunovaIcons.File)
            RunovaChip("History", { library = "History" }, icon = RunovaIcons.History)
            RunovaChip("Scheduled", { library = "Scheduled" }, icon = RunovaIcons.Clock)
        }
        RunovaSectionTitle("What do you want done?", Modifier.padding(top = 4.dp))
        RunovaTextArea(request, { request = it }, "Describe the job in your own words", minHeight = 84.dp)
        RunovaSectionTitle("Kind of prompt", Modifier.padding(top = 6.dp))
        ChipRow(options.types, type) { type = it }
        RunovaSectionTitle("Written for", Modifier.padding(top = 6.dp))
        ChipRow(options.targets.map { it.name }, target) {
            target = it
            model = null
            effort = null
        }
        RunovaButton(
            if (screen.generating) "Stop" else "Generate prompt",
            onClick = if (screen.generating) intents.cancel else ({ intents.generate(request.trim(), type, target) }),
            Modifier.fillMaxWidth().padding(top = 6.dp),
            kind = if (screen.generating) ButtonKind.Danger else ButtonKind.Primary,
            enabled = screen.generating || request.isNotBlank(),
            icon = if (screen.generating) RunovaIcons.Stop else RunovaIcons.Sparkles,
        )
        if (screen.generating) {
            RunovaText("The AI on this computer is writing it.", style = RunovaType.small, color = colors.primary)
        }
        screen.error?.let { RunovaText(it, style = RunovaType.small, color = colors.destructive) }
        if (prompt.isNotEmpty()) {
            RunovaSectionTitle("Your prompt", Modifier.padding(top = 6.dp))
            RunovaTextArea(prompt, { prompt = it }, "Your prompt", minHeight = 160.dp)
            AgentModelRows(chosen, model, effort, { model = it }, { effort = it })
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                RunovaButton(
                    "Copy",
                    onClick = { clipboard.setText(AnnotatedString(prompt)) },
                    Modifier.weight(1f),
                    kind = ButtonKind.Soft,
                    icon = RunovaIcons.Copy,
                )
                RunovaButton(
                    "Send to agent",
                    onClick = { intents.send(prompt, chosen?.id, model, effort) },
                    Modifier.weight(1f),
                    enabled = view.selectedProject != null,
                    icon = RunovaIcons.Send,
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                RunovaChip("Save as template", { naming = !naming }, icon = RunovaIcons.File)
                if (view.selectedProject != null) {
                    RunovaChip("Schedule", { scheduling = !scheduling }, icon = RunovaIcons.Clock)
                }
            }
            if (naming) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    RunovaTextField(name, { name = it }, "Template name", Modifier.weight(1f), icon = RunovaIcons.File)
                    RunovaButton(
                        "Save",
                        onClick = {
                            intents.saveTemplate(name.trim(), type, target, prompt)
                            name = ""
                            naming = false
                        },
                        enabled = name.isNotBlank(),
                    )
                }
            }
            if (scheduling) {
                ChipRow(DELAYS.map { it.first }, "") { label ->
                    val delay = DELAYS.first { it.first == label }.second
                    intents.schedule(
                        PromptScheduleInput(request.trim().ifEmpty { prompt.take(80) }, type, target, prompt, delay, chosen?.id, model, effort),
                    )
                    scheduling = false
                }
            }
            if (view.selectedProject == null) {
                RunovaText("Choose a project to send it to an agent.", style = RunovaType.small, color = colors.mutedForeground)
            }
        }
    }
}

@Composable
private fun PromptLibrary(
    section: String,
    screen: PromptsScreen,
    onSection: (String?) -> Unit,
    intents: PromptIntents,
    onUse: (String, String, String, String?) -> Unit,
) {
    val colors = RunovaTheme.colors
    var query by remember { mutableStateOf("") }
    LaunchedEffect(Unit) { intents.loadLibrary(null) }
    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            RunovaChip("Back", { onSection(null) }, icon = RunovaIcons.Back)
            listOf("Templates", "History", "Scheduled").forEach {
                RunovaChip(it, { onSection(it) }, tone = if (it == section) ChipTone.Primary else ChipTone.Soft)
            }
        }
        when (section) {
            "Templates" -> {
                if (screen.templates.isEmpty()) EmptyNote("Save a prompt as a template and it shows up here.")
                screen.templates.forEach { one ->
                    RunovaListRow(
                        title = one.name,
                        detail = "${one.promptType}, for ${one.targetAi}",
                        icon = RunovaIcons.File,
                        onClick = { onUse(one.promptType, one.targetAi, one.content, null) },
                        trailing = { RunovaChip("Delete", { intents.deleteTemplate(one.id) }, icon = RunovaIcons.Trash, tone = ChipTone.Danger) },
                    )
                }
            }
            "History" -> {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    RunovaTextField(query, { query = it }, "Search your prompts", Modifier.weight(1f), icon = RunovaIcons.Search)
                    RunovaChip("Search", { intents.loadLibrary(query.trim().ifEmpty { null }) })
                }
                if (screen.history.isEmpty()) EmptyNote("Prompts you generate show up here.")
                screen.history.forEach { one ->
                    RunovaListRow(
                        title = one.rawInput,
                        detail = one.meta,
                        icon = RunovaIcons.History,
                        iconTone = BadgeTone.Neutral,
                        onClick = { onUse(one.promptType, one.targetAi, one.content, one.rawInput) },
                    )
                }
            }
            else -> {
                if (screen.scheduled.isEmpty()) EmptyNote("Nothing is waiting in this project.")
                screen.scheduled.forEach { one ->
                    RunovaListRow(
                        title = one.summary,
                        detail = one.whenLabel,
                        icon = RunovaIcons.Clock,
                        trailing = { RunovaChip("Cancel", { intents.cancelScheduled(one.id) }, icon = RunovaIcons.Close, tone = ChipTone.Danger) },
                    )
                }
                RunovaText(
                    "Scheduled prompts start only while Runova is running on this computer.",
                    style = RunovaType.small,
                    color = colors.mutedForeground,
                )
            }
        }
    }
}

@Composable
private fun EmptyNote(text: String) {
    RunovaText(text, Modifier.padding(vertical = 12.dp), color = RunovaTheme.colors.mutedForeground)
}

@Composable
private fun ChipRow(items: List<String>, selected: String, onPick: (String) -> Unit) {
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        items.forEach { item ->
            RunovaChip(item, { onPick(item) }, tone = if (item == selected) ChipTone.Primary else ChipTone.Soft)
        }
    }
}
