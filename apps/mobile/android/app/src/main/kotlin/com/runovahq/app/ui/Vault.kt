package com.runovahq.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.runovahq.app.design.ButtonKind
import com.runovahq.app.design.RunovaButton
import com.runovahq.app.design.RunovaCard
import com.runovahq.app.design.RunovaChip
import com.runovahq.app.design.RunovaEmptyState
import com.runovahq.app.design.RunovaIcon
import com.runovahq.app.design.RunovaIcons
import com.runovahq.app.design.RunovaListRow
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTextField
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaTopBar
import com.runovahq.app.design.RunovaType
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.RevealedSecretView
import uniffi.runova_ffi.VaultEntryView
import uniffi.runova_ffi.VaultLockState
import uniffi.runova_ffi.VaultSecretField

data class VaultIntents(
    val unlock: (String) -> Unit = {},
    val lock: () -> Unit = {},
    val openEntry: (String) -> Unit = {},
    val closeEntry: () -> Unit = {},
    val requestReveal: (String, Boolean) -> Unit = { _, _ -> },
    val hide: () -> Unit = {},
    val save: (String?, String, String?, String?) -> Unit = { _, _, _, _ -> },
    val remove: (String) -> Unit = {},
)

/** The open entry takes over the whole device screen. */
@Composable
fun VaultOverlay(view: AppView, intents: VaultIntents): Boolean {
    val entry = view.vault.entries.firstOrNull { it.id == view.vault.openEntry } ?: return false
    EntryScreen(entry, view.vault.revealed, intents)
    return true
}

@Composable
fun VaultTab(view: AppView, intents: VaultIntents) {
    when (view.vault.state) {
        VaultLockState.UNKNOWN -> LoadingRows()
        VaultLockState.UNINITIALIZED -> RunovaEmptyState(
            RunovaIcons.Vault,
            "No vault on this computer",
            "Set one up in Runova on this computer.",
        )
        VaultLockState.LOCKED -> UnlockForm(view.vault.unlockError, intents.unlock)
        VaultLockState.UNLOCKED -> VaultList(view.vault.entries, intents)
    }
}

@Composable
private fun UnlockForm(error: String?, onUnlock: (String) -> Unit) {
    val colors = RunovaTheme.colors
    var password by remember { mutableStateOf("") }
    Column(
        Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
    ) {
        RunovaIcon(RunovaIcons.Lock, size = 36.dp, color = colors.primary)
        RunovaText("The vault is locked", style = RunovaType.title)
        RunovaTextField(password, { password = it }, "Vault password", secure = true)
        RunovaButton(
            "Unlock",
            onClick = {
                onUnlock(password)
                password = ""
            },
            Modifier.fillMaxWidth(),
            enabled = password.isNotEmpty(),
        )
        error?.let {
            RunovaText(it, style = RunovaType.small, color = colors.destructive, align = TextAlign.Center)
        }
    }
}

@Composable
private fun VaultList(entries: List<VaultEntryView>, intents: VaultIntents) {
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.End) {
            RunovaChip("Lock", intents.lock)
        }
        if (entries.isEmpty()) {
            RunovaEmptyState(RunovaIcons.Vault, "Nothing saved yet", "Add entries in Runova on this computer.")
        } else {
            LazyColumn(contentPadding = PaddingValues(horizontal = 16.dp)) {
                items(entries, key = { it.id }) { entry ->
                    RunovaListRow(
                        title = entry.title,
                        detail = entry.subtitle,
                        icon = RunovaIcons.Lock,
                        onClick = { intents.openEntry(entry.id) },
                    )
                }
            }
        }
    }
}

@Composable
private fun EntryScreen(entry: VaultEntryView, revealed: RevealedSecretView?, intents: VaultIntents) {
    var editing by remember(entry.id) { mutableStateOf(false) }
    Column(Modifier.fillMaxSize()) {
        RunovaTopBar(entry.title, onBack = intents.closeEntry)
        if (editing) {
            EditForm(entry, intents) { editing = false }
        } else {
            EntryDetail(entry, revealed, intents) { editing = true }
        }
    }
}

@Composable
private fun EntryDetail(
    entry: VaultEntryView,
    revealed: RevealedSecretView?,
    intents: VaultIntents,
    onEdit: () -> Unit,
) {
    val colors = RunovaTheme.colors
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        entry.subtitle?.let { RunovaText(it, color = colors.mutedForeground) }
        entry.secrets.forEach { SecretRow(it, revealed?.takeIf { shown -> shown.label == it.label }, intents) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (entry.editable) RunovaButton("Edit", onClick = onEdit, Modifier.weight(1f), kind = ButtonKind.Soft)
            RunovaButton("Delete", onClick = { intents.remove(entry.id) }, Modifier.weight(1f), kind = ButtonKind.Danger)
        }
    }
}

@Composable
private fun SecretRow(secret: VaultSecretField, revealed: RevealedSecretView?, intents: VaultIntents) {
    val colors = RunovaTheme.colors
    RunovaCard(Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                RunovaText(secret.label, style = RunovaType.caption, color = colors.mutedForeground)
                RunovaText(revealed?.value ?: "••••••••", style = RunovaType.mono)
            }
            if (revealed != null) {
                RunovaChip("Hide", intents.hide)
            } else {
                RunovaChip(
                    "Reveal",
                    { intents.requestReveal(secret.key, secret.custom) },
                    Modifier.semantics { contentDescription = "Reveal ${secret.label}" },
                )
            }
        }
    }
}

@Composable
private fun EditForm(entry: VaultEntryView, intents: VaultIntents, onDone: () -> Unit) {
    var title by remember { mutableStateOf(entry.title) }
    var username by remember { mutableStateOf(entry.subtitle.orEmpty()) }
    var password by remember { mutableStateOf("") }
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        RunovaTextField(title, { title = it }, "Title")
        RunovaTextField(username, { username = it }, "Username")
        RunovaTextField(password, { password = it }, "New password (leave empty to keep it)", secure = true)
        RunovaButton(
            "Save",
            onClick = {
                intents.save(entry.id, title, username, password.ifEmpty { null })
                onDone()
            },
            Modifier.fillMaxWidth(),
            enabled = title.isNotBlank(),
        )
    }
}
