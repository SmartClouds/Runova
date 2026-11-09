package com.runovahq.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
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
import com.runovahq.app.design.RunovaIcons
import com.runovahq.app.design.RunovaSectionTitle
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTextArea
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaType
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.AutoFixSessionView
import uniffi.runova_ffi.AutoFixTone
import uniffi.runova_ffi.PipelineRunState
import uniffi.runova_ffi.WorkflowView

data class PromptIntents(
    val generate: (String, String, String) -> Unit = { _, _, _ -> },
    val cancel: () -> Unit = {},
    val taken: () -> Unit = {},
    val send: (String, String?) -> Unit = { _, _ -> },
)

private fun toneOf(tone: AutoFixTone) = when (tone) {
    AutoFixTone.WORKING -> BadgeTone.Primary
    AutoFixTone.ATTENTION -> BadgeTone.Warning
    AutoFixTone.DONE -> BadgeTone.Success
    AutoFixTone.FAILED -> BadgeTone.Danger
    AutoFixTone.STOPPED -> BadgeTone.Neutral
}

/** Under a workflow: what can be done about its run, or how the fix in progress is going. */
@Composable
fun WorkflowFixes(workflow: WorkflowView, sessions: List<AutoFixSessionView>, intents: PipelineIntents) {
    val session = sessions.firstOrNull { it.workflowId == workflow.id }
    val run = workflow.run
    when {
        session != null -> AutoFixPanel(session, intents)
        run != null && run.state in listOf(PipelineRunState.RUNNING, PipelineRunState.QUEUED, PipelineRunState.FAILED) ->
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (run.state == PipelineRunState.FAILED) {
                    RunovaChip("Fix with AI", { intents.fixWithAi(workflow.id) }, icon = RunovaIcons.Sparkles, tone = ChipTone.Primary)
                }
                RunovaChip("Auto-fix", { intents.autoFixStart(workflow.id) }, icon = RunovaIcons.Wand)
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
    var request by remember { mutableStateOf("") }
    var type by remember { mutableStateOf(options.types.firstOrNull { it == "Bug Fix" } ?: options.types.first()) }
    var target by remember { mutableStateOf(options.defaultTarget ?: options.targets.firstOrNull()?.name.orEmpty()) }
    var prompt by remember { mutableStateOf("") }
    LaunchedEffect(screen.result) {
        screen.result?.let {
            prompt = it
            intents.taken()
        }
    }
    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        RunovaSectionTitle("What do you want done?")
        RunovaTextArea(request, { request = it }, "Describe the job in your own words", minHeight = 84.dp)
        RunovaSectionTitle("Kind of prompt", Modifier.padding(top = 6.dp))
        ChipRow(options.types, type) { type = it }
        RunovaSectionTitle("Written for", Modifier.padding(top = 6.dp))
        ChipRow(options.targets.map { it.name }, target) { target = it }
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
                    onClick = { intents.send(prompt, options.targets.firstOrNull { it.name == target }?.id) },
                    Modifier.weight(1f),
                    enabled = view.selectedProject != null,
                    icon = RunovaIcons.Send,
                )
            }
            if (view.selectedProject == null) {
                RunovaText("Choose a project to send it to an agent.", style = RunovaType.small, color = colors.mutedForeground)
            }
        }
    }
}

@Composable
private fun ChipRow(items: List<String>, selected: String, onPick: (String) -> Unit) {
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        items.forEach { item ->
            RunovaChip(item, { onPick(item) }, tone = if (item == selected) ChipTone.Primary else ChipTone.Soft)
        }
    }
}
