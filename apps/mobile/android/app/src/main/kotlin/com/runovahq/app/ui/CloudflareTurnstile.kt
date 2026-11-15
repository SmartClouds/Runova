package com.runovahq.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
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
import com.runovahq.app.design.RunovaCard
import com.runovahq.app.design.RunovaChip
import com.runovahq.app.design.RunovaIcons
import com.runovahq.app.design.RunovaSectionTitle
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTextField
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaType
import uniffi.runova_ffi.CloudflareDnsServerView
import uniffi.runova_ffi.CloudflareRevealedSecretView
import uniffi.runova_ffi.CloudflareWidgetFormView
import uniffi.runova_ffi.CloudflareWidgetView
import uniffi.runova_ffi.CloudflareZoneView
import uniffi.runova_ffi.WidgetDraft

/** The Turnstile tab: the domain's widgets, each with its keys and a way in for its secret. */
internal fun LazyListScope.turnstileTab(
    zone: CloudflareZoneView,
    revealed: CloudflareRevealedSecretView?,
    intents: CloudflareIntents,
) {
    val turnstile = zone.turnstile
    item(key = "turnstile-head") {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            RunovaSectionTitle("Turnstile")
            RunovaText(
                "Cloudflare's check that tells people from bots on your forms, mostly without a puzzle.",
                style = RunovaType.small,
                color = RunovaTheme.colors.mutedForeground,
            )
            RunovaChip("Add widget", intents.newWidget, icon = RunovaIcons.Add, tone = ChipTone.Primary)
        }
    }
    when {
        turnstile.loading -> item(key = "turnstile-loading") { LoadingRows() }
        turnstile.problem != null -> item(key = "turnstile-problem") { ErrorText(turnstile.problem!!) }
        turnstile.widgets.isEmpty() -> item(key = "turnstile-empty") {
            RunovaText("No widgets cover this domain yet.", style = RunovaType.small, color = RunovaTheme.colors.mutedForeground)
        }
        else -> turnstile.widgets.forEach { widget ->
            item(key = "widget/${widget.sitekey}") {
                WidgetCard(widget, revealed?.takeIf { it.sitekey == widget.sitekey }, intents)
            }
        }
    }
}

@Composable
private fun WidgetCard(widget: CloudflareWidgetView, revealed: CloudflareRevealedSecretView?, intents: CloudflareIntents) {
    val colors = RunovaTheme.colors
    val clipboard = LocalClipboardManager.current
    var snippetOpen by remember(widget.sitekey) { mutableStateOf(false) }
    RunovaCard(Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                RunovaText(widget.name, Modifier.weight(1f), RunovaType.title, maxLines = 1)
                RunovaBadge(widget.modeLabel, BadgeTone.Primary)
            }
            RunovaText(widget.domains.joinToString(", "), style = RunovaType.small, color = colors.mutedForeground)
            KeyLine("Site key", widget.sitekey) { clipboard.setText(AnnotatedString(widget.sitekey)) }
            if (revealed != null) {
                KeyLine("Secret", revealed.value) { clipboard.setText(AnnotatedString(revealed.value)) }
                RunovaChip("Hide secret", intents.hideSecret, icon = RunovaIcons.Hide)
            }
            Wrap {
                if (revealed == null) {
                    RunovaChip("Show secret", { intents.revealSecret(widget.sitekey) }, icon = RunovaIcons.Key, tone = ChipTone.Primary)
                }
                RunovaChip("Rotate secret", { intents.rotateSecret(widget.sitekey, false) }, icon = RunovaIcons.Refresh)
                RunovaChip("Edit", { intents.editWidget(widget.sitekey) }, icon = RunovaIcons.Edit)
                RunovaChip("HTML snippet", { snippetOpen = !snippetOpen }, icon = RunovaIcons.Code)
                RunovaChip("Delete", { intents.deleteWidget(widget.sitekey) }, icon = RunovaIcons.Trash, tone = ChipTone.Danger)
            }
            if (snippetOpen) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    RunovaText(
                        widget.snippet,
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .background(colors.foreground.copy(alpha = 0.05f))
                            .padding(12.dp),
                        RunovaType.mono.copy(fontSize = RunovaType.caption.fontSize),
                    )
                    RunovaChip("Copy snippet", { clipboard.setText(AnnotatedString(widget.snippet)) }, icon = RunovaIcons.Copy)
                }
            }
        }
    }
}

@Composable
private fun KeyLine(label: String, value: String, onCopy: () -> Unit) {
    val colors = RunovaTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Column(Modifier.weight(1f)) {
            RunovaText(label, style = RunovaType.caption, color = colors.mutedForeground)
            RunovaText(value, style = RunovaType.mono.copy(fontSize = RunovaType.small.fontSize), maxLines = 2)
        }
        RunovaChip("Copy", onCopy, icon = RunovaIcons.Copy)
    }
}

/** The Servers tab: which saved servers hold a DNS token for this domain. */
internal fun LazyListScope.serversTab(zone: CloudflareZoneView, intents: CloudflareIntents) {
    val servers = zone.servers
    item(key = "servers-head") {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            RunovaSectionTitle("DNS tokens on your servers")
            RunovaText(
                "A server with a DNS token for ${zone.name} can get wildcard certificates, and certificates for names behind the proxy. The token can edit this domain's DNS and nothing else.",
                style = RunovaType.small,
                color = RunovaTheme.colors.mutedForeground,
            )
        }
    }
    when {
        servers.loading -> item(key = "servers-loading") { LoadingRows() }
        servers.problem != null -> item(key = "servers-problem") { ErrorText(servers.problem!!) }
        servers.servers.isEmpty() -> item(key = "servers-empty") {
            RunovaText("No saved servers yet. Add one in Deploy on the computer.", style = RunovaType.small, color = RunovaTheme.colors.mutedForeground)
        }
        else -> servers.servers.forEach { server ->
            item(key = "server/${server.id}") { DnsServerCard(server, intents) }
        }
    }
}

@Composable
private fun DnsServerCard(server: CloudflareDnsServerView, intents: CloudflareIntents) {
    val colors = RunovaTheme.colors
    var pasting by remember(server.id) { mutableStateOf(false) }
    var token by remember(server.id) { mutableStateOf("") }
    RunovaCard(Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                RunovaText(server.name, Modifier.weight(1f), RunovaType.title, maxLines = 1)
                when {
                    server.loading -> RunovaBadge("Checking", BadgeTone.Neutral)
                    server.hasToken -> RunovaBadge("Has a token", BadgeTone.Success, dot = true)
                    else -> RunovaBadge("No token", BadgeTone.Neutral)
                }
            }
            if (!server.loading) RunovaText(server.detail, style = RunovaType.small, color = colors.mutedForeground)
            server.problem?.let { ErrorText(it) }
            if (!server.loading) {
                Wrap {
                    if (server.hasToken) {
                        RunovaChip("Remove the token", { if (!server.busy) intents.dnsTokenRemove(server.id) }, icon = RunovaIcons.Trash, tone = ChipTone.Danger)
                    } else {
                        RunovaChip("Make a token here", { if (!server.busy) intents.dnsTokenMint(server.id) }, icon = RunovaIcons.Key, tone = ChipTone.Primary)
                        RunovaChip("Paste a token", { pasting = !pasting }, icon = RunovaIcons.Copy)
                    }
                }
            }
            if (pasting && !server.hasToken) {
                RunovaTextField(token, { token = it }, "Paste the DNS token", secure = true, icon = RunovaIcons.Key, label = "DNS token for ${server.name}")
                RunovaButton(
                    "Send to ${server.name}",
                    { intents.dnsTokenPaste(server.id, token); token = ""; pasting = false },
                    Modifier.fillMaxWidth(),
                    kind = ButtonKind.Soft,
                    enabled = token.isNotBlank() && !server.busy,
                    icon = RunovaIcons.Lock,
                )
            }
        }
    }
}

private val MODE_DETAIL = mapOf(
    "managed" to "Shows a checkbox only when Cloudflare is unsure.",
    "non-interactive" to "Shows a small box that never asks for a click.",
    "invisible" to "Runs out of sight.",
)

@Composable
internal fun WidgetScreen(form: CloudflareWidgetFormView, intents: CloudflareIntents) {
    val start = form.draft
    var name by remember(form.sitekey) { mutableStateOf(start.name) }
    var domains by remember(form.sitekey) { mutableStateOf(start.domains) }
    var mode by remember(form.sitekey) { mutableStateOf(start.mode) }
    var clearance by remember(form.sitekey) { mutableStateOf(start.clearance) }
    var region by remember(form.sitekey) { mutableStateOf(start.region) }
    var offlabel by remember(form.sitekey) { mutableStateOf(start.offlabel) }
    var ephemeral by remember(form.sitekey) { mutableStateOf(start.ephemeralId) }
    FormScreen(form.title, null, intents.closeWidgetForm) {
        Field("Name", "Only you see it, to tell your widgets apart.") {
            RunovaTextField(name, { name = it }, "Contact form", label = "Widget name")
        }
        Field("Domains", "The widget works on these names and the names under them.") {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (domains.isNotEmpty()) {
                    Wrap { domains.forEach { domain -> RemovablePill(domain) { domains = domains - domain } } }
                }
                DomainEntry { text ->
                    val added = text.split(',', ';', ' ', '\n').map { it.trim().lowercase() }.filter { it.isNotEmpty() }
                    domains = (domains + added).distinct()
                }
            }
        }
        Field("Mode", MODE_DETAIL[mode]) { ChoiceChips(form.modes.map { it.value to it.label }, mode) { mode = it } }
        Field("Clearance", "A solved widget also lets the visitor past Cloudflare challenges of this level on your site.") {
            ChoiceChips(form.clearances.map { it.value to it.label }, clearance) { clearance = it }
        }
        Field("Region", "China runs the check from inside mainland China, for visitors there.") {
            ChoiceChips(form.regions.map { it.value to it.label }, region) { region = it }
        }
        SwitchRow("Hide Cloudflare branding", "Enterprise only.", RunovaIcons.Hide, offlabel, true) { offlabel = it }
        SwitchRow("Ephemeral visitor id", "Enterprise only. Spots one bot across many addresses.", RunovaIcons.Account, ephemeral, true) { ephemeral = it }
        form.problem?.let { ErrorText(it) }
        RunovaButton(
            if (form.saving) "Saving" else if (form.sitekey == null) "Add widget" else "Save",
            { intents.saveWidget(WidgetDraft(name, domains, mode, clearance, region, offlabel, ephemeral)) },
            Modifier.fillMaxWidth(),
            enabled = name.isNotBlank() && domains.isNotEmpty() && !form.saving,
            icon = RunovaIcons.Check,
        )
    }
}

@Composable
private fun RemovablePill(text: String, onRemove: () -> Unit) {
    RunovaChip(text, onRemove, icon = RunovaIcons.Close, tone = ChipTone.Primary)
}

@Composable
private fun DomainEntry(onEntries: (String) -> Unit) {
    var draft by remember { mutableStateOf("") }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        androidx.compose.foundation.layout.Box(Modifier.weight(1f)) {
            RunovaTextField(draft, { draft = it }, "shop.example.com", label = "Add a domain")
        }
        RunovaChip("Add", { if (draft.isNotBlank()) onEntries(draft); draft = "" }, icon = RunovaIcons.Add)
    }
}
