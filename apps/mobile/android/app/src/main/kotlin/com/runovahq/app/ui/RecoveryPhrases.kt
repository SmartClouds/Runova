package com.runovahq.app.ui

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import com.runovahq.app.design.BadgeTone
import com.runovahq.app.design.ButtonKind
import com.runovahq.app.design.RunovaButton
import com.runovahq.app.design.RunovaCard
import com.runovahq.app.design.RunovaEmptyState
import com.runovahq.app.design.RunovaIcon
import com.runovahq.app.design.RunovaIcons
import com.runovahq.app.design.RunovaListRow
import com.runovahq.app.design.RunovaScreen
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaType
import uniffi.runova_ffi.RecoveryPhrasesScreen
import uniffi.runova_ffi.RevealedPhraseView

/** What the recovery phrases screen can ask for (E108). Copy and save are done by the activity. */
data class PhraseIntents(
    val scan: (String) -> Unit = {},
    val reveal: (String) -> Unit = {},
    val hide: () -> Unit = {},
    val delete: (String) -> Unit = {},
    val deleteAnswer: (Boolean) -> Unit = {},
    val unlockVault: (String) -> Unit = {},
    /** Puts the words on the clipboard, marked sensitive, and clears them after a minute. */
    val copy: (String) -> Unit = {},
    /** Asks where to save, then writes the numbered words to a text file. */
    val save: (fileName: String, text: String) -> Unit = { _, _ -> },
)

/** Recovery phrases scanned from a computer, from the Account tab. */
@Composable
fun RecoveryPhrasesView(screen: RecoveryPhrasesScreen, intents: PhraseIntents, onClose: () -> Unit) {
    var scanning by remember { mutableStateOf(false) }
    val revealed = screen.revealed
    when {
        scanning -> QrScanScreen(
            onCode = {
                scanning = false
                intents.scan(it)
            },
            onCancel = { scanning = false },
        )
        revealed != null -> RevealedPhrase(revealed, intents)
        else -> PhraseList(screen, intents, onClose) { scanning = true }
    }
    screen.confirmDelete?.let { id ->
        val label = screen.items.firstOrNull { it.id == id }?.label ?: "this phrase"
        ConfirmDelete(label, intents.deleteAnswer)
    }
}

@Composable
private fun PhraseList(screen: RecoveryPhrasesScreen, intents: PhraseIntents, onClose: () -> Unit, onScan: () -> Unit) {
    val colors = RunovaTheme.colors
    RunovaScreen("Recovery phrases", onBack = onClose) {
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item(key = "intro") {
                RunovaText(
                    "When Runova on a computer makes a recovery phrase, it shows a QR code. Scan it here and " +
                        "the phone keeps the words behind its own lock.",
                    color = colors.mutedForeground,
                )
            }
            item(key = "scan") {
                RunovaButton("Scan a phrase", onClick = onScan, Modifier.fillMaxWidth(), icon = RunovaIcons.QrCode)
            }
            screen.notice?.let { item(key = "notice") { RunovaText(it, style = RunovaType.small, color = colors.primary) } }
            screen.error?.let { item(key = "error") { RunovaText(it, style = RunovaType.small, color = colors.destructive) } }
            if (screen.items.isEmpty()) {
                item(key = "empty") {
                    RunovaEmptyState(RunovaIcons.Key, "No phrases yet", "Phrases you scan show up here.")
                }
            }
            items(screen.items, key = { it.id }) { item ->
                RunovaListRow(
                    title = item.label,
                    detail = "${item.opens} · ${item.saved}",
                    icon = RunovaIcons.Key,
                    onClick = { intents.reveal(item.id) },
                    trailing = {
                        Box(
                            Modifier
                                .size(40.dp)
                                .clip(RoundedCornerShape(20.dp))
                                .clickable { intents.delete(item.id) },
                            contentAlignment = Alignment.Center,
                        ) {
                            RunovaIcon(RunovaIcons.Trash, color = colors.mutedForeground, label = "Delete ${item.label}")
                        }
                    },
                )
            }
        }
    }
}

@Composable
private fun RevealedPhrase(phrase: RevealedPhraseView, intents: PhraseIntents) {
    val colors = RunovaTheme.colors
    var showQr by remember(phrase.id) { mutableStateOf(false) }
    RunovaScreen(phrase.label, subtitle = "Recovery phrase", onBack = intents.hide) {
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item(key = "warn") {
                RunovaText(
                    "Anyone who sees these words can open what they protect. Screenshots are blocked here.",
                    style = RunovaType.small,
                    color = colors.warning,
                )
            }
            item(key = "body") {
                RunovaCard(Modifier.fillMaxWidth()) {
                    if (showQr) PhraseQr(phrase.qrPayload) else WordGrid(phrase.words)
                }
            }
            item(key = "actions") {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        RunovaButton("Copy", onClick = { intents.copy(phrase.words.joinToString(" ")) }, Modifier.weight(1f), kind = ButtonKind.Soft, icon = RunovaIcons.Copy)
                        RunovaButton(
                            "Save to a file",
                            onClick = { intents.save(phrase.fileName, phraseFileText(phrase)) },
                            Modifier.weight(1f),
                            kind = ButtonKind.Soft,
                            icon = RunovaIcons.File,
                        )
                    }
                    RunovaButton(
                        if (showQr) "Show the words" else "Show the QR code",
                        onClick = { showQr = !showQr },
                        Modifier.fillMaxWidth(),
                        kind = ButtonKind.Soft,
                        icon = if (showQr) RunovaIcons.Show else RunovaIcons.QrCode,
                    )
                    if (phrase.canUnlockVault) {
                        RunovaButton(
                            "Unlock the Vault on the computer",
                            onClick = { intents.unlockVault(phrase.id) },
                            Modifier.fillMaxWidth(),
                            kind = ButtonKind.Tint,
                            icon = RunovaIcons.Unlock,
                        )
                    }
                    RunovaButton("Hide", onClick = intents.hide, Modifier.fillMaxWidth(), kind = ButtonKind.Ghost, icon = RunovaIcons.Hide)
                }
            }
        }
    }
}

/** The 24 words in three numbered columns, read down the rows as on the computer. */
@Composable
fun WordGrid(words: List<String>) {
    val colors = RunovaTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        words.chunked(3).forEachIndexed { row, three ->
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                three.forEachIndexed { col, word ->
                    val n = row * 3 + col + 1
                    Row(
                        Modifier
                            .weight(1f)
                            .clip(RoundedCornerShape(10.dp))
                            .background(colors.foreground.copy(alpha = 0.05f))
                            .padding(horizontal = 8.dp, vertical = 7.dp)
                            .semantics { contentDescription = "Word $n, $word" },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RunovaText("$n", style = RunovaType.caption, color = colors.mutedForeground, modifier = Modifier.width(18.dp))
                        RunovaText(word, style = RunovaType.label.copy(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium))
                    }
                }
            }
        }
    }
}

@Composable
private fun PhraseQr(payload: String) {
    val image = remember(payload) { qrImage(payload) }
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.clip(RoundedCornerShape(14.dp)).background(Color.White).padding(10.dp)) {
            Image(
                image,
                contentDescription = "QR code of the recovery phrase",
                modifier = Modifier.size(220.dp),
                filterQuality = FilterQuality.None,
            )
        }
    }
}

/** The phrase as a QR code, drawn here so the words never leave the phone to be drawn. */
fun qrImage(payload: String, size: Int = 512): ImageBitmap {
    val hints = mapOf(EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M, EncodeHintType.MARGIN to 1)
    val matrix = QRCodeWriter().encode(payload, BarcodeFormat.QR_CODE, size, size, hints)
    val pixels = IntArray(size * size) { i -> if (matrix[i % size, i / size]) 0xFF000000.toInt() else 0xFFFFFFFF.toInt() }
    return Bitmap.createBitmap(pixels, size, size, Bitmap.Config.ARGB_8888).asImageBitmap()
}

/** The saved file: what it is, the numbered words and a warning, as the computer writes it. */
fun phraseFileText(phrase: RevealedPhraseView): String = buildString {
    appendLine("Runova recovery phrase")
    appendLine()
    appendLine("Name: ${phrase.label}")
    appendLine()
    phrase.words.chunked(4).forEachIndexed { row, four ->
        appendLine(four.mapIndexed { col, word -> "${(row * 4 + col + 1).toString().padStart(2)}. $word" }.joinToString("   "))
    }
    appendLine()
    appendLine("Anyone who has these words can open what they protect.")
    appendLine("Keep this file where only you can reach it, or print it and delete the file.")
}

@Composable
private fun ConfirmDelete(label: String, answer: (Boolean) -> Unit) {
    val colors = RunovaTheme.colors
    Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.6f)), contentAlignment = Alignment.Center) {
        RunovaCard(Modifier.padding(24.dp).fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                RunovaText("Delete $label?", style = RunovaType.title)
                RunovaText(
                    "The phone forgets these words. Keep another copy if you still need them.",
                    color = colors.mutedForeground,
                )
                Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    RunovaButton("Keep it", onClick = { answer(false) }, Modifier.weight(1f), kind = ButtonKind.Soft)
                    RunovaButton("Delete", onClick = { answer(true) }, Modifier.weight(1f), kind = ButtonKind.Danger)
                }
            }
        }
    }
}

/** The count on the Account row. */
internal fun phraseBadge(count: Int): Pair<String, BadgeTone> =
    if (count == 0) "None" to BadgeTone.Neutral else "$count" to BadgeTone.Primary
