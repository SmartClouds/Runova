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
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.runovahq.app.design.BadgeTone
import com.runovahq.app.design.ButtonKind
import com.runovahq.app.design.RunovaBadge
import com.runovahq.app.design.ChipTone
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
import uniffi.runova_ffi.GitVersionState
import uniffi.runova_ffi.GitVersionView
import uniffi.runova_ffi.GitPrView
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
fun TagsScreen(tags: GitTagsView, error: String?, version: GitVersionView?, intents: GitIntents) {
    val colors = RunovaTheme.colors
    var tag by remember { mutableStateOf("") }
    var message by remember { mutableStateOf("") }
    var push by remember(tags.hasRemote) { mutableStateOf(tags.hasRemote) }
    val suggestion = tags.suggestion
    var channel by remember { mutableStateOf("stable") }
    val options = tags.channels.firstOrNull { it.channel == channel }?.options.orEmpty()
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
            if (tags.channels.isNotEmpty()) {
                RunovaSectionTitle("Next", Modifier.padding(top = 4.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    tags.channels.forEach {
                        RunovaChip(
                            it.label,
                            { channel = it.channel },
                            tone = if (it.channel == channel) ChipTone.Primary else ChipTone.Soft,
                        )
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    options.forEach { option ->
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
            if (version != null) {
                VersionCard(version, intents)
            } else if (tag.isNotBlank()) {
                RunovaChip(
                    "Update the version in files",
                    { intents.applyVersion(tag.trim()) },
                    icon = RunovaIcons.Sparkles,
                )
            }
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
                        RunovaText(it, Modifier.weight(1f), RunovaType.mono, colors.mutedForeground)
                        RunovaChip("Delete", { intents.deleteTag(it) }, icon = RunovaIcons.Trash, tone = ChipTone.Danger)
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

@Composable
private fun VersionCard(version: GitVersionView, intents: GitIntents) {
    val colors = RunovaTheme.colors
    val running = version.state == GitVersionState.RUNNING
    Column(Modifier.fillMaxWidth().runovaGlass().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            RunovaIconTile(if (running) RunovaIcons.Sparkles else RunovaIcons.Check, size = 30.dp)
            RunovaText(
                when (version.state) {
                    GitVersionState.RUNNING -> "Updating to ${version.tag}"
                    GitVersionState.DONE -> "Updated to ${version.tag}"
                    GitVersionState.FAILED -> "That did not work"
                    GitVersionState.STOPPED -> "Stopped"
                },
                Modifier.weight(1f),
                RunovaType.labelStrong,
            )
            if (running) {
                RunovaChip("Stop", intents.cancelVersion, icon = RunovaIcons.Stop, tone = ChipTone.Danger)
            } else {
                RunovaChip("Clear", intents.closeVersion, icon = RunovaIcons.Close)
            }
        }
        version.lines.takeLast(3).forEach { RunovaText(it, style = RunovaType.mono, color = colors.mutedForeground, maxLines = 1) }
        version.error?.let { RunovaText(it, style = RunovaType.small, color = colors.destructive) }
        version.warning?.let { RunovaText(it, style = RunovaType.small, color = colors.warning) }
        if (version.committed) {
            RunovaText("The CLI committed this itself.", style = RunovaType.small, color = colors.mutedForeground)
        }
        version.files.forEach { file ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Column(Modifier.weight(1f)) {
                    RunovaText(file.path, style = RunovaType.label, maxLines = 1)
                    RunovaText(file.detail, style = RunovaType.small, color = colors.mutedForeground)
                }
                RunovaChip(if (file.kept) "Undo" else "Redo", { intents.versionToggle(file.path) })
            }
        }
    }
}

/** A branch's pull request, or the form to open one. */
@Composable
fun PrScreen(pr: GitPrView, intents: GitIntents) {
    val colors = RunovaTheme.colors
    val links = LocalUriHandler.current
    var title by remember { mutableStateOf("") }
    var body by remember { mutableStateOf("") }
    var draft by remember { mutableStateOf(false) }
    var review by remember { mutableStateOf("") }
    LaunchedEffect(pr.suggestion) {
        pr.suggestion?.let {
            title = it.title
            body = it.body
            intents.prSuggestionTaken()
        }
    }
    LaunchedEffect(pr.review) {
        pr.review?.let {
            review = it
            intents.prReviewTaken()
        }
    }
    RunovaScreen("Pull request", subtitle = pr.branchLabel.ifEmpty { null }, onBack = intents.closePr) {
        if (pr.loading) {
            Box(Modifier.weight(1f)) { LoadingRows() }
        } else {
            Column(
                Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                pr.note?.let { RunovaText(it, style = RunovaType.small, color = colors.warning) }
                pr.error?.let { RunovaText(it, style = RunovaType.small, color = colors.destructive) }
                pr.pr?.let { info ->
                    Column(Modifier.fillMaxWidth().runovaGlass().padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            RunovaBadge(info.stateLabel, BadgeTone.Primary, dot = true)
                            info.reviewLabel?.let { RunovaBadge(it, BadgeTone.Success) }
                            RunovaText("#${info.number}", style = RunovaType.small, color = colors.mutedForeground)
                        }
                        RunovaText(info.title, style = RunovaType.title)
                        RunovaText(
                            info.meta,
                            style = RunovaType.small,
                            color = if (info.checksFailed) colors.destructive else colors.mutedForeground,
                        )
                        info.unresolvedLabel?.let { RunovaText(it, style = RunovaType.small, color = colors.warning) }
                        RunovaChip("Open on GitHub", { links.openUri(info.url) }, icon = RunovaIcons.External)
                    }
                    RunovaButton(
                        if (pr.reviewing) "Stop" else "Review with AI",
                        onClick = if (pr.reviewing) intents.cancelPrAi else intents.reviewPr,
                        Modifier.fillMaxWidth(),
                        kind = if (pr.reviewing) ButtonKind.Danger else ButtonKind.Tint,
                        icon = if (pr.reviewing) RunovaIcons.Stop else RunovaIcons.Sparkles,
                    )
                    if (pr.reviewing) {
                        RunovaText("The AI on this computer is reading the changes.", style = RunovaType.small, color = colors.primary)
                    }
                    if (review.isNotEmpty()) {
                        pr.reviewNote?.let { RunovaText(it, style = RunovaType.small, color = colors.mutedForeground) }
                        RunovaTextArea(review, { review = it }, "The review", minHeight = 160.dp)
                        RunovaButton(
                            "Post as a comment",
                            onClick = { intents.postReview(review) },
                            Modifier.fillMaxWidth(),
                            icon = RunovaIcons.Send,
                        )
                    }
                }
                if (pr.canCreate) {
                    RunovaText("${pr.branchLabel} into ${pr.base}, ${pr.aheadLabel}", style = RunovaType.small, color = colors.mutedForeground)
                    if (pr.dirty) {
                        RunovaText("You have uncommitted changes that won't be included.", style = RunovaType.small, color = colors.warning)
                    }
                    RunovaButton(
                        if (pr.suggesting) "Stop" else "Write it with AI",
                        onClick = if (pr.suggesting) intents.cancelPrAi else intents.suggestPr,
                        Modifier.fillMaxWidth(),
                        kind = if (pr.suggesting) ButtonKind.Danger else ButtonKind.Tint,
                        icon = if (pr.suggesting) RunovaIcons.Stop else RunovaIcons.Sparkles,
                    )
                    RunovaTextField(title, { title = it }, "Title", icon = RunovaIcons.Edit)
                    RunovaTextArea(body, { body = it }, "What changed and why", minHeight = 120.dp)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        RunovaText("Open as a draft", Modifier.weight(1f), RunovaType.label)
                        RunovaToggle(draft, { draft = it }, "Open as a draft")
                    }
                    RunovaButton(
                        "Open pull request",
                        onClick = { intents.createPr(title.trim(), body, draft) },
                        Modifier.fillMaxWidth(),
                        enabled = title.isNotBlank() && !pr.suggesting,
                        icon = RunovaIcons.Git,
                    )
                }
                pr.fallbackUrl?.let { url ->
                    RunovaChip("Finish on GitHub", { links.openUri(url) }, icon = RunovaIcons.External, tone = ChipTone.Primary)
                }
            }
        }
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
        tone = if (working) ChipTone.Danger else ChipTone.Primary,
    )
}
