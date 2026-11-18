package com.runovahq.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
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
import com.runovahq.app.design.RunovaSectionTitle
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaToggle
import com.runovahq.app.design.RunovaType
import uniffi.runova_ffi.IncomingOfferView
import uniffi.runova_ffi.ReceivePhase
import uniffi.runova_ffi.ReceiveScreen
import uniffi.runova_ffi.ReceivedBatchView
import uniffi.runova_ffi.ReceivedFileView
import uniffi.runova_ffi.SendFileState
import uniffi.runova_ffi.SendPhase

/** What files sent to the phone can ask for (E114). Opening and sharing are the activity's. */
data class ReceiveIntents(
    val answer: (id: String, accept: Boolean) -> Unit = { _, _ -> },
    val cancel: (String) -> Unit = {},
    val dismiss: (String) -> Unit = {},
    val clear: () -> Unit = {},
    val setEnabled: (Boolean) -> Unit = {},
    val setAutoAccept: (Boolean) -> Unit = {},
    /** Opens a received file in the app that takes it. */
    val open: (path: String) -> Unit = {},
    /** Hands a received file to the share sheet, which includes saving it elsewhere. */
    val share: (path: String) -> Unit = {},
)

private val ReceiveLive = setOf(ReceivePhase.CONNECTING, ReceivePhase.ASKING, ReceivePhase.RECEIVING, ReceivePhase.RECONNECTING)

/** The runway speaks in send phases; a receive reads the same way. */
private fun runwayPhase(phase: ReceivePhase): SendPhase = when (phase) {
    ReceivePhase.CONNECTING -> SendPhase.CONNECTING
    ReceivePhase.ASKING -> SendPhase.WAITING
    ReceivePhase.RECEIVING -> SendPhase.SENDING
    ReceivePhase.RECONNECTING -> SendPhase.RECONNECTING
    ReceivePhase.DONE -> SendPhase.DONE
    ReceivePhase.DECLINED -> SendPhase.DECLINED
    ReceivePhase.CANCELLED -> SendPhase.CANCELLED
    ReceivePhase.FAILED -> SendPhase.FAILED
}

/**
 * Files on their way to this phone, waiting for a yes or a no. It comes up over whatever is on
 * show, and saying nothing for a minute turns the files away on its own.
 */
@Composable
fun IncomingOfferSheet(offer: IncomingOfferView, intents: ReceiveIntents) {
    val colors = RunovaTheme.colors
    val shape = RoundedCornerShape(24.dp)
    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.6f))
            .clickable(interactionSource = null, indication = null) {},
        contentAlignment = Alignment.BottomCenter,
    ) {
        Column(
            Modifier
                .padding(12.dp)
                .fillMaxWidth()
                .clip(shape)
                .background(colors.background)
                .border(1.dp, colors.primary.copy(alpha = 0.25f), shape)
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                RunovaHeroIcon(RunovaIcons.Pull)
                Column(Modifier.weight(1f)) {
                    RunovaText(offer.title, style = RunovaType.title)
                    RunovaText("From ${offer.person} · ${offer.sizeLabel}", style = RunovaType.small, color = colors.mutedForeground)
                }
            }
            offer.note?.let {
                RunovaText("“$it”", style = RunovaType.body.copy(fontStyle = FontStyle.Italic), color = colors.mutedForeground, maxLines = 4)
            }
            RunovaCard(Modifier.fillMaxWidth(), padding = PaddingValues(horizontal = 12.dp, vertical = 4.dp)) {
                Column {
                    offer.files.take(4).forEach { file ->
                        val kind = kindFor(file.name)
                        Row(
                            Modifier.fillMaxWidth().padding(vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            RunovaIconTile(kind.first, kind.second, size = 28.dp)
                            Column(Modifier.weight(1f)) {
                                RunovaText(file.name, style = RunovaType.small.copy(fontWeight = FontWeight.Medium), maxLines = 1)
                                RunovaText(
                                    listOfNotNull(file.folder, file.sizeLabel).joinToString(" · "),
                                    style = RunovaType.caption,
                                    color = colors.mutedForeground,
                                    maxLines = 1,
                                )
                            }
                        }
                    }
                    val more = offer.files.size - 4 + offer.moreFiles.toInt()
                    if (more > 0) {
                        RunovaText("And $more more", Modifier.padding(vertical = 6.dp), style = RunovaType.small, color = colors.mutedForeground)
                    }
                }
            }
            RunovaText(
                "They go to Runova's Received folder on this phone, checked against the sender's copy.",
                style = RunovaType.small,
                color = colors.mutedForeground,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                RunovaButton("Decline", onClick = { intents.answer(offer.id, false) }, Modifier.weight(1f), kind = ButtonKind.Soft)
                RunovaButton("Accept", onClick = { intents.answer(offer.id, true) }, Modifier.weight(1f), icon = RunovaIcons.Check)
            }
        }
    }
}

private fun kindFor(name: String): Pair<String, BadgeTone> = when (name.substringAfterLast('.', "").lowercase()) {
    "jpg", "jpeg", "png", "gif", "webp", "heic", "heif" -> RunovaIcons.Image to BadgeTone.Primary
    "mp4", "mov", "mkv", "webm", "m4v" -> RunovaIcons.Video to BadgeTone.Warning
    "mp3", "wav", "m4a", "aac", "flac", "ogg" -> RunovaIcons.Mic to BadgeTone.Success
    "zip", "rar", "7z", "tar", "gz" -> RunovaIcons.Stash to BadgeTone.Neutral
    "pdf", "doc", "docx", "txt", "md", "xls", "xlsx", "csv", "ppt", "pptx" -> RunovaIcons.Logs to BadgeTone.Neutral
    else -> RunovaIcons.File to BadgeTone.Neutral
}

/** Received sends and the phone's own rules for them, as items of the Send files screen. */
fun LazyListScope.receivedItems(screen: ReceiveScreen, intents: ReceiveIntents) {
    if (screen.batches.isNotEmpty()) {
        item(key = "received-title") {
            Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                RunovaSectionTitle("Received", Modifier.weight(1f))
                if (screen.batches.any { it.phase !in ReceiveLive }) {
                    RunovaChip("Clear received", onClick = intents.clear)
                }
            }
        }
        items(screen.batches, key = { "received-${it.id}" }) { ReceivedCard(it, intents) }
    }
    item(key = "receive-settings") { ReceiveSettingsCard(screen, intents) }
}

@Composable
private fun ReceivedCard(batch: ReceivedBatchView, intents: ReceiveIntents) {
    val colors = RunovaTheme.colors
    val (tone, ink) = when (batch.phase) {
        ReceivePhase.DONE -> BadgeTone.Success to colors.success
        ReceivePhase.FAILED -> BadgeTone.Danger to colors.destructive
        ReceivePhase.DECLINED, ReceivePhase.CANCELLED -> BadgeTone.Neutral to colors.mutedForeground
        else -> BadgeTone.Primary to colors.mutedForeground
    }
    RunovaCard(Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                RunovaIconTile(if (batch.phase == ReceivePhase.DONE) RunovaIcons.Check else RunovaIcons.Pull, tone)
                Column(Modifier.weight(1f)) {
                    RunovaText(batch.title, style = RunovaType.label.copy(fontWeight = FontWeight.SemiBold), maxLines = 1)
                    RunovaText(batch.sizeLabel, style = RunovaType.small, color = colors.mutedForeground, maxLines = 1)
                }
                if (batch.phase in ReceiveLive) {
                    RunovaText("${batch.percent}%", style = RunovaType.label.copy(fontWeight = FontWeight.SemiBold), color = colors.primary)
                }
            }
            SendRunway(batch.percent.toInt(), runwayPhase(batch.phase))
            RunovaText(batch.status, Modifier.semantics { liveRegion = LiveRegionMode.Polite }, style = RunovaType.small, color = ink)
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                batch.files.forEach { ReceivedLine(it, intents) }
                if (batch.moreFiles > 0u) {
                    RunovaText("And ${batch.moreFiles} more", style = RunovaType.small, color = colors.mutedForeground)
                }
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (batch.canCancel) RunovaChip("Stop", onClick = { intents.cancel(batch.id) }, icon = RunovaIcons.Close, tone = ChipTone.Danger)
                if (batch.canDismiss) RunovaChip("Dismiss", onClick = { intents.dismiss(batch.id) })
            }
        }
    }
}

@Composable
private fun ReceivedLine(file: ReceivedFileView, intents: ReceiveIntents) {
    val colors = RunovaTheme.colors
    val kind = kindFor(file.name)
    val path = file.path
    Row(
        Modifier.fillMaxWidth().heightIn(min = 44.dp).padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        RunovaIconTile(kind.first, kind.second, size = 28.dp)
        Column(Modifier.weight(1f)) {
            RunovaText(file.name, style = RunovaType.small.copy(fontWeight = FontWeight.Medium), maxLines = 1)
            RunovaText(
                file.error ?: listOfNotNull(file.folder, file.sizeLabel).joinToString(" · "),
                style = RunovaType.caption,
                color = if (file.error != null) colors.destructive else colors.mutedForeground,
                maxLines = 2,
            )
        }
        if (file.state == SendFileState.DONE && path != null) {
            FileAction(RunovaIcons.External, "Open ${file.name}") { intents.open(path) }
            FileAction(RunovaIcons.Push, "Share ${file.name}") { intents.share(path) }
        } else if (file.state == SendFileState.SENDING) {
            RunovaText("${file.percent}%", style = RunovaType.caption, color = colors.primary)
        } else if (file.state == SendFileState.FAILED) {
            RunovaIcon(RunovaIcons.Error, size = 14.dp, color = colors.destructive, label = "Failed")
        }
    }
}

@Composable
private fun FileAction(icon: String, label: String, onClick: () -> Unit) {
    val colors = RunovaTheme.colors
    Box(
        Modifier
            .size(36.dp)
            .clip(CircleShape)
            .background(colors.foreground.copy(alpha = 0.05f))
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) { RunovaIcon(icon, size = 12.dp, color = colors.foreground.copy(alpha = 0.85f)) }
}

@Composable
private fun ReceiveSettingsCard(screen: ReceiveScreen, intents: ReceiveIntents) {
    val colors = RunovaTheme.colors
    Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        RunovaSectionTitle("Receiving on this phone")
        RunovaCard(Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                SettingRow(
                    "Take files from my computers",
                    "While Runova is open, your own computers can send files here. You see each send before it comes in.",
                    screen.enabled,
                    intents.setEnabled,
                )
                SettingRow(
                    "Accept from my computers without asking",
                    "Files you send yourself from a computer come straight in.",
                    screen.autoAccept,
                    intents.setAutoAccept,
                    enabled = screen.enabled,
                )
                RunovaText(
                    "Only your own computers can send to this phone. Received files stay in Runova until you open, share or save them.",
                    style = RunovaType.caption,
                    color = colors.mutedForeground,
                )
            }
        }
    }
}

@Composable
private fun SettingRow(title: String, detail: String, on: Boolean, onChange: (Boolean) -> Unit, enabled: Boolean = true) {
    val colors = RunovaTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f)) {
            RunovaText(title, style = RunovaType.label.copy(fontWeight = FontWeight.SemiBold))
            RunovaText(detail, style = RunovaType.small, color = colors.mutedForeground)
        }
        RunovaToggle(on, onChange, title, enabled = enabled)
    }
}
