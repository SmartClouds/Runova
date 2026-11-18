package com.runovahq.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.runovahq.app.design.BadgeTone
import com.runovahq.app.design.ButtonKind
import com.runovahq.app.design.ChipTone
import com.runovahq.app.design.RunovaButton
import com.runovahq.app.design.RunovaCard
import com.runovahq.app.design.RunovaChip
import com.runovahq.app.design.RunovaHeroIcon
import com.runovahq.app.design.RunovaIcon
import com.runovahq.app.design.RunovaIconTile
import com.runovahq.app.design.RunovaIcons
import com.runovahq.app.design.RunovaScreen
import com.runovahq.app.design.RunovaSectionTitle
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTextField
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaType
import uniffi.runova_ffi.SendBatchView
import uniffi.runova_ffi.SendFileState
import uniffi.runova_ffi.SendFileView
import uniffi.runova_ffi.SendPhase
import uniffi.runova_ffi.SendScreen
import uniffi.runova_ffi.SendTargetView
import uniffi.runova_ffi.fileSizeLabel
import uniffi.runova_ffi.filesSummary
import uniffi.runova_ffi.sendButtonLabel

/** A file picked on the phone: native code's handle on its bytes, and where it goes on the other side. */
data class StagedFile(val handle: String, val path: String, val size: Long)

/**
 * What is picked and not sent yet. It stays on the phone's side because the picks are the
 * phone's own documents; the core gets the list when Send is pressed.
 */
class SendPicks {
    val files = mutableStateListOf<StagedFile>()
    var open by mutableStateOf(false)
    var target by mutableStateOf<Long?>(null)
    var note by mutableStateOf("")

    fun add(more: List<StagedFile>) {
        val have = files.map { it.handle }.toSet()
        files.addAll(more.filter { it.handle !in have })
    }

    fun remove(handles: Set<String>) {
        files.removeAll { it.handle in handles }
    }
}

/** What the Send files screen can ask for (E113). The pickers are the activity's. */
data class SendIntents(
    val picks: SendPicks = SendPicks(),
    val pickFiles: () -> Unit = {},
    val pickPhotos: () -> Unit = {},
    val pickFolder: () -> Unit = {},
    val send: (systemId: Long, files: List<StagedFile>, note: String?) -> Unit = { _, _, _ -> },
    val cancel: (String) -> Unit = {},
    val retry: (String) -> Unit = {},
    val dismiss: (String) -> Unit = {},
    val clearFinished: () -> Unit = {},
    val dismissError: () -> Unit = {},
)

private val ACTIVE = setOf(SendPhase.CONNECTING, SendPhase.WAITING, SendPhase.SENDING, SendPhase.RECONNECTING)
private val WAITING = setOf(SendPhase.CONNECTING, SendPhase.WAITING, SendPhase.RECONNECTING)

private data class Kind(val icon: String, val tone: BadgeTone)

/** The tile a file leads with, by what its name says it is. */
private fun kindOf(name: String): Kind = when (name.substringAfterLast('.', "").lowercase()) {
    "jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "svg", "raw", "dng" -> Kind(RunovaIcons.Image, BadgeTone.Primary)
    "mp4", "mov", "mkv", "avi", "webm", "m4v", "3gp" -> Kind(RunovaIcons.Video, BadgeTone.Warning)
    "mp3", "wav", "m4a", "aac", "flac", "ogg", "opus" -> Kind(RunovaIcons.Mic, BadgeTone.Success)
    "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz" -> Kind(RunovaIcons.Stash, BadgeTone.Neutral)
    "kt", "rs", "ts", "tsx", "js", "py", "java", "swift", "go", "c", "cpp", "h", "cs", "json", "yml", "yaml", "sh" ->
        Kind(RunovaIcons.Code, BadgeTone.Primary)
    "pdf", "doc", "docx", "txt", "md", "rtf", "odt", "xls", "xlsx", "csv", "ppt", "pptx", "pages", "key" ->
        Kind(RunovaIcons.Logs, BadgeTone.Neutral)
    else -> Kind(RunovaIcons.File, BadgeTone.Neutral)
}

/** A picked folder shows as one row, with everything in it. */
private data class StagedGroup(val key: String, val title: String, val folder: Boolean, val files: List<StagedFile>)

private fun groupsOf(files: List<StagedFile>): List<StagedGroup> {
    val groups = LinkedHashMap<String, MutableList<StagedFile>>()
    for (file in files) {
        val top = file.path.substringBefore('/', missingDelimiterValue = "")
        groups.getOrPut(if (top.isEmpty()) "file:${file.handle}" else "dir:$top") { mutableListOf() } += file
    }
    return groups.map { (key, members) ->
        val folder = key.startsWith("dir:")
        StagedGroup(key, if (folder) key.removePrefix("dir:") else members[0].path, folder, members)
    }
}

/** The Send files screen: what to send, where to, and every send so far. */
@Composable
fun SendFilesScreen(screen: SendScreen, intents: SendIntents, onClose: () -> Unit) {
    val picks = intents.picks
    BackHandler(onBack = onClose)
    RunovaScreen("Send files", subtitle = "To your computers and your team's", onBack = onClose) {
        // What is going now comes first; what has finished waits below the composer.
        val live = screen.batches.filter { it.phase in ACTIVE }
        val finished = screen.batches.filter { it.phase !in ACTIVE }
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (live.isNotEmpty()) {
                item(key = "live-title") { SectionHead("Sending", null) }
                items(live, key = { it.batchId }) { BatchCard(it, intents) }
            }
            item(key = "files-title") { SectionHead("Files", null) }
            item(key = "files") {
                if (picks.files.isEmpty()) EmptyPick(intents) else StagedCard(picks, intents)
            }
            item(key = "to-title") { SectionHead("Send to", null) }
            item(key = "to") { TargetPicker(screen.targets, picks) }
            item(key = "note") {
                RunovaTextField(
                    picks.note,
                    { picks.note = it.take(500) },
                    "Add a note (optional)",
                    icon = RunovaIcons.Edit,
                    label = "A note for the other side",
                )
            }
            item(key = "send") { SendAction(screen, intents) }
            if (finished.isNotEmpty()) {
                item(key = "sent-title") {
                    Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        RunovaSectionTitle("Sent", Modifier.weight(1f))
                        RunovaChip("Clear finished", onClick = intents.clearFinished)
                    }
                }
                items(finished, key = { it.batchId }) { BatchCard(it, intents) }
            }
            item(key = "end") { Spacer(Modifier.height(8.dp)) }
        }
    }
}

@Composable
private fun SectionHead(title: String, detail: String?) {
    Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        RunovaSectionTitle(title, Modifier.weight(1f))
        if (detail != null) RunovaText(detail, style = RunovaType.caption, color = RunovaTheme.colors.mutedForeground, maxLines = 1)
    }
}

@Composable
private fun PickerChips(intents: SendIntents, adding: Boolean) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        RunovaChip(if (adding) "Add files" else "Files", onClick = intents.pickFiles, icon = RunovaIcons.File, tone = ChipTone.Primary)
        RunovaChip("Photos", onClick = intents.pickPhotos, icon = RunovaIcons.Image)
        RunovaChip("Folder", onClick = intents.pickFolder, icon = RunovaIcons.Folder)
    }
}

@Composable
private fun EmptyPick(intents: SendIntents) {
    val colors = RunovaTheme.colors
    val shape = RoundedCornerShape(20.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(colors.primary.copy(alpha = 0.04f))
            .border(1.dp, colors.primary.copy(alpha = 0.22f), shape)
            .padding(horizontal = 20.dp, vertical = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        RunovaHeroIcon(RunovaIcons.Send)
        RunovaText("Pick what to send", style = RunovaType.title)
        RunovaText(
            "Files, photos or a whole folder. They go straight to the computer, encrypted all the way.",
            color = colors.mutedForeground,
            align = TextAlign.Center,
        )
        Spacer(Modifier.height(2.dp))
        PickerChips(intents, adding = false)
    }
}

@Composable
private fun StagedCard(picks: SendPicks, intents: SendIntents) {
    val colors = RunovaTheme.colors
    RunovaCard(Modifier.fillMaxWidth(), padding = PaddingValues(0.dp)) {
        Column {
            groupsOf(picks.files).forEach { group ->
                val bytes = group.files.sumOf { it.size }.toULong()
                val kind = if (group.folder) Kind(RunovaIcons.Folder, BadgeTone.Warning) else kindOf(group.title)
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = 12.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    RunovaIconTile(kind.icon, kind.tone)
                    Column(Modifier.weight(1f)) {
                        RunovaText(group.title, style = RunovaType.label.copy(fontWeight = FontWeight.SemiBold), maxLines = 1)
                        RunovaText(
                            if (group.folder) filesSummary(group.files.size.toUInt(), bytes) else fileSizeLabel(bytes),
                            style = RunovaType.small,
                            color = colors.mutedForeground,
                            maxLines = 1,
                        )
                    }
                    Box(
                        Modifier
                            .size(40.dp)
                            .clip(CircleShape)
                            .clickable(role = Role.Button) { picks.remove(group.files.map { it.handle }.toSet()) }
                            .semantics { contentDescription = "Take out ${group.title}" },
                        contentAlignment = Alignment.Center,
                    ) { RunovaIcon(RunovaIcons.Close, size = 12.dp, color = colors.mutedForeground) }
                }
            }
            Box(Modifier.fillMaxWidth().height(1.dp).background(colors.border.copy(alpha = 0.6f)))
            Row(
                Modifier.fillMaxWidth().padding(start = 16.dp, end = 12.dp, top = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RunovaText(
                    filesSummary(picks.files.size.toUInt(), picks.files.sumOf { it.size }.toULong()),
                    Modifier.weight(1f),
                    style = RunovaType.small.copy(fontWeight = FontWeight.Medium),
                    color = colors.mutedForeground,
                    maxLines = 1,
                )
                RunovaChip("Clear", onClick = { picks.files.clear() }, icon = RunovaIcons.Trash, tone = ChipTone.Danger)
            }
            Box(Modifier.padding(12.dp)) { PickerChips(intents, adding = true) }
        }
    }
}

@Composable
private fun TargetPicker(targets: List<SendTargetView>, picks: SendPicks) {
    val colors = RunovaTheme.colors
    if (targets.isEmpty()) {
        RunovaText(
            "No computers to send to yet. Sign in to Runova on a computer with this account and it shows up here.",
            color = colors.mutedForeground,
        )
        return
    }
    // A choice that can no longer take files is no choice.
    val chosen = targets.firstOrNull { it.systemId == picks.target && it.canReceive }
    if (chosen == null && picks.target != null) picks.target = null
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        val own = targets.filter { it.own }
        val team = targets.filter { !it.own }
        if (own.isNotEmpty()) {
            if (team.isNotEmpty()) GroupLabel("My computers")
            own.forEach { TargetCard(it, it.systemId == chosen?.systemId) { picks.target = it.systemId } }
        }
        if (team.isNotEmpty()) {
            GroupLabel("Teammates' computers")
            team.forEach { TargetCard(it, it.systemId == chosen?.systemId) { picks.target = it.systemId } }
        }
    }
}

@Composable
private fun GroupLabel(text: String) {
    RunovaText(text, Modifier.padding(start = 4.dp, top = 2.dp), style = RunovaType.caption, color = RunovaTheme.colors.mutedForeground)
}

@Composable
private fun TargetCard(target: SendTargetView, selected: Boolean, onPick: () -> Unit) {
    val colors = RunovaTheme.colors
    val shape = RoundedCornerShape(16.dp)
    val edge = if (selected) colors.primary.copy(alpha = 0.85f) else colors.foreground.copy(alpha = 0.08f)
    Row(
        Modifier
            .fillMaxWidth()
            .alpha(if (target.canReceive) 1f else 0.55f)
            .clip(shape)
            .background(if (selected) colors.primary.copy(alpha = 0.08f) else colors.foreground.copy(alpha = 0.03f))
            .border(if (selected) 1.5.dp else 1.dp, edge, shape)
            .clickable(enabled = target.canReceive, role = Role.RadioButton, onClick = onPick)
            .semantics { this.selected = selected }
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box {
            RunovaIconTile(RunovaIcons.Systems, if (target.canReceive) BadgeTone.Primary else BadgeTone.Neutral)
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .size(10.dp)
                    .clip(CircleShape)
                    .background(colors.background)
                    .padding(2.dp)
                    .clip(CircleShape)
                    .background(if (target.online) colors.success else colors.mutedForeground.copy(alpha = 0.6f)),
            )
        }
        Column(Modifier.weight(1f)) {
            RunovaText(target.name, style = RunovaType.label.copy(fontWeight = FontWeight.SemiBold), maxLines = 1)
            RunovaText(
                target.reason ?: platformName(target.platform),
                style = RunovaType.small,
                color = colors.mutedForeground,
                maxLines = 2,
            )
        }
        Box(
            Modifier
                .size(22.dp)
                .clip(CircleShape)
                .background(if (selected) colors.primary else Color.Transparent)
                .border(1.5.dp, if (selected) colors.primary else colors.foreground.copy(alpha = 0.2f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            if (selected) RunovaIcon(RunovaIcons.Check, size = 11.dp, color = colors.primaryForeground)
        }
    }
}

@Composable
private fun SendAction(screen: SendScreen, intents: SendIntents) {
    val colors = RunovaTheme.colors
    val picks = intents.picks
    val target = screen.targets.firstOrNull { it.systemId == picks.target && it.canReceive }
    val ready = picks.files.isNotEmpty() && target != null
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        screen.error?.let { error ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(14.dp))
                    .background(colors.destructive.copy(alpha = 0.1f))
                    .padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RunovaIcon(RunovaIcons.Warning, size = 13.dp, color = colors.destructive)
                RunovaText(error, Modifier.weight(1f).padding(horizontal = 10.dp), style = RunovaType.small, color = colors.destructive)
                Box(
                    Modifier
                        .size(36.dp)
                        .clip(CircleShape)
                        .clickable(role = Role.Button, onClick = intents.dismissError)
                        .semantics { contentDescription = "Dismiss the error" },
                    contentAlignment = Alignment.Center,
                ) { RunovaIcon(RunovaIcons.Close, size = 11.dp, color = colors.destructive) }
            }
        }
        RunovaButton(
            sendButtonLabel(picks.files.size.toUInt(), target?.name),
            onClick = {
                val system = target?.systemId ?: return@RunovaButton
                intents.send(system, picks.files.toList(), picks.note.trim().ifEmpty { null })
                picks.files.clear()
                picks.note = ""
            },
            Modifier.fillMaxWidth(),
            enabled = ready,
            icon = RunovaIcons.Send,
        )
        val missing = when {
            picks.files.isEmpty() -> "Pick files to send first."
            target == null -> "Choose a computer to send to."
            else -> null
        }
        if (missing != null) {
            RunovaText(missing, Modifier.fillMaxWidth(), style = RunovaType.small, color = colors.mutedForeground, align = TextAlign.Center)
        }
    }
}

@Composable
private fun BatchCard(batch: SendBatchView, intents: SendIntents) {
    val colors = RunovaTheme.colors
    var expanded by rememberSaveable(batch.batchId) { mutableStateOf(false) }
    val (tone, ink) = when (batch.phase) {
        SendPhase.DONE -> BadgeTone.Success to colors.success
        SendPhase.DECLINED, SendPhase.FAILED, SendPhase.EXPIRED -> BadgeTone.Danger to colors.destructive
        SendPhase.CANCELLED -> BadgeTone.Neutral to colors.mutedForeground
        else -> BadgeTone.Primary to colors.mutedForeground
    }
    RunovaCard(Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                RunovaIconTile(if (batch.phase == SendPhase.DONE) RunovaIcons.Check else RunovaIcons.Send, tone)
                Column(Modifier.weight(1f)) {
                    RunovaText(batch.title, style = RunovaType.label.copy(fontWeight = FontWeight.SemiBold), maxLines = 1)
                    RunovaText(batch.sizeLabel, style = RunovaType.small, color = colors.mutedForeground, maxLines = 1)
                }
                if (batch.phase in ACTIVE) {
                    RunovaText("${batch.percent}%", style = RunovaType.label.copy(fontWeight = FontWeight.SemiBold), color = colors.primary)
                }
            }
            batch.note?.let {
                RunovaText("“$it”", style = RunovaType.small.copy(fontStyle = FontStyle.Italic), color = colors.mutedForeground, maxLines = 3)
            }
            SendRunway(batch.percent.toInt(), batch.phase)
            RunovaText(
                batch.status,
                Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                style = RunovaType.small,
                color = ink,
            )
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (batch.canCancel) RunovaChip("Cancel", onClick = { intents.cancel(batch.batchId) }, icon = RunovaIcons.Close, tone = ChipTone.Danger)
                if (batch.canRetry) RunovaChip("Send again", onClick = { intents.retry(batch.batchId) }, icon = RunovaIcons.Refresh, tone = ChipTone.Primary)
                if (batch.canDismiss) RunovaChip("Dismiss", onClick = { intents.dismiss(batch.batchId) })
                if (batch.files.isNotEmpty()) {
                    RunovaChip(if (expanded) "Hide files" else "Show files", onClick = { expanded = !expanded }, icon = RunovaIcons.Processes)
                }
            }
            if (expanded) {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    batch.files.forEach { FileLine(it) }
                    if (batch.moreFiles > 0u) {
                        RunovaText("And ${batch.moreFiles} more", style = RunovaType.small, color = colors.mutedForeground)
                    }
                }
            }
        }
    }
}

@Composable
private fun FileLine(file: SendFileView) {
    val colors = RunovaTheme.colors
    val kind = kindOf(file.name)
    Row(
        Modifier.fillMaxWidth().padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        RunovaIconTile(kind.icon, kind.tone, size = 28.dp)
        Column(Modifier.weight(1f)) {
            RunovaText(file.name, style = RunovaType.small.copy(fontWeight = FontWeight.Medium), maxLines = 1)
            RunovaText(
                file.error ?: listOfNotNull(file.folder, file.sizeLabel).joinToString(" · "),
                style = RunovaType.caption,
                color = if (file.error != null) colors.destructive else colors.mutedForeground,
                maxLines = 2,
            )
        }
        when (file.state) {
            SendFileState.DONE -> RunovaIcon(RunovaIcons.Success, size = 14.dp, color = colors.success, label = "Arrived")
            SendFileState.FAILED -> RunovaIcon(RunovaIcons.Error, size = 14.dp, color = colors.destructive, label = "Failed")
            SendFileState.SKIPPED -> RunovaIcon(RunovaIcons.Minus, size = 14.dp, color = colors.mutedForeground, label = "Skipped")
            SendFileState.SENDING -> RunovaText("${file.percent}%", style = RunovaType.caption, color = colors.primary)
            SendFileState.QUEUED -> RunovaIcon(RunovaIcons.Clock, size = 13.dp, color = colors.mutedForeground.copy(alpha = 0.6f), label = "Waiting")
        }
    }
}

/**
 * How far a send is, drawn as a runway: a dashed centre line the progress runs along, a lit head
 * while bytes move, and a soft sweep while it waits for the other side.
 */
@Composable
fun SendRunway(percent: Int, phase: SendPhase, modifier: Modifier = Modifier) {
    val colors = RunovaTheme.colors
    val motion = motionOn()
    val done = phase == SendPhase.DONE
    val target = if (done) 1f else (percent / 100f).coerceIn(0f, 1f)
    val fill by animateFloatAsState(target, tween(if (motion) 450 else 0), label = "runway")
    val ink = when (phase) {
        SendPhase.DONE -> colors.success
        SendPhase.DECLINED, SendPhase.FAILED, SendPhase.EXPIRED -> colors.destructive
        SendPhase.CANCELLED -> colors.mutedForeground
        else -> colors.primary
    }
    val sweeping = phase in WAITING && motion
    val sweep = if (sweeping) {
        val transition = rememberInfiniteTransition(label = "runway sweep")
        val value by transition.animateFloat(0f, 1f, infiniteRepeatable(tween(1600, easing = LinearEasing)), label = "sweep")
        value
    } else {
        null
    }
    val track = colors.foreground.copy(alpha = 0.07f)
    val dash = colors.foreground.copy(alpha = 0.2f)
    Canvas(
        modifier
            .fillMaxWidth()
            .height(12.dp)
            .semantics { progressBarRangeInfo = ProgressBarRangeInfo(fill, 0f..1f) },
    ) {
        val mid = size.height / 2
        val bar = 6.dp.toPx()
        val radius = CornerRadius(bar / 2)
        val top = Offset(0f, mid - bar / 2)
        drawRoundRect(track, topLeft = top, size = Size(size.width, bar), cornerRadius = radius)
        drawLine(
            dash,
            Offset(bar, mid),
            Offset(size.width - bar, mid),
            strokeWidth = 1.dp.toPx(),
            pathEffect = PathEffect.dashPathEffect(floatArrayOf(5.dp.toPx(), 5.dp.toPx())),
        )
        val reach = size.width * fill
        if (reach > 0f) {
            drawRoundRect(
                Brush.horizontalGradient(listOf(ink.copy(alpha = 0.45f), ink), startX = 0f, endX = reach.coerceAtLeast(1f)),
                topLeft = top,
                size = Size(reach.coerceAtLeast(bar), bar),
                cornerRadius = radius,
            )
        }
        if (phase == SendPhase.SENDING && reach > 0f) {
            drawCircle(ink.copy(alpha = 0.22f), radius = size.height / 2 + 1.dp.toPx(), center = Offset(reach, mid))
            drawCircle(ink, radius = size.height / 2 - 2.dp.toPx(), center = Offset(reach, mid))
        }
        if (sweep != null) {
            val glow = 56.dp.toPx()
            val x = -glow + (size.width + glow * 2) * sweep
            drawRoundRect(
                Brush.horizontalGradient(listOf(Color.Transparent, ink.copy(alpha = 0.35f), Color.Transparent), startX = x - glow, endX = x + glow),
                topLeft = top,
                size = Size(size.width, bar),
                cornerRadius = radius,
            )
        }
    }
}

/** The line on the Systems tab while files are going, which opens the Send files screen. */
@Composable
fun SendingStrip(screen: SendScreen, onOpen: () -> Unit) {
    val label = screen.progressLabel ?: return
    val colors = RunovaTheme.colors
    val shape = RoundedCornerShape(16.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(colors.primary.copy(alpha = 0.08f))
            .border(1.dp, colors.primary.copy(alpha = 0.22f), shape)
            .clickable(role = Role.Button, onClick = onOpen)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            RunovaIcon(RunovaIcons.Send, size = 13.dp, color = colors.primary)
            RunovaText(label, Modifier.weight(1f), style = RunovaType.small.copy(fontWeight = FontWeight.Medium), maxLines = 1)
            RunovaIcon(RunovaIcons.Forward, size = 10.dp, color = colors.mutedForeground)
        }
        SendRunway(screen.progressPercent.toInt(), SendPhase.SENDING)
    }
}

/** The Systems tab's way in. */
@Composable
fun SendFilesButton(onOpen: () -> Unit) {
    val colors = RunovaTheme.colors
    Box(
        Modifier
            .padding(end = 4.dp)
            .size(40.dp)
            .clip(CircleShape)
            .background(colors.primary.copy(alpha = 0.13f))
            .clickable(role = Role.Button, onClick = onOpen)
            .semantics { contentDescription = "Send files" },
        contentAlignment = Alignment.Center,
    ) { RunovaIcon(RunovaIcons.Send, size = 15.dp, color = colors.primary) }
}
