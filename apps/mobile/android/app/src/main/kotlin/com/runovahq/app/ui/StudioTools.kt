package com.runovahq.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.runovahq.app.design.BadgeTone
import com.runovahq.app.design.ButtonKind
import com.runovahq.app.design.ChipTone
import com.runovahq.app.design.RunovaButton
import com.runovahq.app.design.RunovaChip
import com.runovahq.app.design.RunovaIcon
import com.runovahq.app.design.RunovaIconTile
import com.runovahq.app.design.RunovaIcons
import com.runovahq.app.design.RunovaProgress
import com.runovahq.app.design.RunovaScreen
import com.runovahq.app.design.RunovaSectionTitle
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaType
import com.runovahq.app.design.runovaGlass
import uniffi.runova_ffi.StudioClipView
import uniffi.runova_ffi.StudioDownloadState
import uniffi.runova_ffi.StudioDownloadView
import uniffi.runova_ffi.StudioNarrationView
import uniffi.runova_ffi.StudioTimelineView
import uniffi.runova_ffi.StudioTrackView
import uniffi.runova_ffi.StudioVoiceView

@Composable
private fun PickRow(items: List<Pair<String, String>>, selected: String?, onPick: (String) -> Unit) {
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        items.forEach { (id, label) ->
            RunovaChip(label, { onPick(id) }, tone = if (id == selected) ChipTone.Primary else ChipTone.Soft)
        }
    }
}

@Composable
fun NarrationCard(narration: StudioNarrationView, intents: StudioIntents) {
    val colors = RunovaTheme.colors
    Column(Modifier.fillMaxWidth().runovaGlass().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            RunovaIconTile(RunovaIcons.Mic, if (narration.running) BadgeTone.Primary else BadgeTone.Danger, size = 34.dp)
            RunovaText(
                narration.label,
                Modifier.weight(1f),
                RunovaType.labelStrong,
                if (narration.running) colors.foreground else colors.destructive,
            )
            if (narration.running) {
                RunovaChip("Stop", intents.cancelSpeak, icon = RunovaIcons.Stop, tone = ChipTone.Danger)
            }
        }
        narration.percent?.let { RunovaProgress(it) }
    }
}

@Composable
fun DownloadCard(download: StudioDownloadView, intents: StudioIntents) {
    val colors = RunovaTheme.colors
    Column(Modifier.fillMaxWidth().runovaGlass().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            RunovaIconTile(
                when (download.state) {
                    StudioDownloadState.DONE -> RunovaIcons.Check
                    StudioDownloadState.FAILED -> RunovaIcons.Warning
                    StudioDownloadState.RUNNING -> RunovaIcons.Pull
                },
                when (download.state) {
                    StudioDownloadState.DONE -> BadgeTone.Success
                    StudioDownloadState.FAILED -> BadgeTone.Danger
                    StudioDownloadState.RUNNING -> BadgeTone.Primary
                },
                size = 34.dp,
            )
            Column(Modifier.weight(1f)) {
                RunovaText(download.fileName.ifEmpty { "Getting the file" }, style = RunovaType.labelStrong, maxLines = 1)
                RunovaText(
                    when (download.state) {
                        StudioDownloadState.RUNNING -> "${download.percent.toInt()}% of ${download.sizeLabel}"
                        StudioDownloadState.DONE -> "On this phone, ${download.sizeLabel}"
                        StudioDownloadState.FAILED -> download.error.orEmpty()
                    },
                    style = RunovaType.small,
                    color = if (download.state == StudioDownloadState.FAILED) colors.destructive else colors.mutedForeground,
                    maxLines = 2,
                )
            }
            if (download.state == StudioDownloadState.RUNNING) {
                RunovaChip("Stop", intents.downloadStop, icon = RunovaIcons.Stop, tone = ChipTone.Danger)
            } else {
                RunovaChip("Clear", intents.downloadDismiss, icon = RunovaIcons.Close)
            }
        }
        if (download.state == StudioDownloadState.RUNNING) RunovaProgress(download.percent)
        if (download.nonCommercial) {
            RunovaText("It uses a voice licensed for non-commercial use only.", style = RunovaType.small, color = colors.warning)
        }
        download.path?.let { path ->
            RunovaButton("Share or save", onClick = { intents.shareVideo(path) }, Modifier.fillMaxWidth(), kind = ButtonKind.Tint, icon = RunovaIcons.Send)
        }
    }
}

/** Pick an engine and a voice, see the price, then speak. */
@Composable
fun VoiceSheet(voice: StudioVoiceView, intents: StudioIntents) {
    val colors = RunovaTheme.colors
    val shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)
    val engine = voice.engines.firstOrNull { it.id == voice.engine }
    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.6f))
            .clickable(interactionSource = null, indication = null, onClick = intents.closeVoice),
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
                RunovaIconTile(RunovaIcons.Mic, size = 38.dp)
                RunovaText("Give it a voice", Modifier.weight(1f), RunovaType.heading)
            }
            RunovaSectionTitle("Engine")
            PickRow(voice.engines.map { it.id to it.label }, voice.engine, intents.pickEngine)
            engine?.problem?.let { RunovaText(it, style = RunovaType.small, color = colors.warning) }
            if (voice.voices.isNotEmpty()) {
                RunovaSectionTitle("Voice", Modifier.padding(top = 4.dp))
                PickRow(voice.voices.map { it.reference to it.label }, voice.voice, intents.pickVoice)
            }
            voice.voices.firstOrNull { it.reference == voice.voice && it.nonCommercial }?.let {
                RunovaText("This voice is for non-commercial use only.", style = RunovaType.small, color = colors.warning)
            }
            voice.priceLabel?.let { RunovaText(it, style = RunovaType.label) }
            voice.error?.let { RunovaText(it, style = RunovaType.small, color = colors.destructive) }
            RunovaButton(
                if (voice.sceneCount == 1u) "Speak 1 scene" else "Speak ${voice.sceneCount} scenes",
                onClick = intents.speak,
                Modifier.fillMaxWidth().padding(top = 4.dp),
                enabled = voice.priceLabel != null,
                icon = RunovaIcons.Mic,
            )
        }
    }
}

private val GAINS = listOf(0.0 to "Mute", 0.5 to "50%", 1.0 to "100%", 1.5 to "150%")
private val FADES = listOf(0.0 to "None", 0.5 to "0.5s", 1.0 to "1s")

@Composable
fun StudioTimelineScreen(timeline: StudioTimelineView, error: String?, intents: StudioIntents) {
    val colors = RunovaTheme.colors
    var selected by remember { mutableStateOf<String?>(null) }
    val clip = timeline.tracks.flatMap { it.clips }.firstOrNull { it.id == selected }
    RunovaScreen("Timeline", subtitle = timeline.lengthLabel.ifEmpty { null }, onBack = intents.closeTimeline) {
        if (timeline.loading) {
            Box(Modifier.weight(1f)) { LoadingRows() }
        } else {
            LazyColumn(
                Modifier.weight(1f),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                error?.let { message ->
                    item(key = "error") { RunovaText(message, style = RunovaType.small, color = colors.destructive) }
                }
                items(timeline.tracks, key = { it.id }) { TrackCard(it, selected, { selected = it }, intents) }
                if (timeline.truncated) {
                    item(key = "cut") {
                        RunovaText("Only the first clips are shown here.", style = RunovaType.small, color = colors.mutedForeground)
                    }
                }
                if (timeline.music.isNotEmpty()) {
                    item(key = "music") {
                        RunovaSectionTitle("Add music", Modifier.padding(top = 6.dp))
                    }
                    items(timeline.music, key = { it.hash }) { song ->
                        Row(
                            Modifier.fillMaxWidth().runovaGlass().padding(10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            RunovaIconTile(RunovaIcons.PlayCircle, size = 32.dp)
                            RunovaText(song.name, Modifier.weight(1f), RunovaType.label, maxLines = 1)
                            RunovaText(song.detail, style = RunovaType.small, color = colors.mutedForeground)
                            RunovaChip("Add", { intents.addMusic(song.hash) }, icon = RunovaIcons.Add)
                        }
                    }
                }
            }
            clip?.let { ClipPanel(it, intents) { selected = null } }
        }
    }
}

@Composable
private fun TrackCard(track: StudioTrackView, selected: String?, onSelect: (String) -> Unit, intents: StudioIntents) {
    val colors = RunovaTheme.colors
    val lane = when (track.kind) {
        "scene" -> colors.primary
        "voice" -> colors.warning
        "music", "sfx" -> Color(0xFF8B5CF6)
        else -> colors.foreground.copy(alpha = 0.5f)
    }
    Column(Modifier.fillMaxWidth().runovaGlass().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            RunovaText(track.name, Modifier.weight(1f), RunovaType.labelStrong, maxLines = 1)
            if (track.locked) {
                RunovaIcon(RunovaIcons.Lock, size = 11.dp, color = colors.mutedForeground)
            } else {
                RunovaChip(
                    if (track.muted) "Muted" else "Mute",
                    { intents.muteTrack(track.id, !track.muted) },
                    tone = if (track.muted) ChipTone.Danger else ChipTone.Soft,
                )
            }
        }
        BoxWithConstraints(
            Modifier
                .fillMaxWidth()
                .height(34.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(colors.foreground.copy(alpha = 0.05f)),
        ) {
            val full = maxWidth
            track.clips.forEach { clip ->
                val on = clip.id == selected
                Box(
                    Modifier
                        .offset(x = full * clip.left.toFloat())
                        .width((full * clip.width.toFloat()).coerceAtLeast(6.dp))
                        .fillMaxHeight()
                        .padding(vertical = 3.dp, horizontal = 1.dp)
                        .clip(RoundedCornerShape(5.dp))
                        .background(lane.copy(alpha = if (on) 0.9f else 0.35f))
                        .border(1.dp, if (on) colors.foreground else Color.Transparent, RoundedCornerShape(5.dp))
                        .clickable(role = Role.Button, enabled = !track.locked) { onSelect(clip.id) }
                        .semantics { contentDescription = clip.label }
                        .padding(horizontal = 4.dp),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    RunovaText(clip.label, style = RunovaType.caption, maxLines = 1)
                }
            }
        }
    }
}

@Composable
private fun ClipPanel(clip: StudioClipView, intents: StudioIntents, onClose: () -> Unit) {
    val colors = RunovaTheme.colors
    Column(
        Modifier.fillMaxWidth().padding(12.dp).runovaGlass().padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f)) {
                RunovaText(clip.label, style = RunovaType.labelStrong, maxLines = 1)
                RunovaText(clip.detail, style = RunovaType.small, color = colors.mutedForeground)
            }
            RunovaChip("Delete", { intents.removeClip(clip.id) }, icon = RunovaIcons.Trash, tone = ChipTone.Danger)
            RunovaChip("Done", onClose)
        }
        Stepper("Move", { intents.nudge(clip.id, -1.0) }, { intents.nudge(clip.id, 1.0) })
        Stepper("Trim start", { intents.trim(clip.id, false, -1.0) }, { intents.trim(clip.id, false, 1.0) })
        Stepper("Trim end", { intents.trim(clip.id, true, -1.0) }, { intents.trim(clip.id, true, 1.0) })
        Row(verticalAlignment = Alignment.CenterVertically) {
            RunovaText("Volume", Modifier.width(76.dp), RunovaType.small, colors.mutedForeground)
            PickRow(GAINS.map { it.second to it.second }, GAINS.firstOrNull { it.first == clip.gain }?.second) { label ->
                intents.gain(clip.id, GAINS.first { it.second == label }.first)
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            RunovaText("Fades", Modifier.width(76.dp), RunovaType.small, colors.mutedForeground)
            PickRow(FADES.map { it.second to it.second }, null) { label ->
                intents.fades(clip.id, FADES.first { it.second == label }.first)
            }
        }
    }
}

@Composable
private fun Stepper(label: String, onLess: () -> Unit, onMore: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        RunovaText(label, Modifier.width(76.dp), RunovaType.small, RunovaTheme.colors.mutedForeground)
        RunovaChip("-1s", onLess)
        RunovaChip("+1s", onMore)
    }
}
