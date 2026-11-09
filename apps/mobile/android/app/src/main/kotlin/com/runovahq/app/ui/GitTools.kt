package com.runovahq.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.runovahq.app.design.ButtonKind
import com.runovahq.app.design.RunovaButton
import com.runovahq.app.design.RunovaChip
import com.runovahq.app.design.RunovaIcon
import com.runovahq.app.design.RunovaIconTile
import com.runovahq.app.design.RunovaIcons
import com.runovahq.app.design.RunovaScreen
import com.runovahq.app.design.RunovaSectionTitle
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTextArea
import com.runovahq.app.design.RunovaTextField
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaToggle
import com.runovahq.app.design.RunovaType
import com.runovahq.app.design.runovaGlass
import uniffi.runova_ffi.GitAiKind
import uniffi.runova_ffi.GitTagsView
import uniffi.runova_ffi.GitToolsScreen

val LocalGitTools = compositionLocalOf { GitToolsScreen(null, null, null) }

/** The round button beside a field that asks the AI on the computer, and stops it. */
@Composable
fun AiButton(loading: Boolean, label: String, onAsk: () -> Unit, onStop: () -> Unit) {
    val colors = RunovaTheme.colors
    val ink = if (loading) colors.destructive else colors.primary
    Box(
        Modifier
            .size(44.dp)
            .clip(CircleShape)
            .background(ink.copy(alpha = 0.13f))
            .clickable(role = Role.Button, onClick = if (loading) onStop else onAsk)
            .semantics { contentDescription = if (loading) "Stop" else label },
        contentAlignment = Alignment.Center,
    ) {
        RunovaIcon(if (loading) RunovaIcons.Stop else RunovaIcons.Sparkles, size = 15.dp, color = ink)
    }
}

/** Takes an answer from the computer into a field, once. */
@Composable
fun TakeAiAnswer(kind: GitAiKind, onText: (String) -> Unit, onTaken: () -> Unit) {
    val ai = LocalGitTools.current.ai?.takeIf { it.kind == kind }
    LaunchedEffect(ai?.text) {
        ai?.text?.let {
            onText(it)
            onTaken()
        }
    }
}

@Composable
fun AiNote(kind: GitAiKind) {
    val colors = RunovaTheme.colors
    val ai = LocalGitTools.current.ai?.takeIf { it.kind == kind } ?: return
    when {
        ai.loading -> RunovaText("Asking the AI on this computer", style = RunovaType.small, color = colors.primary)
        ai.error != null -> RunovaText(ai.error!!, style = RunovaType.small, color = colors.destructive)
        ai.note != null -> RunovaText(ai.note!!, style = RunovaType.small, color = colors.mutedForeground)
    }
}

@Composable
fun TagsScreen(tags: GitTagsView, error: String?, intents: GitIntents) {
    val colors = RunovaTheme.colors
    var tag by remember { mutableStateOf("") }
    var message by remember { mutableStateOf("") }
    var push by remember(tags.hasRemote) { mutableStateOf(tags.hasRemote) }
    val suggestion = tags.suggestion
    LaunchedEffect(suggestion) {
        suggestion?.let {
            tag = it.tag
            message = it.message
        }
    }
    RunovaScreen("Tag a version", onBack = intents.closeTags) {
        Column(
            Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Column(Modifier.fillMaxWidth().runovaGlass().padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                RunovaSectionTitle("Latest")
                RunovaText(tags.latest ?: "No tags yet", style = RunovaType.title.copy(fontFamily = RunovaType.mono.fontFamily))
                if (tags.commitsLabel.isNotEmpty()) {
                    RunovaText(tags.commitsLabel, style = RunovaType.small, color = colors.mutedForeground)
                }
            }
            if (tags.options.isNotEmpty()) {
                RunovaSectionTitle("Next", Modifier.padding(top = 4.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    tags.options.forEach { option ->
                        BumpOption(option.kind, option.tag, option.tag == tag, Modifier.weight(1f)) { tag = option.tag }
                    }
                }
            }
            RunovaButton(
                if (tags.suggesting) "Stop asking" else "Suggest with AI",
                onClick = if (tags.suggesting) intents.cancelAi else intents.suggestTag,
                Modifier.fillMaxWidth(),
                kind = if (tags.suggesting) ButtonKind.Danger else ButtonKind.Tint,
                icon = if (tags.suggesting) RunovaIcons.Stop else RunovaIcons.Sparkles,
            )
            if (tags.suggesting) {
                RunovaText("The AI on this computer is reading the commits.", style = RunovaType.small, color = colors.primary)
            }
            suggestion?.let {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    RunovaIconTile(RunovaIcons.Sparkles, size = 30.dp)
                    Column(Modifier.weight(1f)) {
                        it.reason?.let { reason -> RunovaText(reason, style = RunovaType.label) }
                        RunovaText(it.note, style = RunovaType.small, color = colors.mutedForeground)
                    }
                }
            }
            (tags.error ?: error)?.let { RunovaText(it, style = RunovaType.small, color = colors.destructive) }
            RunovaTextField(tag, { tag = it }, "Tag name", icon = RunovaIcons.Tag)
            RunovaTextArea(message, { message = it }, "Release notes (optional)", minHeight = 96.dp)
            if (tags.hasRemote) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        RunovaText("Push it", style = RunovaType.label)
                        RunovaText(
                            "Sends the tag and the current branch to the remote.",
                            style = RunovaType.small,
                            color = colors.mutedForeground,
                        )
                    }
                    RunovaToggle(push, { push = it }, "Push it")
                }
            }
            if (tags.recent.isNotEmpty()) {
                RunovaSectionTitle("Recent", Modifier.padding(top = 4.dp))
                tags.recent.forEach {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        RunovaIcon(RunovaIcons.Tag, size = 11.dp, color = colors.mutedForeground)
                        RunovaText(it, style = RunovaType.mono, color = colors.mutedForeground)
                    }
                }
            }
            Spacer(Modifier.height(4.dp))
        }
        RunovaButton(
            if (push) "Create and push" else "Create tag",
            onClick = { intents.createTag(tag.trim(), message, push) },
            Modifier.fillMaxWidth().padding(16.dp),
            enabled = tag.isNotBlank() && !tags.suggesting,
            icon = RunovaIcons.Tag,
        )
    }
}

@Composable
private fun BumpOption(kind: String, tag: String, on: Boolean, modifier: Modifier, onPick: () -> Unit) {
    val colors = RunovaTheme.colors
    val shape = RoundedCornerShape(14.dp)
    Column(
        modifier
            .clip(shape)
            .background(if (on) colors.primary.copy(alpha = 0.13f) else colors.foreground.copy(alpha = 0.05f))
            .border(1.dp, if (on) colors.primary.copy(alpha = 0.45f) else colors.foreground.copy(alpha = 0.08f), shape)
            .clickable(role = Role.Button, onClick = onPick)
            .padding(horizontal = 10.dp, vertical = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        RunovaText(kind, style = RunovaType.small, color = if (on) colors.primary else colors.mutedForeground)
        RunovaText(tag, style = RunovaType.labelStrong, maxLines = 1)
    }
}

/** The chip on a conflicted file: starts the AI, then shows it can be stopped. */
@Composable
fun FixConflictChip(path: String, intents: GitIntents) {
    val working = LocalGitTools.current.resolving == path
    RunovaChip(
        if (working) "Stop" else "AI",
        { if (working) intents.cancelAi() else intents.resolveWithAi(path) },
        icon = if (working) RunovaIcons.Stop else RunovaIcons.Sparkles,
        tone = if (working) com.runovahq.app.design.ChipTone.Danger else com.runovahq.app.design.ChipTone.Primary,
    )
}
